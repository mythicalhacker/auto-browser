// research/runner.js — deep-research execution over the production driver +
// send machinery. Per-provider concurrency is 1 (a provider tab is a single
// serial resource); providers run in parallel.
//
// One DR run = ensureChat (project + research mode + per-provider model,
// registry research profile) → verified send → waitForResearchComplete
// (text-stability completion, banner-aware) → artifact + meta on disk.
// Interrupts: quota banner → provider cooldown + awaiting_quota (auto-
// resumes); safety pause → paused_flagged (needs the user); login URL →
// blocked_login (needs the user). chatUrl is persisted from the first poll —
// a paid run is never lost.
import { writeFileSync, mkdirSync } from 'fs';
import { getProvider } from '../models/registry.js';
import { getDriver } from '../models/drivers/index.js';
import { findFirst, findAll } from '../utils/selectors.js';
import { checkLogin } from '../utils/login-check.js';
import { sendToModel } from '../tools/consensus.js';
import { SELECTORS } from '../config.js';
import { detectInterrupt } from './banners.js';
import { canSpendDR, recordDRSpend, refundDRSpend, setCooldown } from './quota-ledger.js';
import * as queue from './research-queue.js';

export const DR_TIMEOUT_MS = Number(process.env.DR_TIMEOUT_MS) || 90 * 60 * 1000; // runs take 5–45+ min
export const DR_STABLE_MS = Number(process.env.DR_STABLE_MS) || 90 * 1000; // report text quiet this long = done
export const DR_POLL_MS = Number(process.env.DR_POLL_MS) || 5000;
const DR_MIN_REPORT_CHARS = 400; // interim status blurbs are shorter than any real report

// Unattended DR: both Claude and ChatGPT deep research OPEN with a clarifying
// question ("which connectors?", "to tailor the research…") and STOP for a
// user answer (observed live 2026-07-04 — the run stalls forever otherwise).
// This preamble tells the model to skip that step and produce the report in
// one pass. Overridable via ~/.auto-browser/prompts/research-preamble.md.
export const DR_PREAMBLE = 'IMPORTANT: This runs unattended — do NOT ask any clarifying or scoping '
  + 'questions and do NOT wait for a reply. Make reasonable assumptions, use the default/all available '
  + 'sources, and produce the COMPLETE research report in this single response now.\n\n';

function researchPrompt(task) {
  return `${DR_PREAMBLE}${task.prompt}`;
}

// Post-send watch window in which the runner clears a provider's
// pre-generation gate (Claude connector modal, ChatGPT clarification, Gemini
// plan confirmation) so an unattended run actually starts researching.
export const GATE_WATCH_MS = Number(process.env.DR_GATE_WATCH_MS) || 180000; // 3 min
const GATE_POLL_MS = Number(process.env.DR_GATE_POLL_MS) || 5000;
const CLARIFY_REPLY = 'Proceed exactly as specified. Make reasonable assumptions. '
  + 'Do not ask further questions — produce the full report now.';

async function anyMatch(page, selectors) {
  return !!(await findFirst(page, selectors ?? []));
}

// The clarifying question is the LATEST assistant message — read the LAST
// matching element (discovery: never :last-of-type; take .at(-1)).
async function lastInnerText(page, selectors) {
  const els = await findAll(page, selectors ?? []);
  if (els.length === 0) return null;
  try { return (await els[els.length - 1].innerText()).trim(); } catch { return null; }
}

// CONSERVATIVE: only a SHORT message carrying a question is treated as a
// clarification. A long message is (or is becoming) the report — never reply
// to it, so we can't accidentally derail a real report with a spurious answer.
function looksLikeClarification(text) {
  if (!text) return false;
  const t = text.trim();
  return t.length > 0 && t.length < 1500 && /\?/.test(t);
}

/**
 * Clear the provider's deep-research pre-generation gate after send (or on
 * resume). modal / plan_confirm → click the confirm/Start control; clarify →
 * reply ONCE with a fixed "just produce the report" message (loop-guarded by
 * the persisted gateReplied flag). Returns once research is underway, a gate
 * was actioned, or the watch window expires. Never replies to a message that
 * might be the report (conservative bias) — the DR timeout then preserves the
 * chat URL, unchanged from before.
 */
const REPORT_FORMING_CHARS = 400; // a message this long is the report, not a question

