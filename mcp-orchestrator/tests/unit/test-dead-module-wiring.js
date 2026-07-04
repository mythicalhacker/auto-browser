/**
 * Dead-Module Wiring Tests — Stage 6 (PR-5).
 * Context-compression in cross-pollination, per-round login gating
 * (login_expired fails fast, no timeout burn), rate-limiter counting in
 * sendToModel, latency-stats persistence, health_check observability.
 * No Chrome — mock pages implement exactly the Playwright surface the
 * production code touches ($, $$, keyboard, waitForTimeout, url).
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'wiring-test-')), 'state.json');

const {
  generateConsensusPrompt, parseVerdict, runConsensusRound,
} = await import('../../tools/consensus.js');
const { getUsageStats } = await import('../../utils/rate-limiter.js');
const { latencySummary } = await import('../../utils/latency-stats.js');
const { getHealthReport, formatHealthReport } = await import('../../utils/health-check.js');

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

// --- mock page: the exact Playwright surface the round machinery uses ---
function mockModelPage({ loggedIn = true, answer = 'mock answer', neverResponds = false, selectorFlake = false } = {}) {
  let sent = false;
  const spy = { insertTextCalls: 0 };
  const makeEl = (text) => ({
    evaluate: async () => Math.random().toString(36),
    innerText: async () => text,
    isVisible: async () => false,
    click: async () => {},
  });
  const page = {
    url: () => (loggedIn ? 'https://claude.ai/chat/mock' : 'https://claude.ai/login?from=logout'),
    $: async () => (loggedIn && !selectorFlake ? makeEl('input') : null),
    $$: async () => (sent && !neverResponds ? [makeEl('old'), makeEl(answer)] : [makeEl('old')]),
    keyboard: {
      press: async () => {},
      insertText: async () => { spy.insertTextCalls++; sent = true; },
    },
    waitForTimeout: async () => {},
    reload: async () => {},
  };
  return { page, spy };
}

function mockBrowserService(pagesByModel) {
  return {
    getActiveModels: () => Object.keys(pagesByModel),
    getPage: (m) => pagesByModel[m]?.page || null,
    isConnected: () => false,
  };
}

async function runTests() {
  console.log('Dead-Module Wiring Tests (PR-5)\n');

  // --- context-compression in cross-pollination ---
  console.log('context-compression in generateConsensusPrompt:');

  const shortRounds = [{
    round: 1,
    outputs: { claude: 'Short A.', chatgpt: 'Short B.', gemini: 'Short C.' },
    errors: {},
  }];
  const pShort = generateConsensusPrompt('Q', shortRounds, 'claude');
  assert(pShort.includes('Short B.') && pShort.includes('Short C.'), 'under threshold: peer text verbatim');
  assert(!pShort.includes('condensed'), 'under threshold: no compression marker');

  const longText = (tag) =>
    `${tag} opening sentence. ` + `${tag} middle filler sentence. `.repeat(300) + `${tag} closing recommendation.`;
  const longRounds = [{
    round: 1,
    outputs: { claude: longText('CLD'), chatgpt: longText('GPT'), gemini: longText('GEM') },
    errors: {},
  }];
  const pLong = generateConsensusPrompt('Q', longRounds, 'claude');
  assert(pLong.includes('condensed'), 'over threshold: middle condensed marker present');
  assert(pLong.length < longText('GPT').length + longText('GEM').length,
    'over threshold: prompt much smaller than raw peer text');
  assert(pLong.includes('GPT opening sentence.') && pLong.includes('GPT closing recommendation.'),
    'over threshold: head and tail survive compression');
  assert(parseVerdict(pLong) === null, 'compressed prompt is not verdict-parseable');

  const longWithVerdict = {
    round: 2,
    outputs: {
      chatgpt: longText('GPT') + '\nVERDICT: AGREE',
      gemini: longText('GEM') + '\nVERDICT: DISAGREE',
    },
    errors: {},
  };
  const pStripped = generateConsensusPrompt('Q', [shortRounds[0], longWithVerdict], 'claude');
  assert(!pStripped.includes('VERDICT: AGREE') && !pStripped.includes('VERDICT: DISAGREE'),
    'verdict lines stripped BEFORE compression (tail cannot resurrect them)');
  assert(parseVerdict(pStripped) === null, 'stripped+compressed prompt still not parseable');

  // Adversarial (found by review): a MID-LINE verdict mention survives the
  // line-anchored first strip; the tail cut then begins the embedded text
  // exactly at 'VERDICT', manufacturing a fresh line anchor. The post-
  // compression re-strip must kill it.
  const resurrect = 'Intro sentence. ' + 'filler words without boundaries '.repeat(90) +
    'pivotal clause. VERDICT: DISAGREE is where I stand because meaningful differences remain and the analysis continues without any additional boundary markers at all';
  const pResurrect = generateConsensusPrompt('Q', [{
    round: 2,
    outputs: { chatgpt: resurrect, gemini: resurrect },
    errors: {},
  }], 'claude');
  assert(parseVerdict(pResurrect) === null,
    'tail-cut cannot resurrect a parseable verdict line (re-strip after compression)');

  // --- per-round login gating ---
  console.log('\nper-round login gating (login_expired):');

  // chatgpt plays the logged-out role; claude/gemini are the healthy senders
  // whose usage counts get asserted below.
  const loggedOut = mockModelPage({ loggedIn: false });
  const healthy1 = mockModelPage({ answer: 'healthy one' });
  const healthy2 = mockModelPage({ answer: 'healthy two' });
  const bs = mockBrowserService({ chatgpt: loggedOut, claude: healthy1, gemini: healthy2 });

  const round = await runConsensusRound(bs, 'test prompt', 1, { responseTimeoutMs: 30000 });
  assert(round.errors.chatgpt !== undefined, 'logged-out model failed');
  assert((round.errors.chatgpt?.message || '').startsWith('login_expired'), 'failure message is login_expired');
  assert(round.errors.chatgpt?.phase === 'login', 'failure phase is login');
  assert(loggedOut.spy.insertTextCalls === 0, 'nothing was ever typed into the logged-out tab (no burn)');
  assert(round.outputs.claude === 'healthy one' && round.outputs.gemini === 'healthy two',
    'healthy models completed normally alongside the gated one');
  assert(parseVerdict(generateConsensusPrompt('Q', [round], 'claude')) === null,
    'login_expired peers stay quarantined out of the next prompt');

  // A selector flake on a logged-in URL is INCONCLUSIVE: it must NOT be
  // login-gated — the send path decides (and fails with phase 'send').
  const flaky = mockModelPage({ selectorFlake: true });
  const healthyF = mockModelPage({ answer: 'steady' });
  const roundF = await runConsensusRound(
    mockBrowserService({ claude: flaky, gemini: healthyF }), 'flake test', 1, { responseTimeoutMs: 30000 });
  assert(roundF.errors.claude?.phase === 'send', 'selector flake fails at the SEND phase, not login');
  assert(!(roundF.errors.claude?.message || '').startsWith('login_expired'), 'selector flake is never reported as login_expired');
  assert(roundF.outputs.gemini === 'steady', 'peer unaffected by the flaky model');

  // --- rate-limiter counting ---
  console.log('\nrate-limiter wiring:');

  // claude: 1 send (login round; the flake round threw before recording).
  // gemini: 2 sends (login round + flake round).
  assert(getUsageStats('claude').used === 1 && getUsageStats('gemini').used === 2,
    'sends recorded exactly for real send attempts');

  // --- latency-stats wiring ---
  console.log('\nlatency-stats wiring:');

  let lat = latencySummary();
  assert(lat.claude?.count === 1 && typeof lat.claude.p50 === 'number', 'latency sample recorded for a success');
  assert((lat.chatgpt?.timeouts || 0) === 0, 'login_expired is NOT counted as a timeout');

  // Fresh pages: the one-shot growth mock cannot be reused across rounds.
  const healthy3 = mockModelPage({ answer: 'healthy again' });
  const silent = mockModelPage({ neverResponds: true });
  const bs2 = mockBrowserService({ claude: healthy3, gemini: silent });
  const round2 = await runConsensusRound(bs2, 'again', 1, { responseTimeoutMs: 1200 });
  assert(round2.outputs.claude === 'healthy again', 'healthy model succeeds in round 2');
  assert((round2.errors.gemini?.message || '').includes('Timeout waiting for response'), 'silent model times out');
  lat = latencySummary();
  assert(lat.gemini?.timeouts === 1, 'response timeout recorded in latency stats');
  assert(lat.claude?.count === 2, 'latency samples accumulate across rounds');

  // --- health_check observability ---
  console.log('\nhealth_check observability:');

  const report = await getHealthReport(mockBrowserService({}));
  assert(Array.isArray(report.rateLimits) && report.rateLimits.length === 3, 'report carries rate-limit stats');
  assert(typeof report.latency === 'object', 'report carries latency summary');
  const text = formatHealthReport(report);
  assert(text.includes('Rate limits'), 'formatted report has a rate-limits section');
  assert(/claude: 2\//.test(text), 'formatted report shows real send counts');
  assert(text.includes('Response latency'), 'formatted report has a latency section');
  assert(/gemini: n=\d+ .*timeouts=1/.test(text), 'formatted report shows timeout counts');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
