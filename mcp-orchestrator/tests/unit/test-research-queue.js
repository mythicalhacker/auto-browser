import './_hermetic-env.js'; // pins REGISTRY_FILE + QUOTA_FILE + RESEARCH_HOME
/**
 * Research Queue Tests — PR-10 contract.
 * Routing, daily-cap ledger math + rollover, cooldown/reset-time parsing,
 * banner detection (incl. the LIVE-captured Claude credits banner and the
 * LIVE-observed Fable safeguard pause), queue state machine, cross-process
 * lockfile, and the runner end-to-end over a composer-accurate fake site.
 */
import { spawnSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.STATE_FILE = join(tmpdir(), `research-test-state-${process.pid}.json`);
process.env.SEND_VERIFY_MS = '200';
process.env.SEND_RECEIPT_MS = '150';
process.env.DR_RETRY_DELAY_MS = '1';
// Fake sites carry no pre-generation gate; keep the gate watch window tiny so
// the runner's post-send gate check returns fast instead of polling minutes.
process.env.DR_GATE_WATCH_MS = '50';
process.env.DR_GATE_POLL_MS = '5';

// Force UNIQUE tmp paths regardless of inherited env — this file rmSync's
// them, and a user who exported RESEARCH_HOME/QUOTA_FILE pointing at their
// real ~/.auto-browser must never have `npm test` delete paid artifacts.
// (Set BEFORE the research module imports, which read env at load.)
process.env.RESEARCH_HOME = join(tmpdir(), `ab-rq-test-${process.pid}-research`);
process.env.QUOTA_FILE = join(tmpdir(), `ab-rq-test-${process.pid}-quotas.json`);
rmSync(process.env.RESEARCH_HOME, { recursive: true, force: true });
rmSync(process.env.QUOTA_FILE, { force: true });

const registry = await import('../../models/registry.js');
const ledger = await import('../../research/quota-ledger.js');
const banners = await import('../../research/banners.js');
const queue = await import('../../research/research-queue.js');
const { acquireDrainLock, releaseDrainLock } = await import('../../research/lockfile.js');
const runner = await import('../../research/runner.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

console.log('Research Queue Tests (PR-10)\n');

// --- routing -----------------------------------------------------------------
console.log('routing policy:');
assert(queue.routeProviders(true).join(',') === 'gemini,claude,chatgpt', 'gemini_priority → all three');
assert(queue.routeProviders(false).join(',') === 'claude,chatgpt', 'standard → claude+chatgpt only');

// --- quota ledger ------------------------------------------------------------
console.log('\nquota ledger (gemini cap 5/day from registry):');
const T0 = new Date(2026, 6, 4, 10, 0, 0).getTime(); // local 2026-07-04 10:00
assert(ledger.dailyCap('gemini') === 5 && ledger.dailyCap('claude') === null,
  'caps come from registry quotas.deepResearchPerDay');
for (let i = 0; i < 5; i++) ledger.recordDRSpend('gemini', T0 + i);
const blocked = ledger.canSpendDR('gemini', T0 + 10);
assert(blocked.ok === false && blocked.reason.includes('daily cap reached (5/5)'), 'sixth run blocked at the cap');
assert(new Date(blocked.nextEligibleAt).getHours() === 0
  && ledger.dayOf(blocked.nextEligibleAt) === '2026-07-05', 'eligible again at local midnight');
const nextDay = ledger.canSpendDR('gemini', T0 + 24 * 3600 * 1000);
assert(nextDay.ok === true, 'day rollover resets the counter');
assert(ledger.canSpendDR('claude', T0).ok === true, 'uncapped provider always eligible (banners handle limits)');

ledger.setCooldown('claude', T0 + 3600 * 1000, 'plan limit banner', T0);
const cooled = ledger.canSpendDR('claude', T0 + 60 * 1000);
assert(cooled.ok === false && cooled.nextEligibleAt === T0 + 3600 * 1000, 'cooldown blocks until the reset');
assert(ledger.canSpendDR('claude', T0 + 3700 * 1000).ok === true, 'cooldown expires on its own');
ledger.setCooldown('claude', null, null, T0);
const snap = ledger.quotaSnapshot(['gemini', 'claude'], T0 + 10);
assert(snap.gemini.used === 5 && snap.gemini.eligible === false && snap.claude.eligible === true,
  'quotaSnapshot reports per-provider state');

// --- reset-time parsing --------------------------------------------------------
console.log('\nreset-time parsing:');
const FRI = new Date(2026, 6, 3, 19, 0, 0).getTime(); // Friday 19:00 local
const hardBanner = "You've reached your Fable 5 limit · Resets Saturday at 8:00 PM.";
const satReset = banners.parseResetTime(hardBanner, FRI);
{
  const d = new Date(satReset);
  assert(d.getDay() === 6 && d.getHours() === 20 && d.getMinutes() === 0
    && satReset > FRI && satReset - FRI < 2 * 24 * 3600 * 1000,
    'hard-limit banner → next Saturday 20:00');
}
assert(banners.parseResetTime('try again in 2 hours', FRI) === FRI + 2 * 3600 * 1000, '"in 2 hours" relative');
assert(banners.parseResetTime('available again in 45 minutes', FRI) === FRI + 45 * 60000, '"in 45 minutes" relative');
{
  const t = banners.parseResetTime('limit resets tomorrow at 9 AM', FRI);
  const d = new Date(t);
  assert(d.getDate() === 4 && d.getHours() === 9, '"tomorrow at 9 AM"');
  const t2 = banners.parseResetTime('resets at 3 AM', FRI);
  const d2 = new Date(t2);
  assert(t2 > FRI && d2.getHours() === 3, 'bare clock time → next occurrence');
}
assert(banners.parseResetTime('Some message with no time', FRI) === null, 'unparseable → null (caller defaults)');

// --- banner detection (conservative: hard-block only) --------------------------
console.log('\nbanner detection (learned live 2026-07-04: soft warnings must NOT park):');
function bannerPage({ bannerText = null, bodyText = '', contentText = '' } = {}) {
  const el = (t) => ({ innerText: async () => t, evaluate: async () => 'x', isVisible: async () => true, click: async () => {} });
  return {
    url: () => 'https://claude.ai/chat/x',
    $: async (s) => (bannerText && s === 'div[role="status"] span.text-body' ? el(bannerText) : null),
    $$: async (s) => (bannerText && s === 'div[role="status"] span.text-body' ? [el(bannerText)] : []),
    // Model live innerText: excludes <script>/hidden; report region subtracted.
    evaluate: async () => ({ bodyText, content: contentText }),
    waitForTimeout: async () => {},
  };
}
{
  // Soft warnings — the exact live specimens that FALSELY parked GATE 10.
  const soft1 = await banners.detectInterrupt(bannerPage({ bannerText: "You've used 91% of your Fable 5 limit · Resets Thursday at 11:30 PM" }), 'claude', FRI);
  assert(soft1.type === null, '"used 91% … Resets Thursday" is a soft warning → NOT parked');
  const soft2 = await banners.detectInterrupt(bannerPage({ bannerText: 'Now using credits • Your plan limit resets Saturday at 8:00 PM.' }), 'claude', FRI);
  assert(soft2.type === null, '"Now using credits … resets" is a soft notice → NOT parked');

  // Hard block — a real limit-reached banner still parks, with reset parsed.
  const hard = await banners.detectInterrupt(bannerPage({ bannerText: hardBanner }), 'claude', FRI);
  assert(hard.type === 'quota' && hard.resetAt === satReset, 'hard "reached your limit" banner → quota with reset');
  const oom = await banners.detectInterrupt(bannerPage({ bannerText: "You're out of messages. Try again later." }), 'claude', FRI);
  assert(oom.type === 'quota', '"out of messages" → quota');

  // Safety pause card.
  const paused = await banners.detectInterrupt(bannerPage({
    bodyText: 'Chat paused\nEdit and retry with Fable 5\n\nFable’s safeguards flagged this message.',
  }), 'claude', FRI);
  assert(paused.type === 'paused' && /chat paused|safeguards flagged/i.test(paused.text),
    'live safeguard pause card → paused with evidence');

  // Report/prompt CONTENT that discusses limits must NOT be mis-flagged.
  const reportish = await banners.detectInterrupt(bannerPage({
    bodyText: 'Node.js LTS report\nThe API returned "rate limited" during testing and reached your limit.',
    contentText: 'Node.js LTS report\nThe API returned "rate limited" during testing and reached your limit.',
  }), 'claude', FRI);
  assert(reportish.type === null, 'limit wording INSIDE the report (content) is subtracted → not an interrupt');

  // Page-script text is excluded by live innerText (never appears in bodyText).
  const clean = await banners.detectInterrupt(bannerPage({ bodyText: 'What is 2+2?\n4' }), 'claude', FRI);
  assert(clean.type === null, 'clean page → no interrupt');
}

// --- queue state machine ---------------------------------------------------------
console.log('\nqueue state machine:');
const { batch, taskIds } = queue.submitBatch([
  { prompt: 'Research topic A', gemini_priority: true },
  { prompt: 'Research topic B', project: 'Auto Engineer' },
], { now: T0 });
assert(taskIds.length === 2, 'batch submitted');
const tA = queue.getTask(taskIds[0]);
const tB = queue.getTask(taskIds[1]);
assert(Object.keys(tA.perProvider).join(',') === 'gemini,claude,chatgpt'
  && Object.keys(tB.perProvider).join(',') === 'claude,chatgpt', 'routing applied per task');
assert(tB.project === 'Auto Engineer', 'project carried');

assert(queue.nextRunnable('gemini').id === tA.id, 'FIFO next runnable');

// Fresh (unspent) awaiting_quota: quota-gated, NOT resumable.
queue.markRunning(tA.id, 'gemini', { now: T0 });
assert(queue.getTask(tA.id).perProvider.gemini.attempts === 0, 'markRunning does NOT count an attempt (failures do)');
queue.markAwaitingQuota(tA.id, 'gemini', { reason: 'daily cap', now: T0 });
assert(queue.nextRunnable('gemini', { quotaOk: false }) === null, 'unspent awaiting_quota hidden while quota blocked');
assert(queue.nextRunnable('gemini', { quotaOk: true }).id === tA.id, 'unspent awaiting_quota resumes when eligible');
assert(queue.nextResumable('gemini') === null, 'unspent task is NOT resumable (no paid chat to harvest)');

// Spent (mid-run banner) awaiting_quota: RESUMABLE regardless of quota, chatUrl kept.
queue.markSpent(tA.id, 'gemini', { now: T0 });
queue.recordChatUrl(tA.id, 'gemini', 'https://gemini.google.com/app/abc');
queue.markAwaitingQuota(tA.id, 'gemini', { reason: 'mid-run quota banner', now: T0 });
assert(queue.nextResumable('gemini').id === tA.id, 'spent awaiting_quota IS resumable (harvest the paid chat)');
assert(queue.nextRunnable('gemini', { quotaOk: true }) === null, 'spent task never re-runs fresh (no double spend)');
assert(queue.getTask(tA.id).perProvider.gemini.chatUrl.includes('/app/abc'), 'chatUrl preserved through quota parking');
queue.recordChatUrl(tA.id, 'gemini', 'https://gemini.google.com/app/DIFFERENT');
assert(queue.getTask(tA.id).perProvider.gemini.chatUrl.includes('/app/abc'),
  'a sealed chatUrl is never clobbered by a later navigation');

// Attempt accounting: failures BEFORE any markRunning still count (else infinite retry).
queue.markFailed(tB.id, 'claude', { error: 'ensureChat: flake (never reached running)', now: T0 });
assert(queue.getTask(tB.id).perProvider.claude.status === 'queued'
  && queue.getTask(tB.id).perProvider.claude.attempts === 1,
  'pre-running failure counts an attempt and re-queues (1/2)');
queue.markFailed(tB.id, 'claude', { error: 'ensureChat: flake again', now: T0 });
assert(queue.getTask(tB.id).perProvider.claude.status === 'failed'
  && queue.getTask(tB.id).perProvider.claude.attempts === 2,
  'MAX_ATTEMPTS reached across pre-running failures → terminal failed (no infinite loop)');
queue.markFailed(tB.id, 'chatgpt', { error: 'dr_timeout', terminal: true, now: T0 });
assert(queue.getTask(tB.id).perProvider.chatgpt.status === 'failed'
  && queue.getTask(tB.id).perProvider.chatgpt.attempts === 1,
  'terminal failure (dr_timeout) never auto-retries — no double spend');

const table = queue.statusTable(batch);
assert(table.length === 2 && table[1].providers.claude.status === 'failed'
  && typeof table[0].providers.gemini.spent === 'boolean', 'statusTable reports per task × provider incl. spent');

// reconcile: a crash-orphaned 'running' task re-queues (unspent) or stays for resume (spent).
{
  const { taskIds: [rc] } = queue.submitBatch([{ prompt: 'Crash reconcile.' }]);
  queue.markRunning(rc, 'claude', { now: T0 });
  const n = queue.reconcileRunning();
  assert(n >= 1 && queue.getTask(rc).perProvider.claude.status === 'queued',
    'reconcile re-queues an unspent orphaned running task');
  queue.markRunning(rc, 'claude', { now: T0 });
  queue.markSpent(rc, 'claude', { now: T0 });
  queue.recordChatUrl(rc, 'claude', 'https://claude.ai/chat/orphan');
  queue.reconcileRunning();
  assert(queue.getTask(rc).perProvider.claude.status === 'running'
    && queue.nextResumable('claude').id === rc,
    'reconcile leaves a spent orphaned running task for resume (never re-run)');
}

// --- lockfile ------------------------------------------------------------------
console.log('\ncross-process drain lock:');
{
  const first = acquireDrainLock();
  assert(first.ok === true, 'lock acquired');
  const again = acquireDrainLock();
  assert(again.ok === true, 're-acquire by the same pid is allowed');
  releaseDrainLock();

  // A DEFINITELY-live foreign holder: a child process we spawn and keep alive.
  const lockPath = join(process.env.RESEARCH_HOME, 'runner.lock');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200)); // let it come up
  writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  const refused = acquireDrainLock();
  assert(refused.ok === false && refused.holder.pid === child.pid, 'live holder refuses a second drain');
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200)); // let it die

  // Dead holder: the just-killed child's pid → taken over.
  writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: Date.now() - 5000 }));
  const takeover = acquireDrainLock();
  assert(takeover.ok === true && takeover.takeover === true, 'dead holder\'s lock is taken over');
  releaseDrainLock();
  assert(!existsSync(lockPath), 'release removes our own lock');
}

