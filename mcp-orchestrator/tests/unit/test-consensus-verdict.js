/**
 * Consensus Verdict Unit Tests
 * Validates verdict parsing, consensus detection rules, verdict stripping in
 * cross-pollination prompts (anti-echo), the insufficient-models guard, and
 * tool argument validation. No Chrome required.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point state persistence at a throwaway file BEFORE the module (and its
// config) loads, so exercising start_consensus never touches the real
// consensus_state.json.
process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'consensus-test-')), 'state.json');

const {
  parseVerdict, stripVerdictLines, checkConsensusReached,
  generateConsensusPrompt, handleConsensusToolCall
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

async function assertThrows(fn, name) {
  try {
    await fn();
    assert(false, name);
  } catch {
    assert(true, name);
  }
}

async function runTests() {
  console.log('Consensus Verdict Tests\n');

  // --- parseVerdict ---
  console.log('parseVerdict:');

  assert(parseVerdict('Great answer.\nVERDICT: AGREE') === 'AGREE', 'standalone AGREE line');
  assert(parseVerdict('Differences remain.\nVERDICT: DISAGREE') === 'DISAGREE', 'standalone DISAGREE line');
  assert(parseVerdict('verdict: agree') === 'AGREE', 'case-insensitive');
  assert(parseVerdict('VERDICT: AGREE.') === 'AGREE', 'trailing period tolerated');
  assert(parseVerdict('**VERDICT: AGREE**') === 'AGREE', 'markdown bold around line tolerated');
  assert(parseVerdict('VERDICT: **AGREE**') === 'AGREE', 'markdown bold around word tolerated');
  assert(parseVerdict('VERDICT: `AGREE`') === 'AGREE', 'backticks around word tolerated');
  assert(parseVerdict('  VERDICT:  DISAGREE  ') === 'DISAGREE', 'surrounding whitespace tolerated');
  assert(parseVerdict('VERDICT: AGREE\nWait, actually:\nVERDICT: DISAGREE') === 'DISAGREE', 'last verdict line wins');
  assert(parseVerdict('VERDICT: DISAGREE\nOn reflection:\nVERDICT: AGREE') === 'AGREE', 'last verdict line wins (reversed)');

  // DISAGREE is lenient (dropping a hedged dissent could fake consensus);
  // AGREE is strict (a hedged assent is an abstention).
  assert(parseVerdict('VERDICT: DISAGREE — differences remain') === 'DISAGREE', 'hedged DISAGREE still counts as dissent');
  assert(parseVerdict('VERDICT: DISAGREE (see analysis above)') === 'DISAGREE', 'parenthetical DISAGREE still counts');
  assert(parseVerdict('VERDICT: AGREE if the others also concede') === null, 'hedged AGREE does not count');
  assert(parseVerdict('VERDICT: AGREE — mostly') === null, 'qualified AGREE does not count');

  assert(parseVerdict('CONSENSUS REACHED') === null, 'legacy trigger phrase does not match');
  assert(parseVerdict('NO CONSENSUS REACHED') === null, 'negated legacy phrase does not match');
  assert(parseVerdict('formatted exactly as "VERDICT: X" where X is AGREE or DISAGREE') === null, 'echoed instruction does not match');
  assert(parseVerdict('I would say VERDICT: AGREE here') === null, 'mid-line mention does not match');
  assert(parseVerdict('Error: Timeout waiting for response') === null, 'barrier error string does not match');
  assert(parseVerdict('') === null, 'empty string yields null');
  assert(parseVerdict(null) === null, 'null yields null');
  assert(parseVerdict(undefined) === null, 'undefined yields null');

  // --- stripVerdictLines ---
  console.log('\nstripVerdictLines:');

  assert(stripVerdictLines('My analysis.\nVERDICT: AGREE') === 'My analysis.', 'trailing verdict line removed');
  assert(stripVerdictLines('VERDICT: DISAGREE — but close\nDetails follow.') === 'Details follow.', 'hedged DISAGREE line removed');
  assert(stripVerdictLines('No verdict here at all.') === 'No verdict here at all.', 'non-verdict text untouched');
  assert(parseVerdict(stripVerdictLines('Answer.\nVERDICT: AGREE\nMore.\nVERDICT: DISAGREE')) === null, 'stripped output has no parseable verdict');

  // --- checkConsensusReached (rounds-based since PR-2) ---
  console.log('\ncheckConsensusReached:');

  const agree = 'Synthesis...\nVERDICT: AGREE';
  const disagree = 'Still differs.\nVERDICT: DISAGREE';
  const noVerdict = 'A substantive answer with no verdict line.';
  const failWait = { message: 'Timeout waiting for response', phase: 'wait' };
  // Single-round history helper: outputs (+ optional errors) as current round.
  const r1 = (outputs, errors = {}) => [{ round: 1, outputs, errors }];

  assert(checkConsensusReached(r1({ claude: agree, chatgpt: agree, gemini: agree })) === true, '3x AGREE reaches consensus');
  assert(checkConsensusReached(r1({ claude: agree, chatgpt: agree, gemini: noVerdict })) === true, '2x AGREE + abstention reaches consensus');
  assert(checkConsensusReached(r1({ claude: agree, chatgpt: agree }, { gemini: failWait })) === true, '2x AGREE + failed never-voter reaches consensus');
  assert(checkConsensusReached(r1({ claude: agree, chatgpt: agree, gemini: disagree })) === false, 'any DISAGREE blocks consensus');
  assert(checkConsensusReached(r1({ claude: agree, chatgpt: agree, gemini: 'VERDICT: DISAGREE — but close' })) === false, 'hedged DISAGREE blocks consensus');
  assert(checkConsensusReached(r1({ claude: agree, chatgpt: noVerdict, gemini: noVerdict })) === false, 'single AGREE is not consensus');
  assert(checkConsensusReached(r1({ claude: noVerdict, chatgpt: noVerdict, gemini: noVerdict })) === false, 'no verdicts is not consensus');
  assert(checkConsensusReached(r1({}, { claude: failWait, chatgpt: failWait, gemini: failWait })) === false, 'all-failed round is not consensus');
  assert(checkConsensusReached(r1({})) === false, 'empty outputs is not consensus');
  assert(checkConsensusReached([]) === false, 'empty rounds is not consensus');
  assert(checkConsensusReached(undefined) === false, 'missing rounds is not consensus');

  // Regressions for the substring-detection bug
  assert(checkConsensusReached(r1({ claude: 'CONSENSUS REACHED, final output: ...', chatgpt: noVerdict, gemini: noVerdict })) === false, 'legacy phrase echo no longer terminates');
  assert(checkConsensusReached(r1({ claude: 'NO CONSENSUS REACHED yet', chatgpt: agree, gemini: agree })) === true, 'denial prose does not block explicit AGREE votes');

  // --- generateConsensusPrompt ---
  console.log('\ngenerateConsensusPrompt:');

  const round1 = [{
    round: 1,
    outputs: { claude: 'Answer A', chatgpt: 'Answer B', gemini: 'Answer C' }
  }];
  const prompt2 = generateConsensusPrompt('Original question', round1, 'claude');

  assert(parseVerdict(prompt2) === null, 'round-2 prompt contains no parseable verdict (anti-echo)');
  assert(prompt2.includes('VERDICT'), 'prompt instructs a verdict line');
  assert(!prompt2.includes('Answer A'), 'excluded model’s own response is filtered out');
  assert(prompt2.includes('Answer B') && prompt2.includes('Answer C'), 'other models’ responses are included');
  assert(!prompt2.toUpperCase().includes('CONSENSUS REACHED'), 'legacy trigger phrase removed from prompt');

  // Round-3 prompts are built from verdict-BEARING round-2 outputs — the
  // leak path four reviewers flagged.
  const round2 = [...round1, {
    round: 2,
    outputs: {
      claude: 'Synthesis A.\nVERDICT: DISAGREE',
      chatgpt: 'Synthesis B.\nVERDICT: AGREE',
      gemini: 'Synthesis C.\nVERDICT: AGREE'
    }
  }];
  const prompt3 = generateConsensusPrompt('Original question', round2, 'claude');

  assert(parseVerdict(prompt3) === null, 'round-3 prompt strips peers’ verdict lines (anti-echo under real data)');
  assert(prompt3.includes('Synthesis B.') && prompt3.includes('Synthesis C.'), 'peer content survives verdict stripping');

  // --- argument validation ---
  console.log('\nargument validation:');

  await assertThrows(() => handleConsensusToolCall('start_consensus', {}, null), 'start_consensus without prompt throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', undefined, null), 'start_consensus without args throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: '   ' }, null), 'start_consensus with blank prompt throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 42 }, null), 'start_consensus with non-string prompt throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', max_rounds: 1 }, null), 'max_rounds 1 throws (cannot iterate)');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', max_rounds: 0 }, null), 'max_rounds 0 throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', max_rounds: 99 }, null), 'max_rounds 99 throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', max_rounds: 2.5 }, null), 'fractional max_rounds throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', max_rounds: 'many' }, null), 'non-numeric string max_rounds throws');
  await assertThrows(() => handleConsensusToolCall('send_single_round', {}, null), 'send_single_round without prompt throws');
  await assertThrows(() => handleConsensusToolCall('send_single_round', { prompt: '' }, null), 'send_single_round with empty prompt throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', response_timeout_ms: 500 }, null), 'response_timeout_ms below 1s throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', response_timeout_ms: 10800000 }, null), 'response_timeout_ms above 2h throws');
  await assertThrows(() => handleConsensusToolCall('start_consensus', { prompt: 'x', response_timeout_ms: 'fast' }, null), 'non-numeric response_timeout_ms throws');
  await assertThrows(() => handleConsensusToolCall('send_single_round', { prompt: 'x', response_timeout_ms: 0 }, null), 'send_single_round validates response_timeout_ms too');

  // Numeric strings are coerced (MCP clients often emit numbers as strings).
  // The mock's connect() rejects, so the fire-and-forget workflow dies
  // immediately after writing to the throwaway state file.
  const failingBS = { connect: async () => { throw new Error('no chrome in unit test'); } };
  const coerced = await handleConsensusToolCall('start_consensus', { prompt: 'q', max_rounds: '3' }, failingBS);
  assert(coerced.content[0].text.includes('Max rounds: 3'), 'numeric-string max_rounds is coerced and accepted');
  await new Promise(r => setTimeout(r, 50)); // let the rejected workflow settle
  const coercedTimeout = await handleConsensusToolCall('start_consensus', { prompt: 'q', max_rounds: '3', response_timeout_ms: '30000' }, failingBS);
  assert(coercedTimeout.content[0].text.includes('Consensus workflow started'), 'numeric-string response_timeout_ms is coerced and accepted');
  await new Promise(r => setTimeout(r, 50)); // let the rejected workflow settle

  // --- insufficient-models guard ---
  console.log('\ninsufficient-models guard:');

  const oneTabBS = { connect: async () => {}, getActiveModels: () => ['claude'] };
  await handleConsensusToolCall('start_consensus', { prompt: 'q', max_rounds: 3 }, oneTabBS);
  await new Promise(r => setTimeout(r, 50)); // let the background workflow hit the guard
  const status = await handleConsensusToolCall('get_consensus_status', {}, oneTabBS);
  assert(status.content[0].text.includes('insufficient_models'), 'single-tab run aborts with insufficient_models instead of burning rounds');

  // --- summary ---
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
