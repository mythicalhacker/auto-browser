/**
 * Stats CLI Unit Tests
 * Validates read-only rendering for quota, latency, corrupt-input, rollover,
 * machine-readable JSON, and batch artifact status fixtures.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'scripts', 'stats.js');
const TMP = join(tmpdir(), `ab-stats-cli-${process.pid}`);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

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

function assertIncludes(text, needle, name) {
  assert(text.includes(needle), `${name} (contains ${JSON.stringify(needle)})`);
}

function localDay(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fixtureHome(name) {
  const home = join(TMP, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return home;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function envFor(home) {
  const env = { ...process.env, AUTO_BROWSER_HOME: home };
  delete env.QUOTA_FILE;
  delete env.RESEARCH_HOME;
  delete env.STATE_FILE;
  delete env.TIMING_STATS_FILE;
  return env;
}

function runStats(home, args = []) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: envFor(home),
    encoding: 'utf8',
  });
}

function parseStdoutJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    console.error(result.stdout);
    throw error;
  }
}

console.log('Stats CLI Tests\n');

console.log('fresh install:');
{
  const home = fixtureHome('fresh');
  const result = runStats(home);
  assert(result.status === 0, 'missing files exit 0');
  assertIncludes(result.stdout, 'Deep Research Quotas', 'renders quota table');
  assertIncludes(result.stdout, 'Latency Stats', 'renders latency table');
  assertIncludes(result.stdout, 'WARNING', 'missing files render warning rows');
  assertIncludes(result.stdout, 'quotas missing:', 'missing quota warning is explicit');
  assertIncludes(result.stdout, 'timing stats missing:', 'missing latency warning is explicit');
}

console.log('\nhealthy fixtures:');
{
  const home = fixtureHome('healthy');
  const now = Date.now();
  const today = localDay(now);
  writeJson(join(home, 'quotas.json'), {
    providers: {
      gemini: { day: today, used: 3, cooldownUntil: null, cooldownReason: null },
      claude: { day: today, used: 1, cooldownUntil: now + 60 * 60 * 1000, cooldownReason: 'plan limit banner' },
    },
  });
  writeJson(join(home, 'timing-stats.json'), {
    claude: { samples: [100, 200, 400, 800], timeouts: 2 },
    chatgpt: { samples: [], timeouts: 1 },
  });

  const result = runStats(home);
  assert(result.status === 0, 'healthy fixtures exit 0');
  assertIncludes(result.stdout, 'gemini', 'quota table includes gemini');
  assertIncludes(result.stdout, '3', 'quota table includes used count');
  assertIncludes(result.stdout, '5', 'quota table includes default gemini cap');
  assertIncludes(result.stdout, 'plan limit banner', 'quota table includes cooldown reason');
  assertIncludes(result.stdout, 'claude', 'latency table includes claude');
  assertIncludes(result.stdout, '400', 'latency p50 follows product percentile math');
  assertIncludes(result.stdout, '800', 'latency p95/max rendered');

  const jsonResult = runStats(home, ['--json']);
  assert(jsonResult.status === 0, '--json exits 0');
  const data = parseStdoutJson(jsonResult);
  const gemini = data.quotas.rows.find((row) => row.provider === 'gemini');
  const claude = data.latency.rows.find((row) => row.model === 'claude');
  assert(gemini.used === 3 && gemini.cap === 5 && gemini.remaining === 2, '--json exposes quota math');
  assert(claude.count === 4 && claude.p50 === 400 && claude.p95 === 800 && claude.timeouts === 2,
    '--json exposes latency summary');
}

console.log('\nempty fixtures:');
{
  const home = fixtureHome('empty');
  writeJson(join(home, 'quotas.json'), { providers: {} });
  writeJson(join(home, 'timing-stats.json'), {});
  const result = runStats(home);
  assert(result.status === 0, 'empty fixture files exit 0');
  assertIncludes(result.stdout, 'No quota providers recorded.', 'empty quotas render an info row');
  assertIncludes(result.stdout, 'No latency samples recorded.', 'empty latency renders an info row');
}

console.log('\ncorrupt fixtures:');
{
  const home = fixtureHome('corrupt');
  writeText(join(home, 'quotas.json'), '{"providers":');
  writeText(join(home, 'timing-stats.json'), '{"claude":');
  const result = runStats(home);
  assert(result.status === 0, 'corrupt inputs warn instead of throwing');
  assertIncludes(result.stdout, 'quotas could not be parsed:', 'corrupt quotas warning rendered');
  assertIncludes(result.stdout, 'timing stats could not be parsed:', 'corrupt latency warning rendered');

  const jsonResult = runStats(home, ['--json']);
  const data = parseStdoutJson(jsonResult);
  assert(data.quotas.warnings.length === 1 && data.latency.warnings.length === 1,
    'corrupt warnings are machine-readable');
}

console.log('\nday rollover:');
{
  const home = fixtureHome('rollover');
  const today = localDay(Date.now());
  const yesterday = localDay(Date.now() - 24 * 60 * 60 * 1000);
  writeJson(join(home, 'quotas.json'), {
    providers: {
      gemini: { day: yesterday, used: 5, cooldownUntil: null, cooldownReason: null },
    },
  });
  writeJson(join(home, 'timing-stats.json'), {});

  const result = runStats(home, ['--json']);
  const data = parseStdoutJson(result);
  const row = data.quotas.rows.find((item) => item.provider === 'gemini');
  assert(row.day === today && row.used === 0 && row.storedUsed === 5,
    'stale quota day is rendered as rolled over without writing the file');
  assert(row.note.includes(`rolled over from ${yesterday}`), 'rollover note preserves stored day');
}

console.log('\nbatch status:');
{
  const home = fixtureHome('batch');
  const batch = 'batch-2026-07-05-a1b2c3';
  const researchHome = join(home, 'research');
  const artifact = join(researchHome, batch, 'task-a', 'claude.md');
  writeText(artifact, '# report\n\nBody');
  writeJson(artifact.replace(/\.md$/, '.meta.json'), {
    task: 'task-a',
    batch,
    provider: 'claude',
    prompt: 'Investigate Node.js LTS cadence.',
    project: 'Runtime',
    chars: 900,
    chatUrl: 'https://claude.ai/chat/example',
    durationMs: 1500,
  });
  writeJson(join(researchHome, 'queue.json'), {
    order: ['task-a'],
    tasks: {
      'task-a': {
        id: 'task-a',
        batch,
        prompt: 'Investigate Node.js LTS cadence.',
        project: 'Runtime',
        perProvider: {
          claude: {
            status: 'complete',
            attempts: 0,
            spent: true,
            chatUrl: 'https://claude.ai/chat/example',
            artifactPath: artifact,
            error: null,
          },
          chatgpt: {
            status: 'failed',
            attempts: 2,
            spent: true,
            chatUrl: null,
            artifactPath: null,
            error: 'dr_timeout',
          },
        },
      },
    },
  });
  writeJson(join(home, 'quotas.json'), { providers: {} });
  writeJson(join(home, 'timing-stats.json'), {});

  const result = runStats(home, ['--batch', batch]);
  assert(result.status === 0, 'batch status exits 0');
  assertIncludes(result.stdout, `Batch Status: ${batch}`, 'batch section rendered');
  assertIncludes(result.stdout, 'task-a', 'batch table includes task id');
  assertIncludes(result.stdout, 'complete', 'batch table includes complete provider state');
  assertIncludes(result.stdout, 'failed', 'batch table includes failed provider state');
  assertIncludes(result.stdout, 'dr_timeout', 'batch table includes provider error');

  const jsonResult = runStats(home, ['--batch', join(researchHome, batch), '--json']);
  const data = parseStdoutJson(jsonResult);
  assert(data.batch.rows.some((row) => row.provider === 'claude' && row.artifactExists && row.metaOk),
    '--batch path JSON reports artifact and meta status');
  assert(data.batch.rows.some((row) => row.provider === 'chatgpt' && row.status === 'failed'),
    '--batch JSON reports queue-only provider rows');
}

assert(existsSync(CLI), 'stats CLI file exists');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
