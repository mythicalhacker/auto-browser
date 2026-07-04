import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * Send-Verification Tests — PR-9 contract (receipt + release).
 * A silent send was observed live (2026-07-04): insertText landed in a stale
 * editor, the submit click was a no-op, and waitForComplete later "passed" on
 * stale DOM. sendToModel now verifies in two phases:
 *   RECEIPT — the prompt tail must APPEAR in the composer before submit (an
 *   empty composer means the INSERT missed; one guarded re-insert, refused
 *   when a research pill sits in the composer);
 *   RELEASE — after submit the tail must leave the composer; a stuck tail
 *   means the submit never fired → retry the SUBMIT only (never re-insert).
 * All matching is whitespace-normalized (block editors re-render newlines).
 */
import { join } from 'path';
import { tmpdir } from 'os';

process.env.STATE_FILE = join(tmpdir(), `send-verify-state-${process.pid}.json`);
process.env.SEND_VERIFY_MS = '200'; // fast windows for the failure paths
process.env.SEND_RECEIPT_MS = '150';

const { sendToModel, runConsensusRound } = await import('../../tools/consensus.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

const SEL = {
  claude: {
    input: '.ProseMirror',
    submit: 'button[aria-label="Send message"]',
    pill: 'button[aria-label="Research mode"][aria-pressed="true"]', // real registry indicator
  },
  chatgpt: { input: '#prompt-textarea', submit: 'button[aria-label="Send prompt"]', pill: 'never-matches' },
};

/**
 * Composer-accurate mock page. behavior:
 *  - 'clears'              insert lands, submit empties the composer
 *  - 'submit-noop-once'    insert lands, FIRST submit is a no-op, second registers
 *  - 'submit-never'        insert lands, submit never registers
 *  - 'insert-misses-once'  FIRST insert lands nowhere, second lands; submit ok
 *  - 'insert-never'        insert never lands (composer stays empty)
 *  - 'vanishes'            input element disappears after the first insert
 * opts.pill: a research pill sits in the composer (indicator selector matches)
 * Block-editor fidelity: innerText re-renders '\n' as '\n\n'.
 */
function makeSendMock(behavior, { answer = 'mock answer', model = 'claude', pill = false } = {}) {
  let composer = '';
  let submits = 0;
  let inserts = 0;
  let totalInserted = '';
  let registered = false;
  let pillPresent = pill;
  const presses = [];
  const makeEl = (text) => ({
    evaluate: async () => Math.random().toString(36),
    innerText: async () => text,
    isVisible: async () => false,
    click: async () => {},
  });
  const inputEl = {
    ...makeEl(''),
    // block editors read newlines back doubled — verification must normalize
    innerText: async () => composer.replace(/\n/g, '\n\n'),
  };
  const submitEl = {
    click: async () => {
      submits++;
      const fires = behavior === 'clears' || behavior === 'insert-misses-once'
        || (behavior === 'submit-noop-once' && submits >= 2);
      if (fires && composer) { composer = ''; registered = true; }
    },
  };
  const page = {
    url: () => 'https://claude.ai/chat/mock',
    $: async (s) => {
      if (s === SEL[model].input) {
        if (behavior === 'vanishes' && inserts > 0) return null;
        return inputEl;
      }
      if (s === SEL[model].submit) return submitEl;
      if (pillPresent && s === SEL[model].pill) return makeEl('Research mode on');
      return null;
    },
    $$: async () => (registered ? [makeEl('old'), makeEl(answer)] : [makeEl('old')]),
    keyboard: {
      press: async (k) => {
        presses.push(k);
        if (k === 'Backspace' && presses.includes('ControlOrMeta+a')) { composer = ''; pillPresent = false; }
      },
      insertText: async (t) => {
        inserts++;
        const lands = behavior !== 'insert-never'
          && !(behavior === 'insert-misses-once' && inserts === 1);
        if (lands) { composer += t; totalInserted += t; }
      },
    },
    waitForTimeout: async () => {},
    reload: async () => {},
  };
  return {
    page,
    spy: {
      presses,
      get submits() { return submits; },
      get inserts() { return inserts; },
      get composer() { return composer; },
      get totalInserted() { return totalInserted; },
      get pillPresent() { return pillPresent; },
    },
  };
}

const bs = (mock) => ({
  getActiveModels: () => ['claude'],
  getPage: () => mock.page,
  isConnected: () => false,
});

// Multi-line prompt: the last-80-char tail spans a blank line, exactly like
// every round-2+ consensus prompt ("...\n\nProvide your response now:").
const MULTILINE_PROMPT = 'Compare the answers above and explain any differences that remain.\n\nProvide your response now:';

console.log('Send-Verification Tests (PR-9, receipt + release)\n');

console.log('normal send (multi-line prompt, block-editor whitespace):');
{
  const m = makeSendMock('clears');
  const ok = await sendToModel(bs(m), 'claude', MULTILINE_PROMPT);
  assert(ok === true, 'verified send returns true');
  assert(m.spy.inserts === 1 && m.spy.submits === 1, 'one insert, one submit');
  assert(m.spy.composer === '', 'composer released the prompt');
  assert(!m.spy.presses.includes('ControlOrMeta+a'), 'no composer clearing on the happy path');
}

console.log('\nsilent submit, successful submit-retry:');
{
  const m = makeSendMock('submit-noop-once');
  const ok = await sendToModel(bs(m), 'claude', 'Sentinel prompt for retry.');
  assert(ok === true, 'retry recovers the silent submit');
  assert(m.spy.submits === 2, 'submit clicked exactly twice');
  assert(m.spy.inserts === 1, 'prompt NEVER re-inserted on submit-retry (double-send impossible)');
  assert(!m.spy.presses.includes('ControlOrMeta+a'), 'no clearing during submit-retry');
}

console.log('\nsubmit never registers:');
{
  const m = makeSendMock('submit-never');
  let err = null;
  try { await sendToModel(bs(m), 'claude', 'This prompt never leaves the composer.'); } catch (e) { err = e; }
  assert(err && err.message.includes('send not registered after retry'), 'fails loudly after one submit-retry');
  assert(m.spy.submits === 2 && m.spy.inserts === 1, 'two submits, one insert, then gave up');
}

console.log('\ninsert misses once (the observed stale-editor race), recovered:');
{
  const m = makeSendMock('insert-misses-once');
  const ok = await sendToModel(bs(m), 'claude', 'Prompt that first lands nowhere.');
  assert(ok === true, 'guarded re-insert recovers the missed insert');
  assert(m.spy.inserts === 2, 'insert retried exactly once');
  assert(m.spy.presses.includes('ControlOrMeta+a'), 'composer cleared before the re-insert');
  assert(m.spy.composer === '', 'send released after recovery');
}

console.log('\ninsert never lands (empty composer must NOT read as sent):');
{
  const m = makeSendMock('insert-never');
  let err = null;
  try { await sendToModel(bs(m), 'claude', 'Prompt that never appears.'); } catch (e) { err = e; }
  assert(err && err.message.includes('did not register in composer'),
    'receipt phase fails loudly — an empty composer is an insert failure, not a sent message');
  assert(m.spy.submits === 0, 'submit NEVER clicked without receipt');
}

console.log('\ninsert misses while a research pill sits in the composer:');
{
  const m = makeSendMock('insert-never', { pill: true });
  let err = null;
  try { await sendToModel(bs(m), 'claude', 'Prompt with a configured pill present.'); } catch (e) { err = e; }
  assert(err && err.message.includes('refusing to clear'),
    'clear is refused when it would destroy a mode pill');
  assert(!m.spy.presses.includes('ControlOrMeta+a') && m.spy.pillPresent === true,
    'pill untouched, no select-all issued');
  assert(m.spy.submits === 0, 'no submit without receipt');
}

console.log('\nambiguous composer state (input vanishes after insert):');
{
  const m = makeSendMock('vanishes');
  let err = null;
  try { await sendToModel(bs(m), 'claude', 'Composer disappears after insert.'); } catch (e) { err = e; }
  assert(err && err.message.includes('composer unreadable'),
    'unreadable composer fails WITHOUT submit or retry');
  assert(m.spy.inserts === 1 && m.spy.submits === 0,
    'no re-insert and no submit when a double-send cannot be ruled out');
}

console.log('\nlarge chunked insert (synthesis payloads):');
{
  // A payload well past INSERT_CHUNK_CHARS, containing astral chars (emoji =
  // surrogate pairs) right at likely chunk boundaries, must land intact and
  // pass receipt. INSERT_CHUNK_CHARS default 15000.
  const big = '📚'.repeat(9000) + '\n\nTAIL_SENTINEL_END'; // 18000 code units of surrogate pairs + tail
  const m = makeSendMock('clears');
  const ok = await sendToModel(bs(m), 'claude', big);
  assert(ok === true, 'large multi-chunk insert verifies and sends');
  assert(m.spy.inserts > 1, 'payload was chunked (multiple insertText calls)');
  // The mock composer accumulated every chunk; reconstruct and compare.
  assert(m.spy.totalInserted === big, 'reassembled chunks equal the original (no dropped/split surrogate chars)');
  assert(!/�/.test(m.spy.totalInserted) && (m.spy.totalInserted.match(/📚/g) || []).length === 9000,
    'all 9000 emoji survived — no surrogate pair was split at a chunk boundary');
}

console.log('\nround-level quarantine:');
{
  const bad = makeSendMock('submit-never');
  const good = makeSendMock('clears', { answer: 'healthy answer', model: 'chatgpt' });
  const round = await runConsensusRound(
    { getActiveModels: () => ['claude', 'chatgpt'], getPage: (mod) => (mod === 'claude' ? bad.page : good.page), isConnected: () => false },
    'Round prompt for quarantine check.', 1,
  );
  assert(round.errors.claude && round.errors.claude.phase === 'send'
    && round.errors.claude.message.includes('send not registered'),
    'unverified send quarantined as a send-phase error');
  assert(round.outputs.chatgpt === 'healthy answer' && !round.outputs.claude,
    'healthy peer unaffected; failed model has no output');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
