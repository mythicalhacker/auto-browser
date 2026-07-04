import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * State Guard Contract Tests — Stage 4 (PR-4) SCAFFOLD
 *
 * TEST-FIRST: encodes the POST-Stage-4 contract; failures are expected until
 * the PR-4 implementation lands. Registration in tests/run-all.js happens in
 * the Stage 4 commit.
 *
 * Contract under test (plan Stage 4):
 *   1. Atomic saves: state is written via temp file + rename — no partially
 *      written consensus_state.json can ever exist; no .tmp litter remains.
 *   2. Guarded loadState: a corrupt state file is quarantined to
 *      <name>.corrupt-<ts> (stderr log) and the server starts fresh instead
 *      of crashing at boot.
 *   3. Boot-time recovery: a stale `active: true` from a crashed process
 *      becomes status "interrupted", active false, persisted.
 *   4. Single-flight: start_consensus while a run is active in-process
 *      throws (server surfaces isError); the slot frees when the run ends —
 *      normally, via the insufficient_models early return, or via .catch.
 *   5. .catch resets active: a workflow that dies (e.g. connect failure)
 *      leaves active:false, status "error: ...".
 *   6. No mid-run identity swap: status/results/last-round handlers must NOT
 *      reload state from disk while a run is active in-process — an external
 *      write to the file must not surface until the run ends.
 *
 * No Chrome, no network — mock browserService only.
 */

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';

const STATE_DIR = mkdtempSync(join(tmpdir(), 'state-guard-test-'));
const STATE_FILE = join(STATE_DIR, 'state.json');
process.env.STATE_FILE = STATE_FILE;

// Corrupt file must be on disk BEFORE the module loads: boot-time loadState
// is the first guard under test.
writeFileSync(STATE_FILE, '{"active": true, "status": "runni');

const { handleConsensusToolCall, initConsensusState } = await import('../../tools/consensus.js');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

async function assertThrows(fn, name) {
  try {
    await fn();
    assert(false, name);
  } catch {
    assert(true, name);
  }
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const quarantineFiles = () =>
  readdirSync(dirname(STATE_FILE)).filter((f) => f.startsWith(`${basename(STATE_FILE)}.corrupt-`));
const statusText = async () =>
  (await handleConsensusToolCall('get_consensus_status', {}, null)).content[0].text;

async function runTests() {
  console.log('State Guard Contract Tests (Stage 4 scaffold)\n');

  // --- corrupt-file quarantine at boot ---
  console.log('corrupt-file quarantine:');

  let bootError = null;
  try {
    initConsensusState();
  } catch (e) {
    bootError = e;
  }
  assert(bootError === null, 'boot with corrupt state file does not throw');
  assert(quarantineFiles().length === 1, 'corrupt file quarantined to <name>.corrupt-<ts>');
  assert((await statusText()).includes('idle'), 'in-memory state falls back to fresh idle default');
  assert(!existsSync(`${STATE_FILE}.tmp`), 'no .tmp litter after boot');

  // --- boot-time interrupted recovery ---
  console.log('\nboot-time interrupted recovery:');

  writeFileSync(STATE_FILE, JSON.stringify({
    active: true, originalPrompt: 'crashed run', currentRound: 1, maxRounds: 5,
    rounds: [], finalConsensus: null, status: 'round_2_sending',
  }));
  initConsensusState();
  assert((await statusText()).includes('interrupted'), 'stale active:true becomes status interrupted');
  const persisted = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  assert(persisted.active === false, 'recovery is persisted with active:false');
  assert(persisted.status === 'interrupted', 'recovery is persisted with status interrupted');

  // --- single-flight + mid-run no-reload ---
  console.log('\nsingle-flight + mid-run isolation:');

  let releaseConnect;
  const connectGate = new Promise((r) => { releaseConnect = r; });
  const blockingBS = {
    connect: async () => { await connectGate; },
    getActiveModels: () => ['claude'], // insufficient -> clean early return
  };

  const first = await handleConsensusToolCall(
    'start_consensus', { prompt: 'run one', max_rounds: 3 }, blockingBS);
  assert(first.content[0].text.includes('started'), 'first start_consensus accepted');

  await assertThrows(
    () => handleConsensusToolCall('start_consensus', { prompt: 'run two', max_rounds: 3 }, blockingBS),
    'second start_consensus while first is active throws (single-flight)');

  // External write while the run is in flight must not surface (no loadState
  // identity swap mid-run).
  writeFileSync(STATE_FILE, JSON.stringify({
    active: false, status: 'DECOY_FROM_DISK', rounds: [], currentRound: 0, maxRounds: 5,
  }));
  assert(!(await statusText()).includes('DECOY_FROM_DISK'), 'status handler does not reload from disk mid-run');

  releaseConnect();
  await settle();
  assert((await statusText()).includes('insufficient_models'), 'first run completed via insufficient_models');

  const third = await handleConsensusToolCall(
    'start_consensus', { prompt: 'run three', max_rounds: 3 }, blockingBS);
  assert(third.content[0].text.includes('started'), 'slot freed after completion — next start accepted');
  await settle();

  // --- .catch resets active ---
  console.log('\ncatch-path reset:');

  const failingBS = { connect: async () => { throw new Error('boom in unit test'); } };
  const failStart = await handleConsensusToolCall(
    'start_consensus', { prompt: 'doomed run', max_rounds: 3 }, failingBS);
  assert(failStart.content[0].text.includes('started'), 'doomed run accepted while slot is free');
  await settle();
  const afterCrash = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  assert(afterCrash.active === false, 'crashed workflow leaves active:false on disk');
  assert(afterCrash.status.startsWith('error:'), 'crashed workflow records error status');
  const fourth = await handleConsensusToolCall(
    'start_consensus', { prompt: 'after crash', max_rounds: 3 }, blockingBS);
  assert(fourth.content[0].text.includes('started'), 'slot freed after crash — next start accepted');
  releaseConnect();
  await settle();

  // --- atomic writes ---
  console.log('\natomic writes:');

  assert(!existsSync(`${STATE_FILE}.tmp`), 'no .tmp litter after all operations');
  assert(quarantineFiles().length === 1, 'no additional quarantine files appeared (valid saves stayed valid)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