// --- runner end-to-end over a fake research site --------------------------------
console.log('\nrunner end-to-end (fake research site):');
// input/submit/output/streaming use the REAL claude strings: sendToModel and
// waitForResearchComplete read the import-time config SELECTORS shim, not the
// in-process rebuilt registry — the mock must satisfy both paths.
const RUNNER_SELECTORS = {
  input: ['.ProseMirror'],
  submit: ['button[aria-label="Send message"]'],
  output: ['.font-claude-response .standard-markdown'],
  streaming: ['[data-is-streaming="true"]'],
  researchToggle: [],
  researchMenu: { opener: ['#tools-open'], item: ['.tool-item'], matchText: 'Deep research', closeBy: 'escape' },
  researchActiveIndicator: ['#research-on'],
  quotaBanner: ['.quota-banner'],
  projectNav: {},
};
registry._rebuildForTest({ claude: { selectors: RUNNER_SELECTORS, research: { modes: {} } } });

function fakeResearchSite({ mode = 'complete', loggedIn = true, sent = false, chatUrl = 'https://claude.ai/chat/dr-run-1' } = {}) {
  // mode: complete | quota-after-send | never-stabilizes | ambiguous-send |
  //       report-mentions-ratelimit | resume-complete
  const state = {
    url: loggedIn ? 'https://claude.ai/new' : 'https://claude.ai/login?next=x',
    draft: '', research: false, toolsOpen: false, sent, ticks: 0, selectAll: false, unreadable: false,
  };
  const el = (text, { onClick } = {}) => ({
    innerText: async () => {
      if (state.unreadable) throw new Error('composer detached');
      return typeof text === 'function' ? text() : text;
    },
    click: async () => onClick?.(),
    getAttribute: async () => null,
    evaluate: async () => Math.random().toString(36),
    isVisible: async () => false,
  });
  const answerText = () => {
    state.ticks += 1;
    if (mode === 'never-stabilizes') return 'chunk '.repeat(100 + state.ticks * 5);
    const n = Math.min(state.ticks, 3);
    const body = 'finding '.repeat(80 * n);
    // A legitimate report that DISCUSSES rate limiting must NOT be read as a
    // quota banner — the interrupt scan strips the output region first.
    const topic = mode === 'report-mentions-ratelimit'
      ? 'The client was rate limited by the upstream API; the plan limit resets. '
      : '';
    return `# Research Report\n${topic}${body}`;
  };
  const page = {
    url: () => (state.sent ? chatUrl : state.url),
    goto: async (u) => { state.url = u; if (u === chatUrl) state.sent = true; },
    waitForTimeout: async () => {},
    // Interrupt whole-page scan: return page CHROME only (the runner strips
    // output/prompt/composer regions before scanning, so content never leaks).
    evaluate: async () => '',
    keyboard: {
      press: async (k) => {
        if (k === 'Escape') state.toolsOpen = false;
        if (k === 'ControlOrMeta+a') state.selectAll = true;
        if (k === 'Backspace' && state.selectAll) { state.draft = ''; state.selectAll = false; }
      },
      insertText: async (t) => { state.draft += t; },
    },
    $$: async (s) => {
      switch (s) {
        case '.ProseMirror': return [el(() => state.draft)];
        case '[data-testid="model-selector-dropdown"]': return [el('Fable 5 Max')];
        case 'button[aria-label="Send message"]':
          return [el('send', { onClick: () => {
            if (state.draft) {
              state.lastSent = state.draft;
              state.draft = '';
              state.sent = true;
              // Ambiguous send: composer becomes unreadable right after submit
              // (message may or may not have been delivered).
              if (mode === 'ambiguous-send') state.unreadable = true;
            }
          } })];
        case '#tools-open': return [el('Tools', { onClick: () => { state.toolsOpen = true; } })];
        case '.tool-item':
          return state.toolsOpen ? [el('Deep research', { onClick: () => { state.research = true; } })] : [];
        case '#research-on': return state.research ? [el('Research active')] : [];
        case '.font-claude-response .standard-markdown': return state.sent ? [el(answerText)] : [];
        case '.quota-banner':
          return (mode === 'quota-after-send' && state.sent && state.ticks >= 2)
            ? [el("You've reached your Fable 5 limit · Resets Saturday at 8:00 PM.")]
            : [];
        default: return [];
      }
    },
    $: async (s) => (await page.$$(s))[0] ?? null,
  };
  return { page, state };
}
const fakeBS = (site) => ({
  connect: async () => {},
  getActiveModels: () => ['claude'],
  getPage: () => site.page,
  isConnected: () => false,
});
const FAST = { pollMs: 2, stableMs: 20, timeoutMs: 3000 };