export async function clearGenerationGates(browserService, provider, task, { log = () => {} } = {}) {
  const page = browserService.getPage(provider);
  const gates = getProvider(provider)?.generationGates ?? [];
  if (!page || gates.length === 0) return { actioned: [] };
  const deadline = Date.now() + GATE_WATCH_MS;
  const actioned = [];
  // A modal/plan_confirm gate is confirmed at most ONCE — a second click on a
  // Confirm/Start control could launch a second (paid) run. Resolution is
  // decided PER GATE (never a global streaming short-circuit): a gate's own
  // progressMarker means research is underway FOR THAT GATE. Crucially, a
  // gate's progressMarker must be a research-UNDERWAY signal, not mere
  // streaming — streaming is also present while a clarifying question or a
  // plan is being generated.
  const clicked = new Set();

  while (Date.now() < deadline) {
    let unresolved = 0;
    for (let i = 0; i < gates.length; i++) {
      const gate = gates[i];
      const running = (gate.progressMarker?.length ?? 0) > 0 && await anyMatch(page, gate.progressMarker);

      if (gate.kind === 'modal' || gate.kind === 'plan_confirm') {
        if (clicked.has(i) || running) continue; // confirmed / underway → resolved
        if (!(await anyMatch(page, gate.detect))) { unresolved++; continue; } // gate not shown yet — keep waiting
        const m = await findFirst(page, gate.action);
        if (!m) { unresolved++; continue; } // gate shown but action control not ready
        try {
          await m.element.click({ force: true });
          clicked.add(i);
          actioned.push(gate.kind);
          log(`[${provider}] ${task.id}: cleared ${gate.kind} gate`);
        } catch { unresolved++; } // control moved — retry next poll
      } else { // clarify — reply at most once; NEVER to a report
        if (queue.getTask(task.id).perProvider[provider].gateReplied || running) continue; // replied / report present → resolved
        if (!(await anyMatch(page, gate.detect))) { unresolved++; continue; } // no assistant turn yet
        const text = await lastInnerText(page, gate.clarifyMessage ?? gate.detect);
        if (looksLikeClarification(text)) {
          queue.markGateReplied(task.id, provider); // seal the guard BEFORE the send (crash-safe: never re-reply)
          try {
            await sendToModel(browserService, provider, CLARIFY_REPLY);
            actioned.push('clarify');
            log(`[${provider}] ${task.id}: auto-replied to a clarifying question`);
          } catch (e) {
            log(`[${provider}] ${task.id}: clarify reply failed (${e.message})`);
          }
        } else if (text && text.length >= REPORT_FORMING_CHARS) {
          continue; // a long message is the report forming, not a question → resolved
        } else {
          unresolved++; // short / no question yet — keep watching within the window
        }
      }
    }
    if (unresolved === 0) return { actioned }; // every gate confirmed / replied / underway
    await page.waitForTimeout(GATE_POLL_MS);
  }
  return { actioned };
}

/**
 * Wait for a deep-research run to finish on `page`.
 * Completion = latest output text ≥ DR_MIN_REPORT_CHARS, no streaming
 * marker, and text length unchanged for `stableMs`. Banners end the wait
 * early with their own reason. onUrl fires every poll (chatUrl persistence).
 * @returns {{outcome: 'complete'|'timeout'|'quota'|'paused', text, banner}}
 */
