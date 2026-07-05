// scripts/e2e/gates.js — E2E gate implementations. Loaded by run-e2e.js AFTER
// it pins STATE_FILE, so importing product modules here is env-safe.
//
// Safety invariants enforced here:
//  - Per-site live-message budget (LEDGER_LIMIT) pre-charged before any send.
//  - >= PAUSE_MS between consensus-style runs.
//  - Model responses are treated as opaque data: assertions are mechanical
//    (token equality, regex, JSON fields) — response text is never interpreted.
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { McpClient, STATE_DIR } from './mcp-client.js';
import {
  ensureChrome, cdpReady, weSpawnedChrome, ensureModelTabs, openModelTabs,
  reduceModelTabsTo, loginStatus, freshModelChats, adoptRunningChrome, MODEL_URLS,
} from './chrome.js';
import { providerNames, getProvider, testModelFor, modelDriftReport } from '../../models/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = join(STATE_DIR, 'ledger.json');
const LOGINS_FILE = join(STATE_DIR, 'logins.json');
const LEDGER_LIMIT = 30; // hard per-site cap for the whole run
const PAUSE_MS = 120000; // minimum gap between consensus runs
// PR-14 cost control: every consensus/round gate pins the cheapest model
// (the registry testModel = cheapest) unless overridden. A silent fallback to
// a pricier model is caught by the picker-evidence assertions below.
const MODEL_POLICY = process.env.E2E_MODEL_POLICY || 'cheapest';

// Pin EVERY response-timeout knob: per-model env vars outrank TIMEOUT_RESPONSE
// in the config precedence, and McpClient spawns with {...process.env}, so an
// inherited shell TIMEOUT_RESPONSE_<MODEL> would silently defeat a gate that
// sets only the global var.
const responseTimeoutEnv = (ms) => ({
  TIMEOUT_RESPONSE: ms,
  ...Object.fromEntries(providerNames().map((m) => [`TIMEOUT_RESPONSE_${m.toUpperCase()}`, ms])),
});

// --- ledger -----------------------------------------------------------------

function loadLedger() {
  if (!existsSync(LEDGER_FILE)) return { counts: {}, lastConsensusEnd: 0 };
  return JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
}

function saveLedger(l) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2));
}

/** Pre-authorize worst-case sends; throws rather than exceed the budget. */
export function charge(models, perModel) {
  const l = loadLedger();
  for (const m of models) {
    const next = (l.counts[m] || 0) + perModel;
    if (next > LEDGER_LIMIT) {
      throw new Error(`message budget: ${m} would reach ${next}/${LEDGER_LIMIT}`);
    }
  }
  for (const m of models) l.counts[m] = (l.counts[m] || 0) + perModel;
  saveLedger(l);
}

/** Refund the difference when a run used fewer rounds than pre-charged. */
export function refund(models, perModel) {
  if (perModel <= 0) return;
  const l = loadLedger();
  for (const m of models) l.counts[m] = Math.max(0, (l.counts[m] || 0) - perModel);
  saveLedger(l);
}

export function ledgerSnapshot() {
  return loadLedger().counts;
}