{
  const { batch: b2, taskIds: [id] } = queue.submitBatch([{ prompt: 'Research the release history of Node.js LTS.' }]);
  const site = fakeResearchSite({ mode: 'complete' });
  const status = await runner.runProviderTask(fakeBS(site), 'claude', queue.getTask(id), { waitOpts: FAST });
  const pp = queue.getTask(id).perProvider.claude;
  assert(status === 'complete' && pp.status === 'complete', 'happy path completes');
  assert(site.state.lastSent && site.state.lastSent.startsWith(runner.DR_PREAMBLE)
    && site.state.lastSent.includes('release history of Node.js LTS'),
    'DR send prepends the no-clarifying-questions preamble to the task prompt');
  assert(pp.chatUrl === 'https://claude.ai/chat/dr-run-1', 'chatUrl captured from the live run');
  assert(pp.artifactPath && existsSync(pp.artifactPath)
    && readFileSync(pp.artifactPath, 'utf8').includes('Research Report'),
    'report artifact written');
  const meta = JSON.parse(readFileSync(pp.artifactPath.replace(/\.md$/, '.meta.json'), 'utf8'));
  assert(meta.provider === 'claude' && meta.chars > 400 && meta.chatUrl === pp.chatUrl,
    'meta.json carries provenance');
  assert(site.state.research === true, 'research mode was actually enabled before the send');
}
{
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Quota-limited research topic.' }]);
  const site = fakeResearchSite({ mode: 'quota-after-send' });
  const status = await runner.runProviderTask(fakeBS(site), 'claude', queue.getTask(id), { waitOpts: FAST });
  const pp = queue.getTask(id).perProvider.claude;
  assert(status === 'awaiting_quota' && pp.status === 'awaiting_quota', 'mid-run quota banner → awaiting_quota (never failed)');
  assert(pp.chatUrl === 'https://claude.ai/chat/dr-run-1', 'paid run stays recoverable (chatUrl kept)');
  const gate = ledger.canSpendDR('claude');
  assert(gate.ok === false && /reached your.*limit/i.test(String(gate.reason)), 'provider put on cooldown from the hard-limit banner');
  ledger.setCooldown('claude', null);
}
{
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Timeout-bound research topic.' }]);
  const site = fakeResearchSite({ mode: 'never-stabilizes' });
  const status = await runner.runProviderTask(fakeBS(site), 'claude', queue.getTask(id), {
    waitOpts: { ...FAST, timeoutMs: 60 },
  });
  const pp = queue.getTask(id).perProvider.claude;
  assert(status === 'failed' && pp.status === 'failed' && pp.error.includes('dr_timeout'),
    'timeout is TERMINAL failed (no auto-resend of a paid run)');
}
{
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Login-blocked research topic.' }]);
  const site = fakeResearchSite({ loggedIn: false });
  const status = await runner.runProviderTask(fakeBS(site), 'claude', queue.getTask(id), { waitOpts: FAST });
  assert(status === 'blocked_login'
    && queue.getTask(id).perProvider.claude.status === 'blocked_login'
    && site.state.sent === false,
    'login URL → blocked_login before ANY spend');
}

