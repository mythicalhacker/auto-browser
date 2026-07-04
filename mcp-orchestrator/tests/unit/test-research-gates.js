import './_hermetic-env.js'; // pins REGISTRY_FILE + QUOTA_FILE + RESEARCH_HOME
/**
 * DR Pre-Generation Gate Tests — PR-13 contract.
 * The runner clears a provider's pre-generation gate after send / on resume:
 *   modal / plan_confirm → click the confirm/Start control;
 *   clarify → reply ONCE with a fixed "just produce the report" message,
 *     loop-guarded, and NEVER to a message that might be the report itself.
 */
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = join(tmpdir(), `ab-gates-test-${process.pid}`);
process.env.RESEARCH_HOME = join(TMP, 'research');
process.env.QUOTA_FILE = join(TMP, 'quotas.json');
process.env.STATE_FILE = join(TMP, 'state.json');
process.env.SEND_VERIFY_MS = '100';
process.env.SEND_RECEIPT_MS = '80';
process.env.DR_GATE_WATCH_MS = '400'; // tiny watch window for tests
process.env.DR_GATE_POLL_MS = '5';

const registry = await import('../../models/registry.js');
const queue = await import('../../research/research-queue.js');
const runner = await import('../../research/runner.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

// Claude-shaped test selectors + gates (uses the real config-shim input/submit
// so sendToModel works for the clarify reply).
const TEST_SELECTORS = {
  input: ['.ProseMirror'],
  submit: ['button[aria-label="Send message"]'],
  output: ['.answer'],
  streaming: ['.streaming'],
  researchActiveIndicator: ['#dr-on'],
};

function el(text, { onClick } = {}) {
  return {
    innerText: async () => (typeof text === 'function' ? text() : text),
    click: async () => onClick?.(),
    getAttribute: async () => null,
    evaluate: async () => Math.random().toString(36),
    isVisible: async () => false,
  };
}

/**
 * Fake page keyed by CSS selector strings. `state` drives what's present.
 * Real config-shim selectors (.ProseMirror, Send button) back the composer so
 * sendToModel's receipt/release verification passes for the clarify reply.
 */
function gatePage(state) {
  const page = {
    url: () => 'https://claude.ai/chat/g',
    goto: async () => {},
    reload: async () => {},
    evaluate: async () => '',
    waitForTimeout: async () => {},
    keyboard: {
      press: async (k) => { if (k === 'Escape') {} if (k === 'ControlOrMeta+a') state.selAll = true; if (k === 'Backspace' && state.selAll) { state.draft = ''; state.selAll = false; } },
      insertText: async (t) => { state.draft = (state.draft || '') + t; },
    },
    $$: async (s) => {
      switch (s) {
        case '.ProseMirror': return [el(() => state.draft || '')];
        case 'button[aria-label="Send message"]':
          return [el('send', { onClick: () => { if (state.draft) { state.replySent = state.draft; state.draft = ''; } } })];
        case '#modal': return state.modalOpen ? [el('Enable connectors?')] : [];
        case '#modal-confirm': return state.modalOpen ? [el('Start research', { onClick: () => {
          state.confirmClicks = (state.confirmClicks || 0) + 1;
          // stickyModal: the detect stays matching after click and no progress
          // ever appears (adversarial) — exercises the double-click guard.
          if (!state.stickyModal) { state.modalOpen = false; state.researching = true; }
        } })] : [];
        case '#plan': return state.planOpen ? [el('Research plan')] : [];
        case '#plan-start': return state.planOpen ? [el('Start research', { onClick: () => { state.planOpen = false; state.researching = true; } })] : [];
        case '#assistant-msg': return state.clarifyText != null ? [el(() => state.clarifyText)] : [];
        case '#progress': return state.researching ? [el('Researching…')] : [];
        default: return [];
      }
    },
    $: async (s) => (await page.$$(s))[0] ?? null,
  };
  return page;
}

const bs = (page) => ({ getActiveModels: () => ['claude'], getPage: () => page, isConnected: () => false });

function seedTask() {
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'gate test' }]);
  queue.markRunning(id, 'claude');
  queue.markSpent(id, 'claude');
  return id;
}

console.log('DR Pre-Generation Gate Tests (PR-13)\n');

console.log('modal gate:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'modal', detect: ['#modal'], action: ['#modal-confirm'], progressMarker: ['#progress'] }] } });
  const state = { modalOpen: true, researching: false };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(res.actioned.includes('modal'), 'modal gate actioned');
  assert(state.modalOpen === false && state.researching === true, 'confirm clicked → research started');
}

console.log('\nplan_confirm gate:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'plan_confirm', detect: ['#plan'], action: ['#plan-start'], progressMarker: ['#progress'] }] } });
  const state = { planOpen: true, researching: false };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(res.actioned.includes('plan_confirm') && state.researching === true,
    'plan Start clicked → research started');
}