export async function waitForResearchComplete(page, provider, {
  timeoutMs = DR_TIMEOUT_MS,
  stableMs = DR_STABLE_MS,
  pollMs = DR_POLL_MS,
  onUrl = () => {},
} = {}) {
  const sel = SELECTORS[provider];
  // A deep-research report can render in a dedicated panel, not the normal
  // chat output container — poll both.
  const reportContainers = (getProvider(provider)?.generationGates ?? [])
    .flatMap((g) => g.reportContainer ?? []);
  const outputSelectors = [...sel.output, ...reportContainers];
  const reloadOnEmpty = getProvider(provider)?.capabilities?.reloadOnEmptyOutput;
  const deadline = Date.now() + timeoutMs;
  let lastText = null;
  let stableSince = null;
  let emptySince = null;
  let reloaded = false;

  for (;;) {
    try {
      onUrl(page.url());
    } catch {
      // page mid-navigation
    }

    const banner = await detectInterrupt(page, provider);
    if (banner.type === 'quota') return { outcome: 'quota', text: lastText ?? '', banner };
    if (banner.type === 'paused') return { outcome: 'paused', text: lastText ?? '', banner };

    let text = '';
    try {
      const els = await findAll(page, outputSelectors);
      if (els.length > 0) text = (await els[els.length - 1].innerText()).trim();
    } catch {
      text = '';
    }

    // ChatGPT thinking/DR DOM empties after streaming (reloadOnEmptyOutput):
    // a finished report reads empty and would otherwise time out as failed.
    // Reload ONCE after a sustained empty stretch to force a server re-render.
    if (reloadOnEmpty && !reloaded && text.length < DR_MIN_REPORT_CHARS) {
      if (emptySince === null) emptySince = Date.now();
      else if (Date.now() - emptySince >= stableMs) {
        reloaded = true;
        emptySince = null;
        try {
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(3000);
        } catch {
          // reload failed — keep polling the live DOM
        }
        continue;
      }
    } else {
      emptySince = null;
    }

    const streamMatch = await findFirst(page, sel.streaming);
    const streaming = streamMatch && await streamMatch.element.isVisible().catch(() => false);

    // Completion compares CONTENT, not just length: a report that keeps
    // editing at a constant char count is still changing.
    if (text.length >= DR_MIN_REPORT_CHARS && !streaming) {
      if (text === lastText) {
        if (stableSince !== null && Date.now() - stableSince >= stableMs) {
          return { outcome: 'complete', text, banner: null };
        }
        if (stableSince === null) stableSince = Date.now();
      } else {
        stableSince = Date.now();
      }
    } else {
      stableSince = null;
    }
    lastText = text;

    if (Date.now() >= deadline) return { outcome: 'timeout', text: lastText ?? '', banner: null };
    await page.waitForTimeout(pollMs);
  }
}

function writeArtifact(task, provider, text, extras) {
  const dir = queue.artifactDir(task, provider);
  mkdirSync(dir, { recursive: true });
  const path = queue.artifactPathFor(task, provider);
  writeFileSync(path, `# ${task.prompt.slice(0, 120)}\n\n_provider: ${provider} · task: ${task.id} · batch: ${task.batch}_\n\n---\n\n${text}\n`);
  writeFileSync(`${dir}/${provider}.meta.json`, JSON.stringify({
    task: task.id,
    batch: task.batch,
    provider,
    prompt: task.prompt,
    project: task.project,
    chars: text.length,
    ...extras,
  }, null, 2));
  return path;
}

// Turn a waitForResearchComplete outcome into a recorded terminal state.
// Shared by the fresh-run and resume paths so a spent chat is harvested
// identically however it is reached.
function harvest(task, provider, result, { log }) {
  const pp = () => queue.getTask(task.id).perProvider[provider];
  if (result.outcome === 'complete') {
    const startedAt = pp().startedAt;
    const path = writeArtifact(task, provider, result.text, {
      chatUrl: pp().chatUrl,
      startedAt,
      finishedAt: Date.now(),
      durationMs: startedAt ? Date.now() - startedAt : null,
    });
    queue.markComplete(task.id, provider, { artifactPath: path });
    log(`[${provider}] ${task.id}: complete → ${path}`);
    return 'complete';
  }
  if (result.outcome === 'quota') {
    const until = result.banner.resetAt ?? Date.now() + 60 * 60 * 1000; // unparseable reset: retry hourly
    setCooldown(provider, until, result.banner.text);
    queue.markAwaitingQuota(task.id, provider, { reason: result.banner.text });
    log(`[${provider}] ${task.id}: quota banner — cooldown until ${new Date(until).toISOString()} (chat kept: ${pp().chatUrl})`);
    return 'awaiting_quota';
  }
  if (result.outcome === 'paused') {
    queue.markPausedFlagged(task.id, provider, { evidence: result.banner.text });
    log(`[${provider}] ${task.id}: provider paused the chat — needs the user (${pp().chatUrl})`);
    return 'paused_flagged';
  }
  // TERMINAL, no auto-retry: the run may still be completing in its chat — an
  // automatic resend would double a paid run. The chat URL is preserved.
  queue.markFailed(task.id, provider, {
    error: `dr_timeout after ${task.timeoutMs ?? DR_TIMEOUT_MS}ms (report may still be at the chat URL)`,
    terminal: true,
  });
  return 'failed';
}

/**
 * RESUME a spent run without spending again: re-open its chat URL and harvest
 * the report already in progress there. Used for awaiting_quota (mid-run
 * banner) and 'running' tasks a crashed drainer orphaned.
 */
