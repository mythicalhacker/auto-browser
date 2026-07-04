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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { McpClient, STATE_DIR } from './mcp-client.js';
import {
  ensureChrome, cdpReady, weSpawnedChrome, ensureModelTabs, openModelTabs,
  reduceModelTabsTo, loginStatus, MODEL_URLS,
} from './chrome.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_FILE = join(STATE_DIR, 'ledger.json');
const LOGINS_FILE = join(STATE_DIR, 'logins.json');
const LEDGER_LIMIT = 30; // hard per-site cap for the whole run
const PAUSE_MS = 120000; // minimum gap between consensus runs

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

  const { runConsensusRound } = await import('../../tools/consensus.js');
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
    assertInto(details, !out.startsWith('Error:'), `${m}: no send/wait error`);
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
  const MAX_ROUNDS = 3;
  // The server sends to EVERY discovered model tab, not just usable ones —
  // charge whatever is actually open right now.
  const openNow = Object.keys(await openModelTabs());
  charge(openNow, MAX_ROUNDS);

  const client = new McpClient({ testName: 'agreeable' });
  try {
    await client.initialize();
    const res = await client.callTool('start_consensus', {
      prompt: 'What is 2+2? Answer with just the number.',
      max_rounds: MAX_ROUNDS,
    });
    assertInto(details, res.isError !== true, 'start_consensus accepted');
    const status = await pollStatus(client);
    markConsensusEnd();
    assertInto(details, status.includes('consensus_reached'), `terminal status consensus_reached (${status.split('\n')[0]})`);

    const state = readStateFile(client);
    refund(openNow, MAX_ROUNDS - (state.rounds?.length || MAX_ROUNDS));
    const messaged = new Set((state.rounds || []).flatMap((r) => Object.keys(r.outputs || {})));
    assertInto(details, [...messaged].every((m) => openNow.includes(m)),
      `budget integrity: every messaged model was pre-charged (${[...messaged].join(',')})`);
    assertInto(details, state.currentRound === 2, `converged at round 2 (got ${state.currentRound})`);

    const { parseVerdict } = await import('../../tools/consensus.js');
    const lastRound = state.rounds[state.rounds.length - 1];
    const votes = Object.values(lastRound.outputs).map(parseVerdict).filter(Boolean);
    const agrees = votes.filter((v) => v === 'AGREE').length;
    assertInto(details, agrees >= 2, `>=2 line-anchored AGREE votes in final round (got ${agrees} of ${votes.length})`);
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
  const MAX_ROUNDS = 2;
  const openNow = Object.keys(await openModelTabs());
  charge(openNow, MAX_ROUNDS);

  const client = new McpClient({ testName: 'timeout', env: { TIMEOUT_RESPONSE: '8000' } });
  try {
    await client.initialize();
    const res = await client.callTool('start_consensus', {
      prompt: 'Write a 200-word paragraph about how AI models reach consensus.',
      max_rounds: MAX_ROUNDS,
    });
    assertInto(details, res.isError !== true, 'start_consensus accepted');
    const status = await pollStatus(client, { timeoutMs: 240000 });
    markConsensusEnd();
    assertInto(details, /max_rounds_reached|consensus_reached/.test(status), `terminal status sane (${status.split('\n')[0]})`);

    const state = readStateFile(client);
    refund(openNow, MAX_ROUNDS - (state.rounds?.length || MAX_ROUNDS));
    const allOutputs = (state.rounds || []).flatMap((r) => Object.values(r.outputs || {}));
    // Match the timeout failure SPECIFICALLY — a login/selector failure also
    // stringifies as 'Error: ...' and must not fake this gate's evidence.
    const timedOut = allOutputs.filter((o) => typeof o === 'string' && o.includes('Timeout waiting for response'));
    assertInto(details, timedOut.length >= 1, `>=1 model hit the response timeout specifically (got ${timedOut.length})`);
    assertInto(details, state.active === false, 'active flag reset after failure-heavy run');

    const tools = await client.listTools();
    assertInto(details, tools.length >= 25, 'server responsive after timeout run');
    return details;
  } finally {
    await client.close();
  }
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