async function pauseBetweenConsensusRuns(log) {
  const l = loadLedger();
  const since = Date.now() - (l.lastConsensusEnd || 0);
  if (l.lastConsensusEnd && since < PAUSE_MS) {
    const wait = PAUSE_MS - since;
    log(`pausing ${Math.ceil(wait / 1000)}s between consensus runs`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function markConsensusEnd() {
  const l = loadLedger();
  l.lastConsensusEnd = Date.now();
  saveLedger(l);
}

// --- helpers ----------------------------------------------------------------

function assertInto(details, cond, label) {
  details.push(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  return cond;
}

/**
 * True only when a selection record (from selectModelsForRun / consensusState
 * .models) shows the REQUESTED model was verified with NO fallback. `ok===true
 * && !warning` is the discriminator: a model_unavailable fallback also sets
 * ok:true but carries a warning, and a silent inherit leaves ok:false or the
 * wrong requested name. This is what makes "no silent upgrade to a pricier
 * model" a real assertion rather than the tautological requested-name echo.
 */
function pinnedTo(sel, name) {
  return !!sel && sel.ok === true && !sel.warning
    && (!name || String(sel.requested ?? '').toLowerCase() === String(name).toLowerCase());
}

async function pollStatus(client, { timeoutMs = 360000, intervalMs = 5000 } = {}) {
  const terminal = /consensus_reached|max_rounds_reached|insufficient_models|interrupted|error:/;
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const res = await client.callTool('get_consensus_status');
    last = McpClient.text(res);
    if (terminal.test(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`status never terminal within ${timeoutMs}ms; last:\n${last}`);
}

function readStateFile(client) {
  return JSON.parse(readFileSync(client.stateFile, 'utf8'));
}

export function usableModels() {
  if (!existsSync(LOGINS_FILE)) return null;
  return JSON.parse(readFileSync(LOGINS_FILE, 'utf8')).usable;
}

// --- gates ------------------------------------------------------------------

/** Chrome-free: server spawn + JSON-RPC handshake + full tool surface. */
export async function gateHandshake(log) {
  const details = [];
  const client = new McpClient({ testName: 'handshake' });
  try {
    const init = await client.initialize();
    assertInto(details, !!init?.serverInfo, `initialize handshake (server: ${init?.serverInfo?.name} ${init?.serverInfo?.version})`);
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    assertInto(details, tools.length >= 25, `tool surface >= 25 (got ${tools.length})`);
    for (const expected of ['start_consensus', 'get_consensus_status', 'health_check', 'browser_type', 'task_submit']) {
      assertInto(details, names.includes(expected), `tool present: ${expected}`);
    }
    writeFileSync(join(STATE_DIR, 'tool-surface.json'), JSON.stringify(names, null, 2));
    return details;
  } finally {
    await client.close();
  }
}

/** Chrome-free: MCP-layer argument validation returns isError, no crash. */
export async function gateValidation(log) {
  const details = [];
  const client = new McpClient({ testName: 'validation' });
  try {
    await client.initialize();
    const cases = [
      ['start_consensus', {}, 'missing prompt'],
      ['start_consensus', { prompt: 'x', max_rounds: '1' }, 'max_rounds "1" (below minimum)'],
      ['start_consensus', { prompt: 'x', max_rounds: 50 }, 'max_rounds 50 (above maximum)'],
      ['send_single_round', {}, 'send_single_round missing prompt'],
    ];
    for (const [tool, args, label] of cases) {
      const res = await client.callTool(tool, args);
      assertInto(details, res.isError === true, `isError for ${label} (${JSON.stringify(McpClient.text(res)).slice(0, 80)})`);
    }
    const tools = await client.listTools();
    assertInto(details, tools.length >= 25, 'server still responsive after error cases');
    return details;
  } finally {
    await client.close();
  }
}

/**
 * Live, zero-message: with exactly ONE model tab, start_consensus with a
 * numeric-string max_rounds is ACCEPTED (coercion) and the workflow aborts
 * as insufficient_models before any send.
 */
export async function gateInsufficient(log) {
  const details = [];
  await ensureChrome({});
  let open = await openModelTabs();
  let count = Object.keys(open).length;
  if (count === 0) {
    await ensureModelTabs(['claude']);
  } else if (count > 1) {
    if (!(await weSpawnedChrome())) {
      return ['SKIP: reused Chrome already has >1 model tab; refusing to close tabs we do not own'];
    }
    const keep = open.claude ? 'claude' : Object.keys(open)[0];
    log(`closing session-restored model tabs (keeping ${keep}) in harness-spawned Chrome`);
    await reduceModelTabsTo(keep);
  }
  open = await openModelTabs();
  count = Object.keys(open).length;
  assertInto(details, count === 1, `exactly one model tab open (got ${count}: ${Object.keys(open).join(',')})`);

  const client = new McpClient({ testName: 'insufficient' });
  try {
    await client.initialize();
    const res = await client.callTool('start_consensus', { prompt: 'gate: insufficient models', max_rounds: '3' });
    assertInto(details, res.isError !== true, 'numeric-string max_rounds "3" accepted (coercion)');
    assertInto(details, McpClient.text(res).includes('Max rounds: 3'), 'coerced value echoed as 3');
    const status = await pollStatus(client, { timeoutMs: 30000, intervalMs: 1000 });
    assertInto(details, status.includes('insufficient_models'), `status is insufficient_models (${status.split('\n')[0]})`);
    const state = readStateFile(client);
    assertInto(details, state.active === false, 'active flag reset to false');
    assertInto(details, (state.rounds || []).length === 0, 'zero rounds executed (no messages sent)');
    return details;
  } finally {
    await client.close();
  }
}

/** Live: open all tabs, verify logins, persist the usable-model set. */
export async function gateLogins(log) {
  const details = [];
  await ensureChrome({});
  const { pages } = await ensureModelTabs(Object.keys(MODEL_URLS));
  const { results } = await loginStatus(pages);
  const usable = Object.entries(results).filter(([, r]) => r.loggedIn).map(([m]) => m);
  for (const [model, r] of Object.entries(results)) {
    // WARN (not BLOCKED): a single logged-out model doesn't block the gate —
    // the >=2-usable assertion below decides.
    details.push(`${r.loggedIn ? 'PASS' : 'WARN'}: ${model} login — ${r.reason}`);
  }
  writeFileSync(LOGINS_FILE, JSON.stringify({ usable, results, at: new Date().toISOString() }, null, 2));
  assertInto(details, usable.length >= 2, `>=2 usable models (got ${usable.length}: ${usable.join(',')})`);
  return details;
}

/**
 * Live: THE PR-1 core claim. Distinct sentinel prompt per model, sent in
 * parallel through the production round machinery. Each model's page must
 * contain its own token and no other model's token (cross-paste race), and
 * each response must echo its own token (insertText registered).
 */
export async function gateRace(log) {
  const details = [];
  const usable = usableModels();
  if (!usable || usable.length < 2) return ['BLOCKED: needs gateLogins with >=2 usable models first'];

  await pauseBetweenConsensusRuns(log);
  // Conservative: charge every open model tab — runConsensusRound attempts a
  // send to each discovered tab even though only usable ones get a prompt.
  charge(Object.keys(await openModelTabs()), 1);

  const { runConsensusRound, selectModelsForRun } = await import('../../tools/consensus.js');
  const { browserService } = await import('../../services/browser-service.js');

  const tokens = {};
  const prompts = {};
  for (const m of usable) {
    tokens[m] = `SENTINEL_${m.toUpperCase()}_${randomBytes(4).toString('hex')}`;
    prompts[m] = `Reply with exactly ${tokens[m]} and nothing else.`;
  }

  await browserService.connect();
  const active = browserService.getActiveModels().filter((m) => usable.includes(m));
  assertInto(details, active.length === usable.length, `all usable models discovered (${active.join(',')})`);

  // PR-14: pin the cheapest model explicitly (never inherit last-used) and
  // assert the picker verified it — a silent fallback to a pricier model fails.
  const selection = await selectModelsForRun(browserService, active, { policy: MODEL_POLICY });
  for (const m of active) {
    const cheapest = testModelFor(m);
    assertInto(details, pinnedTo(selection[m], cheapest),
      `${m}: cheapest "${cheapest}" selected + verified, NO fallback (${selection[m]?.evidence ?? selection[m]?.warning ?? 'no evidence'})`);
  }

  const round = await runConsensusRound(browserService, prompts, 1);
  markConsensusEnd();

  for (const m of active) {
    const page = browserService.getPage(m);
    const body = await page.innerText('body').catch(() => '');
    assertInto(details, body.includes(tokens[m]), `${m}: page contains own token`);
    for (const other of active) {
      if (other === m) continue;
      assertInto(details, !body.includes(tokens[other]), `${m}: page does NOT contain ${other}'s token`);
    }
    const out = round.outputs[m] || '';
    assertInto(details, out.includes(tokens[m]), `${m}: response echoes own token (${JSON.stringify(out.slice(0, 60))})`);
    // Since PR-2 failures live in round.errors, never as strings in outputs.
    assertInto(details, !(m in (round.errors || {})), `${m}: no send/wait/extract failure`);
  }
  await browserService.disconnect();
  return details;
}

/** Live: agreeable consensus — expect consensus_reached at round 2. */
export async function gateAgreeable(log) {
  const details = [];
  const usable = usableModels();
  if (!usable || usable.length < 2) return ['BLOCKED: needs gateLogins with >=2 usable models first'];

  await pauseBetweenConsensusRuns(log);
  log('opening fresh chats in all model tabs (stale-DOM guard)');
  await freshModelChats();
  const MAX_ROUNDS = 3;
  // The server sends to EVERY discovered model tab, not just usable ones —
  // charge whatever is actually open right now.
  const openNow = Object.keys(await openModelTabs());
  charge(openNow, MAX_ROUNDS);

  // Extended-thinking models routinely exceed the 120s default on
  // cross-pollination rounds — a slow think must not read as a hang here.
  const client = new McpClient({ testName: 'agreeable', env: responseTimeoutEnv('240000') });
  try {
    await client.initialize();
    const res = await client.callTool('start_consensus', {
      prompt: 'What is 2+2? Answer with just the number.',
      max_rounds: MAX_ROUNDS,
      model_policy: MODEL_POLICY, // PR-14: cheap-model regression run
    });
    assertInto(details, res.isError !== true, 'start_consensus accepted');
    const status = await pollStatus(client, { timeoutMs: 900000 });
    markConsensusEnd();
    assertInto(details, status.includes('consensus_reached'), `terminal status consensus_reached (${status.split('\n')[0]})`);

    const state = readStateFile(client);
    refund(openNow, MAX_ROUNDS - (state.rounds?.length || MAX_ROUNDS));
    // Cost proof (real, not a name echo): the PERSISTED selection must show
    // each provider verified on its cheapest with NO fallback. A regression
    // that inherits last-used or falls back to a pricier default fails here.
    for (const m of openNow) {
      const cheapest = testModelFor(m);
      assertInto(details, pinnedTo(state.models?.[m], cheapest),
        `${m}: run verified the cheapest model "${cheapest}", no silent upgrade (${state.models?.[m]?.evidence ?? state.models?.[m]?.warning ?? 'no record'})`);
    }
    const messaged = new Set((state.rounds || []).flatMap((r) => Object.keys(r.outputs || {})));
    assertInto(details, [...messaged].every((m) => openNow.includes(m)),
      `budget integrity: every messaged model was pre-charged (${[...messaged].join(',')})`);
    assertInto(details, state.currentRound === 2, `converged at round 2 (got ${state.currentRound})`);

    const { parseVerdict } = await import('../../tools/consensus.js');
    const lastRound = state.rounds[state.rounds.length - 1];
    const votes = Object.values(lastRound.outputs).map(parseVerdict).filter(Boolean);
    const agrees = votes.filter((v) => v === 'AGREE').length;
    assertInto(details, agrees >= 2, `>=2 line-anchored AGREE votes in final round (got ${agrees} of ${votes.length})`);
    const agreeOutputs = (state.rounds || []).flatMap((r) => Object.values(r.outputs || {}));
    assertInto(details, !agreeOutputs.some((o) => typeof o === 'string' && o.includes('Error:')),
      'quarantine: no Error: strings in any round outputs');
    assertInto(details, state.active === false, 'active flag reset');
    return details;
  } finally {
    await client.close();
  }
}

/** Offline: verdict-stripping holds against REAL persisted round data. */
export async function gateVerdictStrip(log) {
  const details = [];
  const stateFile = join(STATE_DIR, 'agreeable.json');
  if (!existsSync(stateFile)) return ['BLOCKED: run gateAgreeable first (needs its persisted rounds)'];
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assertInto(details, (state.rounds || []).length >= 2, `persisted rounds available (${state.rounds?.length})`);

  const { generateConsensusPrompt, parseVerdict } = await import('../../tools/consensus.js');
  for (const model of Object.keys(state.rounds[state.rounds.length - 1].outputs)) {
    const prompt = generateConsensusPrompt(state.originalPrompt, state.rounds, model);
    assertInto(details, parseVerdict(prompt) === null, `next-round prompt for ${model} has no parseable verdict`);
  }
  return details;
}

/** Live: forced timeouts must not crash the server or corrupt state. */
export async function gateTimeout(log) {
  const details = [];
  const usable = usableModels();
  if (!usable || usable.length < 2) return ['BLOCKED: needs gateLogins with >=2 usable models first'];

  await pauseBetweenConsensusRuns(log);
  log('opening fresh chats in all model tabs (stale-DOM guard)');
  await freshModelChats();
  const MAX_ROUNDS = 2;
  const openNow = Object.keys(await openModelTabs());
  charge(openNow, MAX_ROUNDS);

  const client = new McpClient({ testName: 'timeout', env: responseTimeoutEnv('8000') });
  try {
    await client.initialize();
    const res = await client.callTool('start_consensus', {
      prompt: 'Write a 200-word paragraph about how AI models reach consensus.',
      max_rounds: MAX_ROUNDS,
      model_policy: MODEL_POLICY,
    });
    assertInto(details, res.isError !== true, 'start_consensus accepted');
    const status = await pollStatus(client, { timeoutMs: 240000 });
    markConsensusEnd();
    assertInto(details, /max_rounds_reached|consensus_reached/.test(status), `terminal status sane (${status.split('\n')[0]})`);

    const state = readStateFile(client);
    refund(openNow, MAX_ROUNDS - (state.rounds?.length || MAX_ROUNDS));
    // Since PR-2, failures live in each round's errors map — never in outputs.
    // Match the timeout failure SPECIFICALLY — a login/selector failure also
    // lands in errors and must not fake this gate's evidence.
    const allErrors = (state.rounds || []).flatMap((r) => Object.values(r.errors || {}));
    const timedOut = allErrors.filter((e) => (e?.message || '').includes('Timeout waiting for response'));
    assertInto(details, timedOut.length >= 1, `>=1 model hit the response timeout specifically (got ${timedOut.length})`);
    assertInto(details, timedOut.every((e) => e.phase === 'wait'), 'timeout failures carry phase=wait');

    // PR-2 quarantine: no error text in outputs, none embedded in next prompts.
    const allOutputs = (state.rounds || []).flatMap((r) => Object.values(r.outputs || {}));
    assertInto(details, !allOutputs.some((o) => typeof o === 'string' && o.includes('Error:')),
      'quarantine: no Error: strings in any round outputs');
    const { generateConsensusPrompt } = await import('../../tools/consensus.js');
    const lastR = state.rounds[state.rounds.length - 1];
    const everyModel = [...new Set([...Object.keys(lastR.outputs || {}), ...Object.keys(lastR.errors || {})])];
    const cleanPrompts = everyModel.every((m) => {
      const p = generateConsensusPrompt(state.originalPrompt, state.rounds, m);
      return !p.includes('Error:') && !p.includes('Timeout waiting for response');
    });
    assertInto(details, everyModel.length > 0 && cleanPrompts, 'quarantine: embedded next-round prompts carry no error text');
    assertInto(details, state.active === false, 'active flag reset after failure-heavy run');

    const tools = await client.listTools();
    assertInto(details, tools.length >= 25, 'server responsive after timeout run');
    return details;
  } finally {
    await client.close();
  }
}

/** Chrome-free: a truncated state file must not break server boot (PR-4). */
export async function gateCorruptBoot(log) {
  const details = [];
  const stateFile = join(STATE_DIR, 'corruptboot.json');
  const corruptName = (f) => f.startsWith('corruptboot.json.corrupt-');
  // Stale artifacts from earlier runs must not satisfy this gate — require a
  // NEW quarantine file from THIS boot.
  const before = new Set(readdirSync(STATE_DIR).filter(corruptName));
  writeFileSync(stateFile, '{"active": true, "status": "runni');
  const client = new McpClient({ testName: 'corruptboot' });
  try {
    await client.initialize();
    const tools = await client.listTools();
    assertInto(details, tools.length >= 25, `server boots and lists tools despite corrupt state (${tools.length} tools)`);
    const status = await client.callTool('get_consensus_status', {});
    assertInto(details, status.isError !== true, 'get_consensus_status readable after quarantine');
    const fresh = readdirSync(STATE_DIR).filter(corruptName).filter((f) => !before.has(f));
    assertInto(details, fresh.length >= 1, `a NEW quarantine file appeared this boot (${fresh.join(',') || 'none'})`);
    assertInto(details, !existsSync(stateFile), 'corrupt original renamed away');
  } finally {
    await client.close();
  }
  return details;
}

/** Live: single-flight — a second start_consensus while one runs must isError (PR-4). */
export async function gateDoubleStart(log) {
  const details = [];
  const usable = usableModels();
  if (!usable || usable.length < 2) return ['BLOCKED: needs gateLogins with >=2 usable models first'];

  await pauseBetweenConsensusRuns(log);
  log('opening fresh chats in all model tabs (stale-DOM guard)');
  await freshModelChats();
  const MAX_ROUNDS = 2;
  const openNow = Object.keys(await openModelTabs());
  charge(openNow, MAX_ROUNDS);

  const client = new McpClient({ testName: 'doublestart', env: responseTimeoutEnv('240000') });
  try {
    await client.initialize();
    const first = await client.callTool('start_consensus', {
      prompt: 'What is 5+5? Answer with just the number.',
      max_rounds: MAX_ROUNDS,
      model_policy: MODEL_POLICY,
    });
    assertInto(details, first.isError !== true, 'first start_consensus accepted');
    const second = await client.callTool('start_consensus', {
      prompt: 'What is 6+6? Answer with just the number.',
      max_rounds: MAX_ROUNDS,
      model_policy: MODEL_POLICY,
    });
    assertInto(details, second.isError === true, 'second start_consensus while active returns isError (single-flight)');
    const status = await pollStatus(client, { timeoutMs: 900000 });
    markConsensusEnd();
    assertInto(details, /consensus_reached|max_rounds_reached/.test(status), `first run completed normally (${status.split('\n')[0]})`);
    const state = readStateFile(client);
    refund(openNow, MAX_ROUNDS - (state.rounds?.length || MAX_ROUNDS));
    assertInto(details, state.originalPrompt?.includes('5+5'), 'persisted state belongs to the FIRST run (second never started)');
    assertInto(details, state.active === false, 'active flag reset');
  } finally {
    await client.close();
  }
  return details;
}

/** Live: cold start — NO Chrome running; the server must auto-launch it,
 * auto-open the model tabs, and complete a round on intact logins (PR-3). */
export async function gateColdStart(log) {
  const details = [];
  if (await cdpReady(1000)) {
    return ['BLOCKED: a Chrome already serves :9222 — cold start needs a cold port'];
  }

  await pauseBetweenConsensusRuns(log);
  const models = providerNames();
  charge(models, 1);

  const profile = join(homedir(), '.auto-browser', 'chrome-profile');
  const client = new McpClient({
    testName: 'coldstart',
    env: {
      CHROME_USER_DATA: profile,
      AUTO_LAUNCH_CHROME: '1',
      ...responseTimeoutEnv('240000'),
    },
  });
  try {
    await client.initialize();
    // Cold connect = Chrome launch (<=45s) + 3 tab loads (30s goto + 3s
    // settle each) — far past the client's 30s default RPC timeout.
    const conn = await client.callTool('connect_browser', {}, 240000);
    assertInto(details, conn.isError !== true, 'connect_browser succeeded from a cold port');
    const connText = conn.content?.[0]?.text || '';
    const found = models.filter((m) => connText.includes(m));
    assertInto(details, found.length === models.length, `all ${models.length} model tabs present after auto-launch (${connText.trim()})`);

    // The RPC blocks for the whole round; ceiling is 240s per model.
    const round = await client.callTool('send_single_round', {
      prompt: 'What is 3+3? Answer with just the number.',
      model_policy: MODEL_POLICY,
    }, 300000);
    assertInto(details, round.isError !== true, 'send_single_round succeeded');
    const text = round.content?.[0]?.text || '';
    const answered = models.filter((m) => {
      const section = text.match(new RegExp(`=== ${m.toUpperCase()} ===\\n([\\s\\S]*?)(?=\\n=== |$)`));
      return section && section[1].includes('6');
    });
    assertInto(details, answered.length >= 2, `>=2 models answered 6 — logins survived (got ${answered.length}: ${answered.join(',')})`);
    assertInto(details, !text.includes('Error:'), 'no error text in round output');

    // The server's Chrome is detached and would outlive the server as an
    // unowned orphan — adopt it so cleanup and re-runs work.
    const adopted = await adoptRunningChrome(profile);
    details.push(adopted
      ? 'PASS: auto-launched Chrome adopted as harness-owned (cleanup enabled)'
      : 'WARN: could not adopt auto-launched Chrome — stop it manually before re-running');
  } finally {
    markConsensusEnd(); // messages may have been sent even on a thrown RPC
    await client.close();
  }
  return details;
}

/** Live: 3-round consensus with oversized answers — cross-pollination must
 * compress peer text while mechanics stay correct; health_check must surface
 * the new observability (PR-5). */
export async function gateCompression(log) {
  const details = [];
  const usable = usableModels();
  if (!usable || usable.length < 2) return ['BLOCKED: needs gateLogins with >=2 usable models first'];

  await pauseBetweenConsensusRuns(log);
  log('opening fresh chats in all model tabs (stale-DOM guard)');
  await freshModelChats();
  const MAX_ROUNDS = 3;
  const openNow = Object.keys(await openModelTabs());
  charge(openNow, MAX_ROUNDS);

  const client = new McpClient({ testName: 'compression', env: responseTimeoutEnv('240000') });
  try {
    await client.initialize();
    const res = await client.callTool('start_consensus', {
      prompt: 'Write a thorough essay of at least 800 words arguing for either tabs or spaces for code indentation — pick exactly one side. This doubles as a length test: do NOT summarize or shorten; produce the full essay.',
      max_rounds: MAX_ROUNDS,
      model_policy: MODEL_POLICY,
    });
    assertInto(details, res.isError !== true, 'start_consensus accepted');
    const status = await pollStatus(client, { timeoutMs: 1200000 });
    assertInto(details, /consensus_reached|max_rounds_reached/.test(status), `terminal status sane (${status.split('\n')[0]})`);

    const state = readStateFile(client);
    refund(openNow, MAX_ROUNDS - (state.rounds?.length || MAX_ROUNDS));
    assertInto(details, (state.rounds?.length || 0) >= 2, `>=2 rounds ran (${state.rounds?.length})`);

    // Compression evidence: regenerate next-round prompts from the REAL
    // persisted round-1 outputs with the same exported function the server
    // used, and show the length delta.
    const { generateConsensusPrompt, parseVerdict } = await import('../../tools/consensus.js');
    const r1 = state.rounds[0];
    let compressedSeen = false;
    for (const model of Object.keys(r1.outputs || {})) {
      const peers = Object.keys(r1.outputs).filter((m) => m !== model);
      const rawPeerChars = peers.reduce((n, m) => n + (r1.outputs[m]?.length || 0), 0);
      if (rawPeerChars <= peers.length * 2000) continue;
      compressedSeen = true;
      const p = generateConsensusPrompt(state.originalPrompt, [r1], model);
      assertInto(details, p.includes('condensed'), `${model}: oversized peers carry the condensed marker`);
      assertInto(details, p.length < rawPeerChars, `${model}: prompt ${p.length} chars < raw peer text ${rawPeerChars} chars`);
      assertInto(details, parseVerdict(p) === null, `${model}: compressed prompt not verdict-parseable`);
    }
    if (!compressedSeen) {
      // Not a product failure — the live models answered short. BLOCK (not
      // FAIL) so a rerun with a longer prompt is the documented next step.
      const lens = Object.entries(r1.outputs || {}).map(([m, o]) => `${m}=${o?.length || 0}ch`).join(' ');
      details.push(`SKIP: live answers too short to exercise compression (${lens}) — rerun`);
    }
    assertInto(details, state.active === false, 'active flag reset');

    const health = await client.callTool('health_check', {});
    const htext = health.content?.[0]?.text || '';
    assertInto(details, htext.includes('Rate limits'), 'health_check surfaces rate-limit usage');
    assertInto(details, /: [1-9]\d*\//.test(htext), 'health_check shows nonzero send counts for this run');
    assertInto(details, htext.includes('Response latency'), 'health_check surfaces persisted latency stats');
  } finally {
    markConsensusEnd();
    await client.close();
  }
  return details;
}

/** Live: PR-9 drivers — ensureChat into the user-named project (PAUSE-P
 * supplies E2E_PROJECT_NAME + E2E_PROJECT_PROVIDERS), verified model
 * selection, a deliberately-missing project → typed project_not_found +
 * normal-chat fallback, and a 1-line round-trip INSIDE the project chat via
 * the production send path (send-verification live). Zero DR spend;
 * 1 message/provider. */
export async function gateDrivers(log) {
  const details = [];
  const projectName = process.env.E2E_PROJECT_NAME;
  if (!projectName) {
    return ['BLOCKED: PAUSE-P incomplete — set E2E_PROJECT_NAME (and optionally '
      + 'E2E_PROJECT_PROVIDERS=claude,chatgpt / E2E_DRIVER_MODEL_<ID>) before running this gate'];
  }
  const projectProviders = (process.env.E2E_PROJECT_PROVIDERS || 'claude,chatgpt')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const unknownProviders = projectProviders.filter((p) => !providerNames().includes(p));
  if (unknownProviders.length > 0) {
    return [`BLOCKED: E2E_PROJECT_PROVIDERS names unknown provider(s): ${unknownProviders.join(', ')} `
      + `(known: ${providerNames().join(', ')})`];
  }

  const { getDriver } = await import('../../models/drivers/index.js');
  const { sendToModel, waitForComplete, getOutput } = await import('../../tools/consensus.js');
  const { SELECTORS } = await import('../../config.js');
  const { findAll } = await import('../../utils/selectors.js');
  const { browserService } = await import('../../services/browser-service.js');

  const models = providerNames();
  await pauseBetweenConsensusRuns(log);

  try {
    await browserService.connect();
    // Charge only providers whose tab exists — a missing tab sends nothing
    // and must not leak budget from the persistent ledger.
    const present = models.filter((m) => browserService.getPage(m));
    charge(present, 1); // one round-trip message per provider; ensureChat itself sends nothing
    for (const model of models) {
      const page = browserService.getPage(model);
      if (!assertInto(details, !!page, `${model}: tab present`)) continue;
      const driver = getDriver(model);
      const wantsProject = projectProviders.includes(model);
      const pick = process.env[`E2E_DRIVER_MODEL_${model.toUpperCase()}`];
      const modes = (process.env[`E2E_DRIVER_MODES_${model.toUpperCase()}`] || '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      // 1. ensureChat: named project (where it exists) + verified model pick
      //    + any PAUSE-P-approved mode toggles.
      const setup = await driver.ensureChat(page, {
        project: wantsProject ? projectName : undefined,
        model: pick || undefined,
        modes: Object.fromEntries(modes.map((m) => [m, true])),
      });
      const failedSteps = setup.steps.filter((s) => !s.ok)
        .map((s) => `${s.action}: ${s.evidence}`).join('; ');
      assertInto(details, setup.ok, `${model}: ensureChat ok${failedSteps ? ` (failed: ${failedSteps})` : ''}`);
      if (wantsProject) {
        assertInto(details, setup.verified.project?.ok === true,
          `${model}: chat verified INSIDE project "${projectName}" (${setup.verified.project?.evidence})`);
        assertInto(details, !setup.warnings.some((w) => w.code === 'project_not_found'),
          `${model}: no project_not_found for an existing project`);
      }
      if (pick) {
        assertInto(details, setup.verified.model?.ok === true,
          `${model}: model "${pick}" verified (${setup.verified.model?.evidence})`);
      }
      for (const mode of modes) {
        assertInto(details, setup.verified[`mode:${mode}`]?.ok === true,
          `${model}: mode "${mode}" verified (${setup.verified[`mode:${mode}`]?.evidence})`);
      }

      // 2. 1-line round-trip in THIS chat through the production send path.
      // Unique arithmetic, not "repeat this token": a token-echo instruction
      // inside a project context tripped Fable's safeguards live (chat
      // paused, no response) — benign math never does.
      const a = 1000 + Math.floor(Math.random() * 8000);
      const b = 1000 + Math.floor(Math.random() * 8000);
      const expected = String(a + b);
      const initial = (await findAll(page, SELECTORS[model].output)).length;
      let out = '';
      try {
        await sendToModel(browserService, model, `What is ${a}+${b}? Reply with just the number.`);
        const done = await waitForComplete(browserService, page, model, initial, 240000);
        assertInto(details, done.complete, `${model}: round-trip completed in ${done.time}ms`);
        if (done.complete) out = await getOutput(browserService, model);
      } catch (e) {
        assertInto(details, false, `${model}: round-trip failed (${e.message})`);
      }
      assertInto(details, out.includes(expected),
        `${model}: response contains ${a}+${b}=${expected} ("${out.slice(0, 80).replace(/\n/g, ' ')}")`);

      // 3. Missing project → typed warning + normal-chat fallback (0 sends);
      // leaves the tab on a fresh chat for the next provider run.
      const missing = await driver.ensureChat(page, {
        project: `zz-nonexistent-${randomBytes(3).toString('hex')}`,
      });
      assertInto(details, missing.warnings.some((w) => w.code === 'project_not_found'),
        `${model}: missing project yields typed project_not_found`);
      assertInto(details, missing.ok, `${model}: missing-project fallback lands in a usable chat`);
    }
  } finally {
    markConsensusEnd();
    await browserService.disconnect();
  }
  return details;
}

/** Live: PR-10 deep-research pipeline (PAUSE-DR approved, 2 DR spends). One
 * standard task routes to claude+chatgpt (NO gemini); the real runner drives
 * ensureChat+research+send, harvests each report via completion detection,
 * and writes artifacts. Asserts both complete with on-disk artifacts and the
 * quota ledger counted exactly one DR per provider. Long-running (DR is
 * 5–45 min/provider, parallel). */
export async function gateResearchDR(log) {
  const details = [];
  // Default claude+chatgpt (GATE 10); override with E2E_DR_PROVIDERS for
  // GATE 13 (e.g. "chatgpt,gemini" — skip a credit-limited Claude).
  const providers = (process.env.E2E_DR_PROVIDERS || 'claude,chatgpt')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const { submitBatch, statusTable, getTask, listTasks } = await import('../../research/research-queue.js');
  const { drainQueue } = await import('../../research/runner.js');
  const { quotaSnapshot } = await import('../../research/quota-ledger.js');
  const { acquireDrainLock, releaseDrainLock } = await import('../../research/lockfile.js');
  const { browserService } = await import('../../services/browser-service.js');
  const { existsSync, readFileSync } = await import('fs');

  const lock = acquireDrainLock();
  if (!lock.ok) return [`BLOCKED: a drain lock is held (pid ${lock.holder.pid}) — no gate DR while a runner is active`];

  await pauseBetweenConsensusRuns(log);
  charge(providers, 1); // each DR run sends exactly one prompt message

  const usedBefore = quotaSnapshot(providers);
  // gemini only gets a task slot via gemini_priority routing; drain only the
  // approved `providers`, leaving any other routed slot untouched (unspent).
  const geminiPriority = providers.includes('gemini');
  const { batch, taskIds } = submitBatch([{
    prompt: 'Research the release history of Node.js LTS versions. Produce a short report (a few paragraphs): list the major LTS lines with their release and end-of-life years, and note the current active LTS.',
    gemini_priority: geminiPriority,
  }]);
  const taskId = taskIds[0];
  const slots = getTask(taskId).providers;
  assertInto(details, providers.every((p) => slots.includes(p)),
    `task has slots for the DR providers ${providers.join('+')} (routed: ${slots.join(',')})`);
  log(`submitted DR batch ${batch} task ${taskId}; draining ${providers.join('+')}`);

  try {
    // Generous ceiling: a short LTS report should finish well inside 40 min.
    const summary = await drainQueue(browserService, {
      providers,
      batch,
      log,
      waitOpts: { timeoutMs: 40 * 60 * 1000, stableMs: 60 * 1000, pollMs: 8000 },
    });
    log(`drain summary: ${JSON.stringify(summary)}`);

    const task = getTask(taskId);
    for (const provider of providers) {
      const pp = task.perProvider[provider];
      assertInto(details, pp.status === 'complete',
        `${provider}: DR status complete (got ${pp.status}${pp.error ? ` — ${pp.error}` : ''}; chat ${pp.chatUrl})`);
      const hasArtifact = pp.artifactPath && existsSync(pp.artifactPath);
      assertInto(details, hasArtifact, `${provider}: artifact written (${pp.artifactPath})`);
      if (hasArtifact) {
        const body = readFileSync(pp.artifactPath, 'utf8');
        assertInto(details, body.length > 400 && /node/i.test(body),
          `${provider}: artifact is a real report (${body.length} chars, mentions Node)`);
        assertInto(details, existsSync(pp.artifactPath.replace(/\.md$/, '.meta.json')),
          `${provider}: meta.json written`);
      }
    }
    const usedAfter = quotaSnapshot(providers);
    for (const provider of providers) {
      assertInto(details, usedAfter[provider].used === usedBefore[provider].used + 1,
        `${provider}: exactly one DR spend counted (${usedBefore[provider].used}→${usedAfter[provider].used})`);
    }
  } finally {
    releaseDrainLock();
    await browserService.disconnect();
  }
  return details;
}

/** Live: PR-11 synthesis pipeline (normal-message spend only, ZERO DR).
 * Seeds two short reports for a task, then runs the real synthesis machinery
 * (compilation round + 1 verdict round over the drafts) and asserts a
 * coherent FINAL.md. Exercises the large-payload compilation send + verdict
 * rounds without spending deep-research quota. */
export async function gateSynthesize(log) {
  const details = [];
  const { submitBatch, getTask, markRunning, markSpent, recordChatUrl, markComplete, artifactPathFor } =
    await import('../../research/research-queue.js');
  const { synthesizeTask, finalPath } = await import('../../research/synthesis.js');
  const { browserService } = await import('../../services/browser-service.js');
  const { existsSync, readFileSync, mkdirSync, writeFileSync } = await import('fs');
  const { dirname } = await import('path');

  await browserService.connect();
  const active = browserService.getActiveModels();
  if (active.length < 2) return ['BLOCKED: synthesis needs ≥2 logged-in model tabs'];

  await pauseBetweenConsensusRuns(log);
  // Synthesis = 1 compilation round + up to 1 verdict round = ≤2 messages/site.
  charge(active, 2);

  // Seed two short, deliberately-divergent reports on the same topic.
  const { taskIds: [taskId] } = submitBatch([{ prompt: 'Summarize the Node.js LTS release cadence and how LTS lines are numbered.' }]);
  const seeds = {
    claude: '# Node.js LTS — report A\n\nNode.js cuts a new major release every 6 months (April and October). '
      + 'Even-numbered majors (18, 20, 22) enter Long-Term Support that October; odd majors never become LTS. '
      + 'Each LTS line gets ~30 months of support: roughly 12 months "Active LTS" then ~18 months "Maintenance". '
      + 'The scheme has been stable since Node 4 (2015).',
    chatgpt: '# Node.js LTS — report B\n\nNode releases follow a time-based model: a new major line twice a year. '
      + 'Only even majors are promoted to LTS (odd lines are "Current" only). An LTS line runs about 3 years total, '
      + 'split into Active and Maintenance phases. Numbering is sequential by major version; the codenames (e.g. '
      + '"Iron", "Hydrogen") track the LTS lines. The current active LTS is the most recent even major.',
  };
  const task = getTask(taskId);
  const seededProviders = active.filter((m) => seeds[m]).slice(0, 2);
  if (seededProviders.length < 2) {
    // fall back to seeding the first two active models with the two seed texts
    const texts = Object.values(seeds);
    seededProviders.length = 0;
    active.slice(0, 2).forEach((m, i) => { seeds[m] = texts[i]; seededProviders.push(m); });
  }
  for (const provider of seededProviders) {
    const path = artifactPathFor(task, provider);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seeds[provider]);
    markRunning(taskId, provider);
    markSpent(taskId, provider);
    recordChatUrl(taskId, provider, `https://seed/${provider}`);
    markComplete(taskId, provider, { artifactPath: path });
  }
  assertInto(details, getTask(taskId).perProvider[seededProviders[0]].status === 'complete',
    `seeded ${seededProviders.length} reports (${seededProviders.join(', ')})`);

  try {
    const res = await synthesizeTask(browserService, taskId, {
      maxVerdictRounds: 1,
      responseTimeoutMs: 240000,
    });
    assertInto(details, res.status === 'complete',
      `synthesis complete (status ${res.status}${res.reason ? `: ${res.reason}` : ''}, ${res.rounds} round(s))`);
    if (res.status === 'complete') {
      const body = readFileSync(finalPath(task), 'utf8');
      assertInto(details, body.length > 400, `FINAL.md is substantial (${body.length} chars)`);
      assertInto(details, /LTS/i.test(body) && /node/i.test(body), 'FINAL.md is on-topic (mentions Node LTS)');
      assertInto(details, !/^\s*VERDICT:\s*(AGREE|DISAGREE)\s*$/im.test(body), 'FINAL.md has verdict lines stripped');
      assertInto(details, existsSync(finalPath(task).replace(/FINAL\.md$/, 'FINAL.meta.json')), 'FINAL.meta.json written');
    }
  } finally {
    markConsensusEnd();
    await browserService.disconnect();
  }
  return details;
}

/**
 * Live: PR-14 GATE 14a — explicit per-task model selection, pinned cheapest.
 * Per provider: calibrate the live picker (drift warning), select the cheapest
 * model with picker-verified evidence, prove a 1-line round-trip on it, then a
 * deliberately-bogus model → typed model_unavailable warning + default used +
 * still round-trips. Finally a mixed-model consensus whose status must surface
 * the verified model names (a silent upgrade fails the gate). Cheap by design:
 * ≤2 msgs/provider for the per-provider proof + ≤2 rounds for the mixed run. */
export async function gateModelSelect(log) {
  const details = [];
  const usable = usableModels();
  if (!usable || usable.length < 1) return ['BLOCKED: needs gateLogins with >=1 usable model first'];

  const { getDriver } = await import('../../models/drivers/index.js');
  const { calibrateModels } = await import('../../models/drivers/common.js');
  const { sendToModel, waitForComplete, getOutput } = await import('../../tools/consensus.js');
  const { SELECTORS } = await import('../../config.js');
  const { findAll } = await import('../../utils/selectors.js');
  const { browserService } = await import('../../services/browser-service.js');

  await pauseBetweenConsensusRuns(log);
  await browserService.connect();
  const present = usable.filter((m) => browserService.getPage(m));
  // 2 round-trips per provider (cheapest proof + bogus-fallback proof).
  charge(present, 2);
  try {
    for (const model of present) {
      const page = browserService.getPage(model);
      const d = getProvider(model);
      if (!d.models) { details.push(`SKIP: ${model} has no models config — nothing to select`); continue; }
      const cheapest = testModelFor(model);
      const configuredDefault = d.models.default;

      // 1. Calibrate the live picker (the source of truth) + drift report.
      const cal = await calibrateModels(page, d);
      const drift = modelDriftReport(model, cal.choices);
      details.push(`${cal.ok ? 'PASS' : 'WARN'}: ${model} picker calibrated — ${cal.choices.length} models: ${cal.choices.join(' | ') || '(none)'}`);
      if (drift?.drifted) {
        details.push(`WARN: ${model} model drift vs registry — missing:[${drift.missing.join(', ')}] added:[${drift.added.join(', ')}]`);
      }
      assertInto(details, drift?.cheapestPresent === true,
        `${model}: cheapest "${cheapest}" is actually offered by the live picker`);

      // 2. Select cheapest, verify picker evidence, 1-line round-trip.
      const setup = await getDriver(model).ensureChat(page, { model: cheapest, modelFallback: configuredDefault });
      assertInto(details, setup.verified.model?.ok === true && !setup.warnings.some((w) => w.code === 'model_unavailable'),
        `${model}: cheapest "${cheapest}" selected + picker-verified, NO fallback (${setup.verified.model?.evidence})`);
      const a1 = 1000 + Math.floor(Math.random() * 8000);
      const b1 = 1000 + Math.floor(Math.random() * 8000);
      const exp1 = String(a1 + b1);
      const init1 = (await findAll(page, SELECTORS[model].output)).length;
      let out1 = '';
      try {
        await sendToModel(browserService, model, `What is ${a1}+${b1}? Reply with just the number.`);
        const done = await waitForComplete(browserService, page, model, init1, 240000);
        if (done.complete) out1 = await getOutput(browserService, model);
      } catch (e) { assertInto(details, false, `${model}: cheap-model round-trip failed (${e.message})`); }
      assertInto(details, out1.includes(exp1),
        `${model}: cheap-model round-trip answered ${a1}+${b1}=${exp1} ("${out1.slice(0, 60).replace(/\n/g, ' ')}")`);

      // 3. Bogus model → model_unavailable warning + configured default, still completes.
      const bogus = `zzmodel-${randomBytes(3).toString('hex')}`;
      const fb = await getDriver(model).ensureChat(page, { model: bogus, modelFallback: configuredDefault });
      assertInto(details, fb.warnings.some((w) => w.code === 'model_unavailable'),
        `${model}: bogus model "${bogus}" yields a typed model_unavailable warning`);
      assertInto(details, fb.verified.model?.ok === true,
        `${model}: fell back to the configured default "${configuredDefault}" (verified: ${fb.verified.model?.evidence})`);
      const a2 = 1000 + Math.floor(Math.random() * 8000);
      const b2 = 1000 + Math.floor(Math.random() * 8000);
      const exp2 = String(a2 + b2);
      const init2 = (await findAll(page, SELECTORS[model].output)).length;
      let out2 = '';
      try {
        await sendToModel(browserService, model, `What is ${a2}+${b2}? Reply with just the number.`);
        const done = await waitForComplete(browserService, page, model, init2, 240000);
        if (done.complete) out2 = await getOutput(browserService, model);
      } catch (e) { assertInto(details, false, `${model}: fallback round-trip failed (${e.message})`); }
      assertInto(details, out2.includes(exp2),
        `${model}: task still completes on the default after model_unavailable (${a2}+${b2}=${exp2})`);
    }
  } finally {
    markConsensusEnd();
    await browserService.disconnect();
  }

  // 4. Mixed-model consensus: each provider given an EXPLICIT named model
  // (via the models map, not a policy). The PERSISTED selection must show each
  // verified on the requested name with no fallback — asserted on state.models,
  // not a status name-echo (which prints the requested name regardless).
  const mixable = present.filter((m) => getProvider(m).models);
  if (mixable.length >= 2) {
    await pauseBetweenConsensusRuns(log);
    charge(mixable, 2);
    const client = new McpClient({ testName: 'modelselect', env: responseTimeoutEnv('240000') });
    try {
      await client.initialize();
      const mixed = Object.fromEntries(mixable.map((m) => [m, testModelFor(m)])); // explicit per-provider name (cheapest → cheap)
      const res = await client.callTool('start_consensus', {
        prompt: 'What is 2+2? Answer with just the number.',
        max_rounds: 2,
        models: mixed,
      });
      assertInto(details, res.isError !== true, 'mixed-model start_consensus accepted (explicit per-provider models map)');
      const status = await pollStatus(client, { timeoutMs: 600000 });
      markConsensusEnd();
      assertInto(details, /consensus_reached|max_rounds_reached/.test(status), `mixed-model run terminal (${status.split('\n')[0]})`);
      const state = JSON.parse(readFileSync(client.stateFile, 'utf8'));
      for (const m of mixable) {
        const name = mixed[m];
        assertInto(details, pinnedTo(state.models?.[m], name),
          `${m}: explicit model "${name}" verified with no fallback (${state.models?.[m]?.evidence ?? state.models?.[m]?.warning ?? 'no record'})`);
      }
      refund(mixable, 2 - (state.rounds?.length || 2));
    } finally {
      await client.close();
    }
  } else {
    details.push('SKIP: mixed-model consensus needs >=2 usable models');
  }
  return details;
}

export const GATES = {
  handshake: gateHandshake,
  validation: gateValidation,
  insufficient: gateInsufficient,
  logins: gateLogins,
  race: gateRace,
  agreeable: gateAgreeable,
  verdictstrip: gateVerdictStrip,
  timeout: gateTimeout,
  corruptboot: gateCorruptBoot,
  doublestart: gateDoubleStart,
  coldstart: gateColdStart,
  compression: gateCompression,
  drivers: gateDrivers,
  researchdr: gateResearchDR,
  synthesize: gateSynthesize,
  modelselect: gateModelSelect,
};

/** Spawn caffeinate for the duration of the process (live phases). */
export function startCaffeinate() {
  const child = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
  const stop = () => {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });
  return child;
}