console.log('\nrunner: spend-safety (review findings):');
{
  // A report that DISCUSSES rate limiting must complete, not be mis-flagged.
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Research API rate limiting.' }]);
  const site = fakeResearchSite({ mode: 'report-mentions-ratelimit' });
  const status = await runner.runProviderTask(fakeBS(site), 'claude', queue.getTask(id), { waitOpts: FAST });
  assert(status === 'complete',
    'report text mentioning "rate limited"/"plan limit" is NOT mis-classified as a quota banner');
}
{
  // Ambiguous send (composer unreadable post-submit) → park for RESUME, never resend.
  ledger.setCooldown('claude', null);
  const before = ledger.canSpendDR('claude'); // eligible
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Ambiguous send topic.' }]);
  const usedBefore = ledger.quotaSnapshot(['claude']).claude.used;
  const site = fakeResearchSite({ mode: 'ambiguous-send' });
  const status = await runner.runProviderTask(fakeBS(site), 'claude', queue.getTask(id), { waitOpts: FAST });
  const pp = queue.getTask(id).perProvider.claude;
  assert(status === 'awaiting_quota' && pp.spent === true,
    'ambiguous post-submit send is parked (spent), NOT retried as a fresh send');
  assert(ledger.quotaSnapshot(['claude']).claude.used === usedBefore + 1,
    'the spend is counted exactly once for an ambiguous send');
  assert(before.ok, 'sanity: claude was eligible before the ambiguous send');
}
{
  // Full double-spend guard: a mid-run quota park, then RESUME harvests the
  // SAME chat without a second recordDRSpend.
  ledger.setCooldown('claude', null);
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'Resume-harvest topic.' }]);
  const usedBefore = ledger.quotaSnapshot(['claude']).claude.used;
  const site1 = fakeResearchSite({ mode: 'quota-after-send' });
  const s1 = await runner.runProviderTask(fakeBS(site1), 'claude', queue.getTask(id), { waitOpts: FAST });
  const pp1 = queue.getTask(id).perProvider.claude;
  assert(s1 === 'awaiting_quota' && pp1.spent && pp1.chatUrl, 'mid-run banner parks a spent, URL-bearing task');
  const usedAfterFirst = ledger.quotaSnapshot(['claude']).claude.used;
  assert(usedAfterFirst === usedBefore + 1, 'exactly one spend so far');

  ledger.setCooldown('claude', null); // reset expired
  // Resume: re-open the chat (now reachable) and complete — NO fresh run.
  const site2 = fakeResearchSite({ mode: 'complete', sent: true, chatUrl: pp1.chatUrl });
  const s2 = await runner.runProviderTask(fakeBS(site2), 'claude', queue.getTask(id), { waitOpts: FAST });
  const pp2 = queue.getTask(id).perProvider.claude;
  assert(s2 === 'complete' && pp2.status === 'complete', 'resume harvests the parked chat to completion');
  assert(ledger.quotaSnapshot(['claude']).claude.used === usedAfterFirst,
    'RESUME did not spend again — no double-spend across a quota park');
  assert(site2.state.draft === '' && site2.state.research === false,
    'resume never opened a fresh chat or re-enabled research (no re-send)');
  assert(pp2.artifactPath && existsSync(pp2.artifactPath), 'harvested report written on resume');
}