export async function resumeProviderTask(browserService, provider, task, { log = () => {}, waitOpts = {} } = {}) {
  const pp = queue.getTask(task.id).perProvider[provider];
  const page = browserService.getPage(provider);
  if (!page) {
    queue.markFailed(task.id, provider, { error: `${provider} tab not found (resume)` });
    return 'failed';
  }
  if (!pp.chatUrl) {
    // spent but no URL — cannot harvest; fail terminally rather than re-spend
    queue.markFailed(task.id, provider, { error: 'spent run has no chat URL to resume', terminal: true });
    return 'failed';
  }
  const { loggedIn, reason } = await checkLogin(page, provider);
  if (!loggedIn && reason.startsWith('URL contains login pattern')) {
    queue.markBlockedLogin(task.id, provider, { reason: `login_expired: ${reason}` });
    return 'blocked_login';
  }
  try {
    await page.goto(pp.chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    queue.markFailed(task.id, provider, { error: `resume nav failed: ${e.message}`, terminal: true });
    return 'failed';
  }
  queue.markResuming(task.id, provider);
  log(`[${provider}] ${task.id}: resuming harvest at ${pp.chatUrl}`);
  // A sealed spend whose gate was never cleared must clear it on resume —
  // NOT re-send (extends the never-double-spend invariant).
  await clearGenerationGates(browserService, provider, task, { log });
  const result = await waitForResearchComplete(page, provider, {
    ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
    ...waitOpts,
  });
  return harvest(task, provider, result, { log });
}

/**
 * Run ONE fresh task on ONE provider end to end. Returns the terminal status
 * string it recorded. Never throws for run-level failures. A run that has
 * already spent (chatUrl set) must go through resumeProviderTask instead.
 */
export async function runProviderTask(browserService, provider, task, { log = () => {}, waitOpts = {} } = {}) {
  const existing = queue.getTask(task.id).perProvider[provider];
  if (existing.spent) {
    // Never re-run a spent task — resume its chat.
    return resumeProviderTask(browserService, provider, task, { log, waitOpts });
  }

  const page = browserService.getPage(provider);
  if (!page) {
    queue.markFailed(task.id, provider, { error: `${provider} tab not found` });
    return 'failed';
  }

  // Login fast-fail (URL signal only, same contract as consensus rounds).
  const { loggedIn, reason } = await checkLogin(page, provider);
  if (!loggedIn && reason.startsWith('URL contains login pattern')) {
    queue.markBlockedLogin(task.id, provider, { reason: `login_expired: ${reason}` });
    return 'blocked_login';
  }

  const gate = canSpendDR(provider);
  if (!gate.ok) {
    queue.markAwaitingQuota(task.id, provider, { reason: gate.reason });
    return 'awaiting_quota';
  }

  const d = getProvider(provider);
  const profile = d.research ?? {};
  const setup = await getDriver(provider).ensureChat(page, {
    project: task.project ?? undefined,
    model: profile.model ?? undefined,
    modes: profile.modes ?? {},
    research: true,
  });
  // project_not_found is a warning (runs in a normal chat, per requirements);
  // anything else unverified is a failed attempt with the step evidence.
  if (!setup.ok) {
    const evidence = setup.steps.filter((s) => !s.ok).map((s) => `${s.action}: ${s.evidence}`).join('; ');
    queue.markFailed(task.id, provider, { error: `ensureChat: ${evidence || 'unverified'}` });
    return 'failed';
  }
  if (setup.verified.research?.ok !== true) {
    queue.markFailed(task.id, provider, { error: `research mode unverified: ${setup.verified.research?.evidence ?? 'no evidence'}` });
    return 'failed';
  }
  for (const w of setup.warnings) log(`[${provider}] ${task.id}: ${w.code} — ${w.detail}`);

  const urlBeforeSend = page.url();
  queue.markRunning(task.id, provider);
  recordDRSpend(provider); // counted at send time — a started run is a paid run
  queue.markSpent(task.id, provider); // sealed BEFORE the send click: a crash mid-send resumes/fails, never re-runs
  try {
    await sendToModel(browserService, provider, researchPrompt(task));
  } catch (e) {
    if (e.sendPhase === 'ambiguous') {
      // The message may have been delivered — resuming (not resending) is the
      // only safe move. Park for the next drain to harvest the chat.
      queue.markAwaitingQuota(task.id, provider, { reason: `send ambiguous: ${e.message}` });
      log(`[${provider}] ${task.id}: ambiguous send — will resume/harvest the chat, never resend`);
      return 'awaiting_quota';
    }
    // Provably unsent: safe to retry as a FRESH run. Unseal the spend and
    // refund the ledger count — the send never happened, so no report exists.
    queue.clearSpend(task.id, provider);
    refundDRSpend(provider);
    queue.markFailed(task.id, provider, { error: `send (unsent): ${e.message}` });
    return 'failed';
  }
  // Wait for the SPA to create + navigate to the conversation before pinning
  // the chat URL — pinning the pre-send entry URL (observed live: sealed
  // chatgpt.com/ instead of /c/<id>) makes the run unrecoverable on resume.
  for (let i = 0; i < 12 && page.url() === urlBeforeSend; i++) {
    await page.waitForTimeout(1000);
  }
  queue.recordChatUrl(task.id, provider, page.url());
  log(`[${provider}] ${task.id}: sent; watching for a pre-generation gate`);

  // Clear the provider's pre-generation gate (connector modal / clarification
  // / plan confirmation) so the run actually starts researching.
  await clearGenerationGates(browserService, provider, task, { log });

  const result = await waitForResearchComplete(page, provider, {
    ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {}),
    ...waitOpts,
    onUrl: (u) => queue.recordChatUrl(task.id, provider, u),
  });
  return harvest(task, provider, result, { log });
}