console.log('\nclarify gate — short question → one auto-reply:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'clarify', detect: ['#assistant-msg'], clarifyMessage: ['#assistant-msg'], progressMarker: ['#progress'] }] } });
  const state = { clarifyText: 'To tailor the research, which Node.js versions should I focus on?' };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(res.actioned.includes('clarify'), 'clarify actioned');
  assert(/produce the full report now/i.test(state.replySent || ''), 'replied with the fixed proceed message');
  assert(queue.getTask(id).perProvider.claude.gateReplied === true, 'gateReplied flag set (loop guard)');
}

console.log('\nclarify loop guard — never a second reply:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'clarify', detect: ['#assistant-msg'], clarifyMessage: ['#assistant-msg'], progressMarker: ['#progress'] }] } });
  const state = { clarifyText: 'Another question — which sources?' };
  const id = seedTask();
  queue.markGateReplied(id, 'claude'); // already replied once
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(!res.actioned.includes('clarify') && !state.replySent, 'no second auto-reply once gateReplied');
}

console.log('\ndouble-click guard — a Confirm/Start control is clicked at most once:');
{
  // Adversarial: gate 0 is a modal that STAYS present after Confirm and never
  // signals "research started"; gate 1 never appears, so the watch loop keeps
  // spinning the whole window. Without the clicked-guard, gate 0's Confirm
  // would be clicked every poll — each click a potential extra PAID run.
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [
      { kind: 'modal', detect: ['#modal'], action: ['#modal-confirm'], progressMarker: ['#progress'] },
      { kind: 'modal', detect: ['#never-appears'], action: ['#never'], progressMarker: ['#never-progress'] },
    ] } });
  const state = { modalOpen: true, researching: false, stickyModal: true, confirmClicks: 0 };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(state.confirmClicks === 1,
    `Confirm clicked exactly once despite the gate persisting + loop staying alive (got ${state.confirmClicks}) — no repeat paid launch`);
  assert(res.actioned.filter((a) => a === 'modal').length === 1, 'modal actioned exactly once');
}

console.log('\nmisdetection bias — a SHORT non-question is NOT answered:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'clarify', detect: ['#assistant-msg'], clarifyMessage: ['#assistant-msg'], progressMarker: ['#progress'] }] } });
  // Short assistant message with NO '?' — a status blurb / report opener, not
  // a question. Must not trigger a reply (the '?' half of the guard).
  const state = { clarifyText: 'Here is what I found. Starting the research now.' };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(!res.actioned.includes('clarify') && !state.replySent,
    'a short message with no question mark is never auto-replied to');
}

console.log('\nmisdetection bias — a long report-like message is NOT answered:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'clarify', detect: ['#assistant-msg'], clarifyMessage: ['#assistant-msg'], progressMarker: ['#progress'] }] } });
  // Long text that even contains a '?' — this is the report, not a question.
  const state = { clarifyText: 'Node.js LTS report.\n' + 'x'.repeat(1600) + '\nWas that helpful?' };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(!res.actioned.includes('clarify') && !state.replySent,
    'a long message that might be the report is never replied to (conservative bias)');
}

console.log('\nresearch already running — no gate action:');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'clarify', detect: ['#assistant-msg'], clarifyMessage: ['#assistant-msg'], progressMarker: ['#progress'] }] } });
  const state = { clarifyText: 'A question?', researching: true };
  const id = seedTask();
  const res = await runner.clearGenerationGates(bs(gatePage(state)), 'claude', queue.getTask(id));
  assert(res.actioned.length === 0 && !state.replySent, 'progress marker present → gate skipped entirely');
}

console.log('\nreportContainer — DR report in a dedicated pane is harvested:');
console.log('resume with a pending gate clears it — never re-sends:');
{
  // The DR report renders in #dr-report (a dedicated pane), declared as the
  // gate's reportContainer so waitForResearchComplete polls it too.
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS,
    generationGates: [{ kind: 'modal', detect: ['#modal'], action: ['#modal-confirm'],
      progressMarker: ['#progress'], reportContainer: ['#dr-report'] }] } });
  const state = { modalOpen: true, researching: false };
  const page = gatePage(state);
  const origDollar = page.$$;
  page.$$ = async (s) => {
    if (s === '#dr-report') return state.researching ? [el(`# Deep Research Report\n${'r'.repeat(500)}`)] : [];
    return origDollar(s);
  };
  const id = seedTask();
  queue.recordChatUrl(id, 'claude', 'https://claude.ai/chat/g');
  const bsResume = { getActiveModels: () => ['claude'], getPage: () => page, isConnected: () => false, connect: async () => {} };
  const status = await runner.resumeProviderTask(bsResume, 'claude', queue.getTask(id), {
    waitOpts: { pollMs: 5, stableMs: 20, timeoutMs: 2000 },
  });
  assert(state.modalOpen === false, 'resume cleared the pending modal gate');
  assert(!state.replySent, 'resume did NOT re-send the prompt (no composer submit)');
  assert(status === 'complete', 'resume harvested the report from the dedicated reportContainer after clearing the gate');
}

registry._rebuildForTest(null);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
