// tools/consensus.js — Consensus workflow, state persistence, and tool definitions
import { writeFileSync, readFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import { ConsensusBarrier } from "../utils/barrier.js";
import { findFirst, findAll } from "../utils/selectors.js";
import { CONFIG, SELECTORS } from "../config.js";
import { getHealthReport, formatHealthReport } from "../utils/health-check.js";
import { compressForCrossPollination } from "../utils/context-compression.js";
import { checkLogin } from "../utils/login-check.js";
import { recordUsage } from "../utils/rate-limiter.js";
import { recordRound } from "../utils/latency-stats.js";

// Module-scoped consensus state
let consensusState = {
  active: false,
  originalPrompt: null,
  currentRound: 0,
  maxRounds: 5,
  rounds: [],
  finalConsensus: null,
  status: "idle"
};

// In-process marker for the currently running workflow. Authoritative while
// this process lives: gates single-flight and blocks loadState's object
// identity swap mid-run (status reads must see the live run, not the disk).
let runActive = false;

function saveState() {
  // Default state path lives under ~/.auto-browser — ensure the dir exists.
  mkdirSync(dirname(CONFIG.stateFile), { recursive: true });
  // Temp-file + rename: a crash mid-write can never leave a truncated
  // consensus_state.json (rename is atomic for same-volume paths).
  const tmp = `${CONFIG.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(consensusState, null, 2));
  renameSync(tmp, CONFIG.stateFile);
}

function loadState() {
  if (runActive) return; // the in-memory run is the truth — never swap it out
  if (!existsSync(CONFIG.stateFile)) return;
  try {
    consensusState = JSON.parse(readFileSync(CONFIG.stateFile, 'utf8'));
  } catch (e) {
    // Corrupt state (crash mid-write predating atomic saves, manual edits):
    // quarantine it and start fresh rather than crashing every boot.
    const quarantine = `${CONFIG.stateFile}.corrupt-${Date.now()}`;
    try {
      renameSync(CONFIG.stateFile, quarantine);
      console.error(`[state] corrupt state file quarantined to ${quarantine}: ${e.message}`);
    } catch (renameErr) {
      console.error(`[state] corrupt state file could not be quarantined: ${renameErr.message}`);
    }
  }
}

// --- Core consensus functions (receive browserService via parameter) ---

export async function sendToModel(browserService, model, prompt) {
  const page = browserService.getPage(model);
  if (!page) throw new Error(`${model} tab not found`);
  const sel = SELECTORS[model];

  await page.keyboard.press("Escape");
  await page.waitForTimeout(CONFIG.timeouts.microDelay);

  const inputMatch = await findFirst(page, sel.input);
  if (!inputMatch) throw new Error(`${model}: no input element found`);
  await inputMatch.element.click({ force: true });
  await page.waitForTimeout(CONFIG.timeouts.microDelay);

  // insertText avoids the OS clipboard: parallel sends can't cross-paste each
  // other's prompts, background tabs don't need document focus, and there is
  // no platform-specific paste shortcut. Unlike page.type, embedded newlines
  // are inserted as text rather than triggering submit.
  await page.keyboard.insertText(prompt);
  // Give the UI framework a tick to process the input event and enable the
  // send button — the submit selectors don't exclude disabled buttons and
  // click({force}) on a disabled button is a silent no-op.
  await page.waitForTimeout(CONFIG.timeouts.microDelay);

  const submitMatch = await findFirst(page, sel.submit);
  if (submitMatch) await submitMatch.element.click({ force: true });
  else await page.keyboard.press("Enter");

  recordUsage(model); // per-platform send counter, surfaced in health_check
  return true;
}

export async function waitForComplete(browserService, page, model, initialCount, timeout = null) {
  const sel = SELECTORS[model];
  // Per-call override > per-model config > generic default. Extended-thinking
  // models legitimately take minutes to respond; a slow think must not be
  // misread as a hang (see config.timeouts.responseByModel).
  const limit = timeout ?? CONFIG.timeouts.responseByModel?.[model] ?? CONFIG.timeouts.response;
  const start = Date.now();

  while (Date.now() - start < limit) {
    const elements = await findAll(page, sel.output);
    if (elements.length > initialCount) {
      const streamMatch = await findFirst(page, sel.streaming);
      const isStreaming = streamMatch && await streamMatch.element.isVisible().catch(() => false);

      if (!isStreaming) {
        await page.waitForTimeout(CONFIG.timeouts.stabilityCheck);
        const stillMatch = await findFirst(page, sel.streaming);
        const stillActive = stillMatch && await stillMatch.element.isVisible().catch(() => false);
        if (!stillActive) {
          return { complete: true, time: Date.now() - start };
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  return { complete: false, time: limit };
}

export async function getOutput(browserService, model) {
  const page = browserService.getPage(model);
  if (!page) throw new Error(`${model} tab not found`);
  const els = await findAll(page, SELECTORS[model].output);
  if (els.length === 0) throw new Error("No output found");
  let text = (await els[els.length - 1].innerText()).trim();

  // ChatGPT thinking-mode workaround: response DOM empties after streaming.
  // A page reload forces React to re-render from server state.
  if (!text && model === 'chatgpt') {
    console.error('[getOutput] ChatGPT returned empty text, reloading page to recover...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    const freshEls = await findAll(page, SELECTORS[model].output);
    if (freshEls.length === 0) throw new Error("No output found after reload");
    text = (await freshEls[freshEls.length - 1].innerText()).trim();
    if (!text) throw new Error("ChatGPT response still empty after reload");
  }

  return text;
}

export async function runConsensusRound(browserService, prompts, roundNum, opts = {}) {
  const activeModels = browserService.getActiveModels();
  const barrier = new ConsensusBarrier(activeModels);

  // Normalize prompts: if string, make object with same prompt for all
  const modelPrompts = typeof prompts === 'string'
    ? Object.fromEntries(activeModels.map(m => [m, prompts]))
    : prompts;

  const roundData = {
    round: roundNum,
    prompts: {},
    outputs: {},
    errors: {},
    timing: {},
    startTime: Date.now()
  };

  // Per-round login gate: fail fast ONLY on the strong signal — the tab is
  // sitting on a login/auth URL. A missed input selector is inconclusive
  // (a mid-navigation page transiently has none), so those proceed and let
  // the send path decide with its own settle-then-find sequence.
  await Promise.all(activeModels.map(async (model) => {
    try {
      const { loggedIn, reason } = await checkLogin(browserService.getPage(model), model);
      if (!loggedIn && reason.startsWith('URL contains login pattern')) {
        barrier.markFailed(model, `login_expired: ${reason}`, 'login');
      }
    } catch {
      // the check itself failing is not evidence — let the send path decide
    }
  }));

  // Get initial output counts before sending (pre-capture)
  const initial = {};
  for (const model of activeModels) {
    roundData.prompts[model] = (modelPrompts[model] || "").substring(0, 200) + "...";
    if (barrier.failed.has(model)) continue;
    initial[model] = (await findAll(browserService.getPage(model), SELECTORS[model].output)).length;
  }

  // Send to all in parallel
  await Promise.all(activeModels.map(async (model) => {
    if (barrier.failed.has(model)) return;
    try {
      await sendToModel(browserService, model, modelPrompts[model]);
    } catch (e) {
      barrier.markFailed(model, e.message, 'send');
    }
  }));

  // Wait for completions — this Promise.all IS the round barrier: every
  // model is marked complete or failed by the time it resolves.
  await Promise.all(activeModels.map(async (model) => {
    if (barrier.failed.has(model)) return;
    let result;
    try {
      result = await waitForComplete(browserService, browserService.getPage(model), model, initial[model], opts.responseTimeoutMs ?? null);
    } catch (e) {
      barrier.markFailed(model, e.message, 'wait');
      return;
    }
    if (!result.complete) {
      barrier.markFailed(model, "Timeout waiting for response", 'wait');
      return;
    }
    try {
      const output = await getOutput(browserService, model);
      barrier.markComplete(model, output);
    } catch (e) {
      barrier.markFailed(model, e.message, 'extract');
    }
  }));

  const barrierResults = barrier.getResults();
  roundData.outputs = barrierResults.outputs;
  roundData.errors = barrierResults.errors;
  roundData.timing = barrierResults.timing;
  recordRound(barrierResults); // persist latency samples + timeout counts

  roundData.endTime = Date.now();
  roundData.duration = roundData.endTime - roundData.startTime;

  return roundData;
}

// Per-peer embed budget for cross-pollination (matches context-compression's
// default). Compression triggers only when combined peer text exceeds
// peers × this budget.
const MAX_PEER_CHARS = 2000;

export function generateConsensusPrompt(originalPrompt, rounds, excludeModel = null) {
  const lastRound = rounds[rounds.length - 1];

  // Filter out the excluded model's response (cross-pollination)
  const otherModels = Object.entries(lastRound.outputs)
    .filter(([model]) => model !== excludeModel && lastRound.outputs[model]);

  // Strip peers' verdict lines before embedding: otherwise round-3+ prompts
  // carry parseable "VERDICT: X" lines that a quoting model could feed back
  // into parseVerdict as a spurious vote. Stripping runs BEFORE compression
  // so a truncated tail can never resurrect a verdict line.
  const stripped = {};
  for (const [model, output] of otherModels) {
    stripped[model] = stripVerdictLines(output) || "No response";
  }

  // Compress only genuinely oversized peer text (deep-research-length
  // answers would otherwise blow up round prompts); short answers
  // cross-pollinate verbatim. Head+tail survive; the middle is condensed.
  const combined = Object.values(stripped).reduce((n, t) => n + t.length, 0);
  const peerTexts = combined > otherModels.length * MAX_PEER_CHARS
    ? compressForCrossPollination(stripped, excludeModel, MAX_PEER_CHARS)
    : stripped;

  // Strip AGAIN after compression: a tail cut can begin at a mid-line
  // "VERDICT: ..." mention, manufacturing a line anchor the first pass
  // could not see (verified live-reproducible by review).
  for (const model of Object.keys(peerTexts)) {
    peerTexts[model] = stripVerdictLines(peerTexts[model]) || "No response";
  }

  const responsesText = Object.entries(peerTexts).map(([model, text]) =>
    `=== ${model.toUpperCase()} ===\n${text}`
  ).join('\n\n');

  const modelCount = otherModels.length;

  // Failed peers are OMITTED from the response blocks: never their error text
  // (peers cast DISAGREE against a timeout message — observed live), and
  // never a look-alike answer block a peer could judge as a non-answer and
  // dissent against either. One neutral note OUTSIDE the answer structure
  // keeps models from guessing why a peer vanished; not verdict-parseable.
  const failedPeers = Object.keys(lastRound.errors || {}).filter((m) => m !== excludeModel);
  const failureNote = failedPeers.length > 0
    ? `\n\n(Note: ${failedPeers.join(', ')} did not respond this round. Judge only the responses shown above.)`
    : '';

  let prompt = `CONSENSUS REVIEW - Round ${rounds.length + 1}

ORIGINAL REQUEST:
${originalPrompt}

RESPONSES FROM ${modelCount} OTHER AI MODEL${modelCount === 1 ? '' : 'S'}:

${responsesText}${failureNote}

---

YOUR TASK:
1. Analyze where the responses AGREE
2. Identify where they DISAGREE or have different approaches
3. Synthesize the BEST elements from each response
4. Provide your IMPROVED version that incorporates the strongest points
5. Finish with your verdict as the last line of your response, on its own line,
   formatted exactly as "VERDICT: X" — where X is the single word AGREE if the
   responses above all make substantially the same recommendation as yours, or
   the single word DISAGREE if meaningful differences remain.

Provide your response now:`;

  return prompt;
}

// A verdict only counts on its own line: instruction echoes ("VERDICT: X"),
// prose mentions, and barrier error strings can never match. AGREE must be a
// bare line — a hedged AGREE ("AGREE if...") is an abstention. DISAGREE
// tolerates a trailing clause ("DISAGREE — differences remain") because
// dropping a hedged dissent could flip a round into false consensus.
const AGREE_RE = /^\s*[*_`"']*VERDICT\s*:\s*[*_`"']*AGREE[*_`"'.!\s]*$/i;
const DISAGREE_RE = /^\s*[*_`"']*VERDICT\s*:\s*[*_`"']*DISAGREE\b/i;

export function parseVerdict(output) {
  if (typeof output !== "string") return null;
  let verdict = null;
  for (const line of output.split("\n")) {
    if (AGREE_RE.test(line)) verdict = "AGREE"; // last verdict line wins
    else if (DISAGREE_RE.test(line)) verdict = "DISAGREE";
  }
  return verdict;
}

export function stripVerdictLines(output) {
  if (typeof output !== "string") return output;
  return output
    .split("\n")
    .filter(line => !AGREE_RE.test(line) && !DISAGREE_RE.test(line))
    .join("\n")
    .trim();
}

/**
 * Consensus over the full rounds history (not just the current round):
 * current-round responders vote via their verdict lines; a model that FAILED
 * the current round but whose last cast vote was DISAGREE keeps blocking
 * (dissent is sticky across failures — a dissenter's timeout must not flip a
 * split round into consensus). A carried AGREE is NOT counted: agreement has
 * to come from a live response. Failed never-voters are pure abstentions.
 */
export function checkConsensusReached(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return false;
  const current = rounds[rounds.length - 1];

  const votes = [];
  for (const output of Object.values(current.outputs || {})) {
    const v = parseVerdict(output);
    if (v) votes.push(v);
  }

  for (const model of Object.keys(current.errors || {})) {
    for (let i = rounds.length - 2; i >= 0; i--) {
      const carried = parseVerdict(rounds[i].outputs?.[model]);
      if (carried) {
        if (carried === "DISAGREE") votes.push("DISAGREE");
        break; // last cast vote found — a carried AGREE contributes nothing
      }
    }
  }

  return votes.length >= 2 && votes.every(v => v === "AGREE");
}

async function runFullConsensus(browserService, originalPrompt, maxRounds = 5, responseTimeoutMs = null) {
  consensusState = {
    active: true,
    originalPrompt,
    currentRound: 0,
    maxRounds,
    rounds: [],
    finalConsensus: null,
    status: "running"
  };
  saveState();

  await browserService.connect();

  // Consensus needs at least 2 voters; with fewer, checkConsensusReached can
  // never pass and every round would be wasted against an unwinnable setup.
  const initialModels = browserService.getActiveModels();
  if (initialModels.length < 2) {
    consensusState.status = `insufficient_models: found ${initialModels.length} model tab(s), need at least 2`;
    consensusState.active = false;
    saveState();
    return consensusState;
  }

  // Round 1: Send original prompt
  consensusState.status = "round_1_sending";
  saveState();

  const round1 = await runConsensusRound(browserService, originalPrompt, 1, { responseTimeoutMs });
  consensusState.rounds.push(round1);
  consensusState.currentRound = 1;
  saveState();

  // Subsequent rounds - with cross-pollination (each model sees OTHER models' responses)
  for (let i = 2; i <= maxRounds; i++) {
    consensusState.status = `round_${i}_sending`;
    saveState();

    // Generate DIFFERENT prompts for each model (cross-pollination)
    // Each model sees responses from OTHER models, not its own
    const activeModels = browserService.getActiveModels();
    const roundPrompts = {};
    for (const model of activeModels) {
      roundPrompts[model] = generateConsensusPrompt(originalPrompt, consensusState.rounds, model);
    }

    const roundData = await runConsensusRound(browserService, roundPrompts, i, { responseTimeoutMs });
    consensusState.rounds.push(roundData);
    consensusState.currentRound = i;

    // Check the round that was just asked for verdicts — round 1 carries no
    // verdict instruction, and checking after the send counts the final
    // round's votes too. Pass the whole history: dissent carry-forward needs
    // failed models' prior votes.
    const reached = checkConsensusReached(consensusState.rounds);
    if (reached) {
      consensusState.status = "consensus_reached";
      consensusState.finalConsensus = roundData.outputs;
    }
    saveState();
    if (reached) break;
  }

  if (consensusState.status !== "consensus_reached") {
    consensusState.status = "max_rounds_reached";
    consensusState.finalConsensus = consensusState.rounds[consensusState.rounds.length - 1].outputs;
  }

  consensusState.active = false;
  saveState();

  return consensusState;
}

function getStatusSummary() {
  loadState();

  let summary = `Status: ${consensusState.status}\n`;
  summary += `Rounds completed: ${consensusState.currentRound}/${consensusState.maxRounds}\n`;

  if (consensusState.rounds.length > 0) {
    const lastRound = consensusState.rounds[consensusState.rounds.length - 1];
    summary += `\nLast round timing:\n`;
    for (const [model, time] of Object.entries(lastRound.timing || {})) {
      summary += `  ${model}: ${(time/1000).toFixed(1)}s\n`;
    }

    summary += `\nLast round output lengths:\n`;
    for (const [model, output] of Object.entries(lastRound.outputs || {})) {
      summary += `  ${model}: ${output?.length || 0} chars\n`;
    }

    const lastErrors = Object.entries(lastRound.errors || {});
    if (lastErrors.length > 0) {
      summary += `\nLast round failures:\n`;
      for (const [model, e] of lastErrors) {
        summary += `  ${model}: ${e.message} (${e.phase})\n`;
      }
    }
  }

  return summary;
}

function getFullResults() {
  loadState();

  let result = `# Consensus Results\n\n`;
  result += `Original prompt: ${consensusState.originalPrompt?.substring(0, 100)}...\n`;
  result += `Status: ${consensusState.status}\n`;
  result += `Total rounds: ${consensusState.currentRound}\n\n`;

  for (const round of consensusState.rounds) {
    result += `## Round ${round.round}\n`;
    result += `Duration: ${(round.duration/1000).toFixed(1)}s\n\n`;

    for (const [model, output] of Object.entries(round.outputs)) {
      result += `### ${model.toUpperCase()}\n`;
      result += `${output}\n\n`;
    }
    for (const [model, e] of Object.entries(round.errors || {})) {
      result += `### ${model.toUpperCase()} — FAILED (${e.phase})\n`;
      result += `${e.message}\n\n`;
    }
    result += `---\n\n`;
  }

  return result;
}

// --- Tool definitions ---

const CONSENSUS_TOOLS = [
  {
    name: "start_consensus",
    description: "Start autonomous consensus workflow. Sends prompt to all 3 models, waits for complete responses, generates comparison, repeats until consensus. Runs in background - check status with get_consensus_status.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task/prompt to reach consensus on" },
        max_rounds: { type: "integer", default: 5, minimum: 2, maximum: 10, description: "Maximum iteration rounds (2-10)" },
        response_timeout_ms: { type: "integer", minimum: 1000, maximum: 7200000, description: "Per-response wait ceiling in ms for this run (deep-research prompts need far longer than chat). Default: per-model config (TIMEOUT_RESPONSE_<MODEL>)." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "get_consensus_status",
    description: "Check current consensus workflow status and progress",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_consensus_results",
    description: "Get full results from completed or in-progress consensus workflow",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_last_round",
    description: "Get just the last round's outputs",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "connect_browser",
    description: "Connect to Chrome debug port",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "send_single_round",
    description: "Send prompt to all 3 models and wait for responses (single round, no iteration)",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        response_timeout_ms: { type: "integer", minimum: 1000, maximum: 7200000, description: "Per-response wait ceiling in ms. Default: per-model config (TIMEOUT_RESPONSE_<MODEL>)." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "health_check",
    description: "Check system health: Chrome connection, model tabs, login status, memory usage, uptime",
    inputSchema: { type: "object", properties: {} }
  }
];

export const CONSENSUS_TOOL_NAMES = new Set(CONSENSUS_TOOLS.map(t => t.name));

export function getConsensusToolDefinitions() {
  return CONSENSUS_TOOLS;
}

// The MCP SDK does not enforce inputSchema — validate args before use.
function requirePrompt(args, toolName) {
  if (typeof args?.prompt !== "string" || !args.prompt.trim()) {
    throw new Error(`${toolName} requires a non-empty 'prompt' string`);
  }
}

// Optional per-call response ceiling; null means "use per-model config".
// Number() coercion keeps numeric strings working, like max_rounds.
function parseResponseTimeoutMs(args) {
  if (args?.response_timeout_ms == null) return null;
  const v = Number(args.response_timeout_ms);
  if (!Number.isInteger(v) || v < 1000 || v > 7200000) {
    throw new Error("'response_timeout_ms' must be an integer between 1000 (1s) and 7200000 (2h)");
  }
  return v;
}

export async function handleConsensusToolCall(name, args, browserService) {
  if (!CONSENSUS_TOOL_NAMES.has(name)) return null;

  switch (name) {
    case "connect_browser":
      await browserService.connect();
      const found = browserService.getActiveModels();
      return { content: [{ type: "text", text: `Connected. Found: ${found.join(", ")}` }] };

    case "start_consensus": {
      requirePrompt(args, "start_consensus");
      // Number() coercion keeps numeric strings working — MCP clients often
      // emit numbers as strings. Minimum is 2: a 1-round run can't iterate
      // and never evaluates consensus (that's send_single_round).
      const maxRounds = args.max_rounds == null ? 5 : Number(args.max_rounds);
      if (!Number.isInteger(maxRounds) || maxRounds < 2 || maxRounds > 10) {
        throw new Error("'max_rounds' must be an integer between 2 and 10");
      }
      const responseTimeoutMs = parseResponseTimeoutMs(args);

      // Single-flight: two concurrent runs would interleave sends into the
      // same tabs and fight over module-scoped state.
      if (runActive) {
        throw new Error("a consensus workflow is already active — wait for it or check get_consensus_status");
      }
      runActive = true;

      // CRITICAL: fire-and-forget — do NOT await runFullConsensus.
      // .catch() uses module-scoped consensusState and saveState.
      runFullConsensus(browserService, args.prompt, maxRounds, responseTimeoutMs)
        .catch(e => {
          consensusState.status = `error: ${e.message}`;
          consensusState.active = false;
          // Best-effort: if persistence itself is what failed, a rethrow here
          // becomes an unhandled rejection that kills the whole server.
          try {
            saveState();
          } catch (persistErr) {
            console.error(`[state] could not persist error status: ${persistErr.message}`);
          }
        })
        .finally(() => { runActive = false; });

      return { content: [{ type: "text", text: `Consensus workflow started.\nPrompt: ${args.prompt.substring(0, 100)}...\nMax rounds: ${maxRounds}\n\nUse get_consensus_status to check progress.` }] };
    }

    case "get_consensus_status":
      return { content: [{ type: "text", text: getStatusSummary() }] };

    case "get_consensus_results":
      return { content: [{ type: "text", text: getFullResults() }] };

    case "get_last_round":
      loadState();
      if (consensusState.rounds.length === 0) {
        return { content: [{ type: "text", text: "No rounds completed yet." }] };
      }
      const last = consensusState.rounds[consensusState.rounds.length - 1];
      let output = `Round ${last.round} outputs:\n\n`;
      for (const [m, o] of Object.entries(last.outputs)) {
        output += `=== ${m.toUpperCase()} ===\n${o}\n\n`;
      }
      for (const [m, e] of Object.entries(last.errors || {})) {
        output += `=== ${m.toUpperCase()} — FAILED (${e.phase}) ===\n${e.message}\n\n`;
      }
      return { content: [{ type: "text", text: output }] };

    case "send_single_round": {
      requirePrompt(args, "send_single_round");
      const responseTimeoutMs = parseResponseTimeoutMs(args);
      await browserService.connect();
      const round = await runConsensusRound(browserService, args.prompt, 1, { responseTimeoutMs });
      let result = `Round complete (${(round.duration/1000).toFixed(1)}s)\n\n`;
      for (const [m, o] of Object.entries(round.outputs)) {
        result += `=== ${m.toUpperCase()} ===\n${o}\n\n`;
      }
      for (const [m, e] of Object.entries(round.errors || {})) {
        result += `=== ${m.toUpperCase()} — FAILED (${e.phase}) ===\n${e.message}\n\n`;
      }
      return { content: [{ type: "text", text: result }] };
    }

    case "health_check": {
      const report = await getHealthReport(browserService);
      const text = formatHealthReport(report);
      return { content: [{ type: "text", text }] };
    }

    default:
      return null;
  }
}

export function initConsensusState() {
  loadState();
  // A persisted active:true means a previous process died mid-run — this
  // process is not running that workflow, so surface it as interrupted.
  if (consensusState.active) {
    consensusState.active = false;
    consensusState.status = "interrupted";
    try {
      saveState(); // best-effort: boot must survive an unwritable state path
    } catch (e) {
      console.error(`[state] could not persist interrupted recovery: ${e.message}`);
    }
  }
}