/**
 * Drain everything runnable for an optional `batch`. Providers run in
 * parallel, tasks per provider strictly serially. Each provider first
 * RESUMES any spent-but-unharvested chats (mid-run banner parks, crash
 * orphans) — never re-spending — then runs fresh tasks. Stops a provider on
 * blocked_login (user needed) or when nothing is left. One provider throwing
 * is isolated (recorded, drain continues). Returns {provider: {ran, statuses}}.
 *
 * Concurrency guard: the caller (scripts/run-queue.js, or PR-11's MCP tool)
 * must hold the cross-process drain lock — two drainers on one queue would
 * double-run tasks.
 */
export async function drainQueue(browserService, { providers, batch = null, log = () => {}, waitOpts = {} } = {}) {
  await browserService.connect();
  const active = providers ?? browserService.getActiveModels();
  const requeued = queue.reconcileRunning({ batch });
  if (requeued > 0) log(`reconciled ${requeued} task(s) orphaned in 'running' by a prior runner`);

  const summary = {};
  await Promise.all(active.map(async (provider) => {
    const stats = { ran: 0, statuses: {} };
    summary[provider] = stats;
    try {
      for (;;) {
        // 1. Harvest spent chats first (no spend), regardless of quota.
        const resumable = queue.nextResumable(provider, { batch });
        if (resumable) {
          const status = await runProviderTask(browserService, provider, resumable, { log, waitOpts });
          stats.ran += 1;
          stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
          if (status === 'blocked_login') break;
          // awaiting_quota here = a resumed chat STILL banner-limited; stop
          // to avoid re-navigating in a loop.
          if (status === 'awaiting_quota') break;
          continue;
        }
        // 2. Fresh runs, quota-gated.
        const quotaOk = canSpendDR(provider).ok;
        const task = queue.nextRunnable(provider, { quotaOk, batch });
        if (!task) break;
        if (!quotaOk) {
          queue.markAwaitingQuota(task.id, provider, { reason: canSpendDR(provider).reason });
          stats.statuses.awaiting_quota = (stats.statuses.awaiting_quota ?? 0) + 1;
          break; // cap/cooldown: nothing fresh runnable until reset
        }
        const status = await runProviderTask(browserService, provider, task, { log, waitOpts });
        stats.ran += 1;
        stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
        if (status === 'blocked_login') break; // user must re-login
        if (status === 'awaiting_quota') break; // cooldown; the next drain resumes
        if (status === 'failed') {
          // A retryable failure re-queued itself; pause so a burst of
          // consecutive failures cannot hammer the site.
          await new Promise((r) => setTimeout(r, Number(process.env.DR_RETRY_DELAY_MS) || 30000));
        }
      }
    } catch (e) {
      stats.error = e.message; // isolate: a crash on one provider must not kill the others
      log(`[${provider}] drain error: ${e.message}`);
    }
  }));
  return summary;
}
