/**
 * Error Quarantine Contract Tests — Stage 3 (PR-2) SCAFFOLD
 *
 * Written test-first ahead of the PR-2 implementation; now registered in
 * tests/run-all.js as part of the standard unit suite.
 *
 * Contract under test (see CLAUDE.md "Known open bugs" #2 and the plan spec):
 *   1. ConsensusBarrier.getResults() → { outputs, errors, timing } where
 *      outputs holds ONLY successful models' text (never `Error: ...` strings)
 *      and each failed model appears ONLY in errors as { message, phase }.
 *      phase is treated as an opaque non-empty string ('send'/'wait'/'extract'
 *      expected but not pinned).
 *   2. ConsensusBarrier simplified: waitForAll() REMOVED; markComplete/
 *      markFailed first-mark-wins dedup, isComplete(), getPendingModels(),
 *      and getStatus() KEPT with current semantics (pinned below).
 *   3. checkConsensusReached(rounds) — rounds-aware dissent carry-forward:
 *      takes the persisted per-round results array; a model whose LAST CAST
 *      vote was DISAGREE and which FAILED in the current round still blocks
 *      consensus. Failed never-voters are pure abstentions.
 *   4. generateConsensusPrompt never embeds failed peers' error text; any
 *      "did not respond" note must be non-parseable.
 *
 * Resolved design decisions (PR-2):
 *   - markFailed(model, message, phase) — phase is a third positional arg.
 *   - Persisted rounds carry an `errors` map mirroring getResults().errors.
 *   - checkConsensusReached takes the rounds array; call site updated.
 *   - timing includes failed models too (feeds latency stats) — unpinned here.
 *   - A model that RESPONDS but abstains after a prior DISAGREE is a plain
 *     abstention: dissent carries across FAILURES only (a live response
 *     replaces the model's stance; only silence preserves it).
 *
 * No Chrome, no network, no MCP server spawn — mocks/plain data only.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point state persistence at a throwaway file BEFORE the module (and its
// config) loads, so importing consensus.js never touches the real
// consensus_state.json.
process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'quarantine-test-')), 'state.json');

const { ConsensusBarrier } = await import('../../utils/barrier.js');
const {
  parseVerdict, checkConsensusReached, generateConsensusPrompt
} = await import('../../tools/consensus.js');

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

// Dedup tests must pass BOTH before and after Stage 3, so they tolerate the
// current raw-string error shape and the target { message, phase } shape.
const msgOf = (e) => (typeof e === 'string' ? e : e && e.message);

async function runTests() {
  console.log('Error Quarantine Contract Tests (Stage 3 scaffold — failures expected pre-Stage-3)\n');

  // --- barrier dedup + status: CURRENT semantics, KEPT after Stage 3 ---
  console.log('barrier dedup/status (kept semantics — should pass already):');

  const d1 = new ConsensusBarrier(['claude', 'chatgpt']);
  d1.markComplete('claude', 'first output');
  d1.markComplete('claude', 'second output');
  assert(d1.getStatus().completed === 1, 'second markComplete for same model is ignored (count)');
  assert(d1.getResults().outputs.claude === 'first output', 'second markComplete for same model is ignored (first output wins)');

  const d2 = new ConsensusBarrier(['claude', 'chatgpt']);
  d2.markComplete('claude', 'ok');
  d2.markFailed('claude', 'late failure', 'wait');
  assert(d2.getStatus().completed === 1 && d2.getStatus().failed === 0, 'markFailed after markComplete is ignored (counts)');
  assert(!('claude' in d2.getResults().errors), 'markFailed after markComplete leaves model out of errors');
  assert(d2.getResults().outputs.claude === 'ok', 'markFailed after markComplete keeps successful output');

  const d3 = new ConsensusBarrier(['claude', 'chatgpt']);
  d3.markFailed('claude', 'early failure', 'send');
  d3.markComplete('claude', 'late success');
  assert(d3.getStatus().failed === 1 && d3.getStatus().completed === 0, 'markComplete after markFailed is ignored (counts)');
  assert((msgOf(d3.getResults().errors.claude) || '').includes('early failure'), 'markComplete after markFailed keeps first error');

  const d4 = new ConsensusBarrier(['claude', 'chatgpt']);
  d4.markFailed('claude', 'first error', 'send');
  d4.markFailed('claude', 'second error', 'wait');
  assert(d4.getStatus().failed === 1, 'second markFailed for same model is ignored (count)');
  assert((msgOf(d4.getResults().errors.claude) || '').includes('first error'), 'second markFailed for same model is ignored (first error wins)');

  const d5 = new ConsensusBarrier(['claude', 'chatgpt', 'gemini']);
  assert(d5.isComplete() === false, 'isComplete false before any marks');
  d5.markComplete('claude', 'a');
  d5.markFailed('chatgpt', 'boom', 'send');
  assert(d5.isComplete() === false, 'isComplete false while a model is pending');
  const pending = d5.getPendingModels();
  assert(pending.length === 1 && pending[0] === 'gemini', 'getPendingModels reports the unmarked model');
  d5.markComplete('gemini', 'c');
  assert(d5.isComplete() === true, 'isComplete true once every model is marked (mixed complete/failed)');
  const st = d5.getStatus();
  assert(st.completed === 2 && st.failed === 1 && st.pending === 0 && st.total === 3, 'getStatus counts completed/failed/pending/total');

  // --- barrier simplification: waitForAll removed ---
  console.log('\nwaitForAll removal (Stage 3 contract):');

  const b0 = new ConsensusBarrier(['claude', 'chatgpt']);
  assert(typeof b0.waitForAll === 'undefined', 'waitForAll no longer exists on ConsensusBarrier (Promise.all is the real barrier)');

  // --- getResults error quarantine ---
  console.log('\ngetResults quarantine (Stage 3 contract):');

  const b1 = new ConsensusBarrier(['claude', 'chatgpt', 'gemini']);
  b1.markComplete('claude', 'Claude answer text');
  b1.markFailed('chatgpt', 'chatgpt: no input element found', 'send');
  b1.markComplete('gemini', 'Gemini answer text');
  const res = b1.getResults();

  assert(Object.keys(res.outputs).sort().join(',') === 'claude,gemini', 'outputs contains exactly the successful models');
  assert(!('chatgpt' in res.outputs), 'failed model does not appear in outputs at all');
  assert(!Object.values(res.outputs).some(v => typeof v === 'string' && v.includes('Error:')), 'no output value ever contains an Error: string');
  assert(res.outputs.claude === 'Claude answer text', 'successful output text preserved verbatim');
  assert(res.errors.chatgpt !== undefined && typeof res.errors.chatgpt === 'object', 'failed model appears in errors as an object');
  assert((res.errors.chatgpt?.message || '').includes('no input element found'), 'errors[model].message carries the failure text');
  assert(typeof res.errors.chatgpt?.phase === 'string' && res.errors.chatgpt.phase.length > 0, 'errors[model].phase identifies where it died (opaque non-empty string)');
  assert(!('claude' in res.errors) && !('gemini' in res.errors), 'successful models do not appear in errors');
  assert(typeof res.timing.claude === 'number' && typeof res.timing.gemini === 'number', 'timing recorded for successful models');

  // --- checkConsensusReached(rounds): dissent carry-forward ---
  console.log('\ncheckConsensusReached(rounds) dissent carry-forward (Stage 3 contract):');

  const agree = 'Synthesis...\nVERDICT: AGREE';
  const disagree = 'Still differs.\nVERDICT: DISAGREE';
  const noVerdict = 'A substantive answer with no verdict line.';
  const plainRound1 = { round: 1, outputs: { claude: 'A1', chatgpt: 'B1', gemini: 'C1' }, errors: {} };
  const failWait = { message: 'Timeout waiting for response', phase: 'wait' };

  // (a) dissent carried forward: X's last cast vote was DISAGREE, then X fails
  const roundsDissentThenFail = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: agree, gemini: disagree }, errors: {} },
    { round: 3, outputs: { claude: agree, chatgpt: agree }, errors: { gemini: failWait } }
  ];
  assert(checkConsensusReached(roundsDissentThenFail) === false, 'a. failed model whose last cast vote was DISAGREE still blocks consensus');

  // (b) last cast vote was AGREE: failure does not block
  const roundsAgreeThenFail = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: disagree, gemini: agree }, errors: {} },
    { round: 3, outputs: { claude: agree, chatgpt: agree }, errors: { gemini: failWait } }
  ];
  assert(checkConsensusReached(roundsAgreeThenFail) === true, 'b. failed model whose last cast vote was AGREE does not block (2 AGREE + 0 DISAGREE)');

  // (c) never voted, then fails: pure abstention
  const roundsNeverVotedThenFail = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: disagree, gemini: noVerdict }, errors: {} },
    { round: 3, outputs: { claude: agree, chatgpt: agree }, errors: { gemini: failWait } }
  ];
  assert(checkConsensusReached(roundsNeverVotedThenFail) === true, 'c. failed model that never cast a vote is a pure abstention');

  // (d) regression of current semantics: clean current round decides
  const roundsCleanConsensus = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: agree, gemini: agree }, errors: {} }
  ];
  assert(checkConsensusReached(roundsCleanConsensus) === true, 'd. 3x unhedged AGREE, no failures → consensus');

  const roundsTwoAgreeAbstain = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: agree, gemini: noVerdict }, errors: {} }
  ];
  assert(checkConsensusReached(roundsTwoAgreeAbstain) === true, 'd. 2x AGREE + responding abstainer → consensus');

  // (e) current-round explicit DISAGREE blocks regardless of history
  const roundsHistoryAgreeNowDisagree = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: agree, gemini: agree }, errors: {} },
    { round: 3, outputs: { claude: agree, chatgpt: agree, gemini: disagree }, errors: {} }
  ];
  assert(checkConsensusReached(roundsHistoryAgreeNowDisagree) === false, 'e. current-round DISAGREE blocks even after prior AGREEs');

  // (f) prior dissenter converts: current unhedged AGREE is its last cast vote
  const roundsDissenterConverts = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: agree, gemini: disagree }, errors: {} },
    { round: 3, outputs: { claude: agree, chatgpt: agree, gemini: agree }, errors: {} }
  ];
  assert(checkConsensusReached(roundsDissenterConverts) === true, 'f. dissenter converting to unhedged AGREE unblocks consensus');

  // fewer than 2 current AGREE never passes, carried votes notwithstanding
  const roundsSingleAgree = [
    plainRound1,
    { round: 2, outputs: { claude: agree, chatgpt: noVerdict }, errors: { gemini: failWait } }
  ];
  assert(checkConsensusReached(roundsSingleAgree) === false, 'single AGREE among responders is not consensus');

  // defensive shapes
  assert(checkConsensusReached([]) === false, 'empty rounds array is not consensus');
  assert(checkConsensusReached(undefined) === false, 'missing rounds is not consensus');

  // --- generateConsensusPrompt: failed peers' errors never leak ---
  console.log('\ngenerateConsensusPrompt error hygiene (Stage 3 contract):');

  const failSend = { message: 'claude: no input element found', phase: 'send' };
  const roundsWithError = [
    plainRound1,
    {
      round: 2,
      outputs: {
        chatgpt: 'Synthesis B.\nVERDICT: AGREE',
        gemini: 'Synthesis C.\nVERDICT: AGREE'
      },
      errors: { claude: failSend }
    }
  ];

  const pForChatgpt = generateConsensusPrompt('Original question', roundsWithError, 'chatgpt');
  assert(!pForChatgpt.includes('Error:'), 'prompt never contains the substring "Error:"');
  assert(!pForChatgpt.includes(failSend.message), 'failed peer error text never appears in prompt');
  assert(parseVerdict(pForChatgpt) === null, 'prompt (incl. any did-not-respond note) is not verdict-parseable');
  assert(pForChatgpt.includes('Synthesis C.'), 'surviving peer content still included');
  assert(!pForChatgpt.includes('Synthesis B.'), 'excluded model own response still filtered out');
  assert(!pForChatgpt.includes('=== CLAUDE ==='), 'failed peer gets NO response block (nothing to dissent against)');
  assert(pForChatgpt.includes('RESPONSES FROM 1 OTHER AI MODEL'), 'failed peers are not counted as responses');

  // The failed model itself gets the next prompt too — both peers included, no error text
  const pForClaude = generateConsensusPrompt('Original question', roundsWithError, 'claude');
  assert(pForClaude.includes('Synthesis B.') && pForClaude.includes('Synthesis C.'), 'failed model receives both peers responses next round');
  assert(!pForClaude.includes('Error:') && !pForClaude.includes(failSend.message), 'failed model own error not echoed back to it');

  // End-to-end flow: barrier → getResults → round → prompt (the live bug path:
  // today getResults injects "Error: ..." into outputs and it lands verbatim
  // in the cross-pollination prompt as if it were an answer)
  const bFlow = new ConsensusBarrier(['claude', 'chatgpt', 'gemini']);
  bFlow.markComplete('claude', 'Deep analysis from claude.\nVERDICT: AGREE');
  bFlow.markComplete('chatgpt', 'Deep analysis from chatgpt.\nVERDICT: AGREE');
  bFlow.markFailed('gemini', 'Timeout waiting for response', 'wait');
  const flowResults = bFlow.getResults();
  const flowRounds = [
    plainRound1,
    { round: 2, outputs: flowResults.outputs, errors: flowResults.errors, timing: flowResults.timing }
  ];

  const pFlow = generateConsensusPrompt('Original question', flowRounds, 'claude');
  assert(!pFlow.includes('Error:'), 'flow: barrier failure never surfaces as "Error:" in the next prompt');
  assert(!pFlow.includes('Timeout waiting for response'), 'flow: timeout message never cross-pollinated as an answer');
  assert(parseVerdict(pFlow) === null, 'flow: prompt remains non-parseable (anti-echo holds with failures)');
  assert(pFlow.includes('Deep analysis from chatgpt.'), 'flow: successful peer content survives');
  assert(!pFlow.includes('=== GEMINI ==='), 'flow: failed model absent from response blocks');
  assert(checkConsensusReached(flowRounds) === true, 'flow: 2 AGREE + never-voted failure → consensus (abstention)');

  // --- summary ---
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