console.log('\nrunner: chatgpt reloadOnEmptyOutput on DR (review finding):');
{
  registry._rebuildForTest({
    chatgpt: {
      selectors: {
        input: ['#prompt-textarea'],
        submit: ['button[aria-label="Send prompt"]'],
        output: ['[data-message-author-role="assistant"] .markdown'],
        streaming: ['button[data-testid="stop-button"]'],
        researchToggle: [],
        researchMenu: { opener: ['#tools'], item: ['.ti'], matchText: 'Deep research', closeBy: 'escape' },
        researchActiveIndicator: ['#dr-on'],
        quotaBanner: ['.qb'],
        projectNav: {},
      },
      research: { modes: {} },
    },
  });
  const state = { url: 'https://chatgpt.com/', draft: '', research: false, toolsOpen: false, sent: false, reloaded: false, ticks: 0, selectAll: false };
  const el = (text, { onClick } = {}) => ({
    innerText: async () => (typeof text === 'function' ? text() : text),
    click: async () => onClick?.(), getAttribute: async () => null,
    evaluate: async () => 'x', isVisible: async () => false,
  });
  const page = {
    url: () => (state.sent ? 'https://chatgpt.com/c/dr-2' : state.url),
    goto: async (u) => { state.url = u; },
    reload: async () => { state.reloaded = true; },
    waitForTimeout: async () => {},
    evaluate: async () => '',
    keyboard: {
      press: async (k) => {
        if (k === 'Escape') state.toolsOpen = false;
        if (k === 'ControlOrMeta+a') state.selectAll = true;
        if (k === 'Backspace' && state.selectAll) { state.draft = ''; state.selectAll = false; }
      },
      insertText: async (t) => { state.draft += t; },
    },
    $$: async (s) => {
      switch (s) {
        case '#prompt-textarea': return [el(() => state.draft)];
        // model picker label reads 'Pro Extended' (the registry research
        // model) so selectModel short-circuits as already-selected
        case 'button.__composer-pill[aria-haspopup="menu"]': return [el('Pro Extended')];
        case 'button[aria-label="Send prompt"]': return [el('send', { onClick: () => { if (state.draft) { state.draft = ''; state.sent = true; } } })];
        case '#tools': return [el('Tools', { onClick: () => { state.toolsOpen = true; } })];
        case '.ti': return state.toolsOpen ? [el('Deep research', { onClick: () => { state.research = true; } })] : [];
        case '#dr-on': return state.research ? [el('DR active')] : [];
        // DR report DOM is empty until a reload re-renders it from server state
        case '[data-message-author-role="assistant"] .markdown':
          if (!state.sent) return [];
          return state.reloaded ? [el(`# ChatGPT DR Report\n${'result '.repeat(120)}`)] : [el('')];
        default: return [];
      }
    },
    $: async (s) => (await page.$$(s))[0] ?? null,
  };
  const bs = { connect: async () => {}, getActiveModels: () => ['chatgpt'], getPage: () => page, isConnected: () => false };
  const { taskIds: [id] } = queue.submitBatch([{ prompt: 'ChatGPT DR reload topic.' }]);
  // stableMs small so the empty stretch triggers the one-shot reload quickly
  const status = await runner.runProviderTask(bs, 'chatgpt', queue.getTask(id), {
    waitOpts: { pollMs: 2, stableMs: 10, timeoutMs: 3000 },
  });
  assert(status === 'complete' && state.reloaded === true,
    'empty ChatGPT DR DOM triggers the one-shot reload and then completes (not a false timeout)');
}

registry._rebuildForTest(null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
