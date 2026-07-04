// research/research-queue.js — persistent deep-research task queue at
// ~/.auto-browser/research/queue.json (RESEARCH_HOME env override).
//
// Routing policy (decided): gemini_priority tasks run on gemini (within its
// daily cap) AND claude AND chatgpt; all other tasks on claude + chatgpt.
// Per task × provider state machine:
//   queued → running → complete
//                    → awaiting_quota (limit banner/cap; auto-resumes)
//                    → paused_flagged (safety pause; needs the user)
//                    → blocked_login  (login expired; needs the user)
//                    → failed         (after MAX_ATTEMPTS)
// chatUrl is recorded as soon as a run starts and NEVER dropped — a paid
// deep-research run must stay manually recoverable.
//
// Saves are atomic (temp+rename). The queue file is shared by the MCP tools
// and the headless runner; cross-process drain exclusion is the runner
// lockfile's job (research/lockfile.js), not this module's.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

export const RESEARCH_HOME = process.env.RESEARCH_HOME || join(homedir(), '.auto-browser', 'research');
const QUEUE_FILE = join(RESEARCH_HOME, 'queue.json');

export const MAX_ATTEMPTS = 2;

const TERMINAL = new Set(['complete', 'failed']);
let tmpSeq = 0;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function load() {
  try {
    if (existsSync(QUEUE_FILE)) {
      const parsed = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
      // Parseable-but-wrong-shape is as unusable as unparseable — quarantine
      // it too, or every queue API throws on a null/array/missing-keys file.
      if (isPlainObject(parsed) && isPlainObject(parsed.tasks) && Array.isArray(parsed.order)) {
        return parsed;
      }
      throw new Error('queue.json has an unexpected shape');
    }
  } catch (e) {
    // Never lose a queue silently: quarantine the bad file.
    try {
      if (existsSync(QUEUE_FILE)) {
        renameSync(QUEUE_FILE, `${QUEUE_FILE}.corrupt-${Date.now()}`);
        console.error(`[research-queue] quarantined corrupt queue file: ${e.message}`);
      }
    } catch {
      // rename failed — fall through to a fresh queue
    }
  }
  return { tasks: {}, order: [] };
}

function save(q) {
  mkdirSync(RESEARCH_HOME, { recursive: true });
  const tmp = `${QUEUE_FILE}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  renameSync(tmp, QUEUE_FILE);
}

export function routeProviders(geminiPriority) {
  return geminiPriority ? ['gemini', 'claude', 'chatgpt'] : ['claude', 'chatgpt'];
}

/**
 * Submit a batch of research prompts.
 * @param {Array<{prompt: string, project?: string, gemini_priority?: boolean}>} items
 * @returns {{batch: string, taskIds: string[]}}
 */
export function submitBatch(items, { batch = null, now = Date.now() } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('submitBatch: items must be a non-empty array');
  const q = load();
  const batchId = batch || `batch-${new Date(now).toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
  const taskIds = [];
  for (const item of items) {
    if (!item || typeof item.prompt !== 'string' || !item.prompt.trim()) {
      throw new Error('submitBatch: every item needs a non-empty prompt');
    }
    const id = `task-${randomBytes(4).toString('hex')}`;
    const providers = routeProviders(!!item.gemini_priority);
    q.tasks[id] = {
      id,
      batch: batchId,
      type: 'deep_research',
      prompt: item.prompt,
      project: item.project ?? null,
      geminiPriority: !!item.gemini_priority,
      providers,
      timeoutMs: Number(item.timeout_ms) || null,
      createdAt: now,
      perProvider: Object.fromEntries(providers.map((p) => [p, {
        status: 'queued',
        attempts: 0,
        // spent === true means a DR run was STARTED (recordDRSpend + send) in
        // chatUrl: that task-provider must RESUME (re-open chatUrl, re-harvest)
        // on any later processing — never re-run, or it double-spends.
        spent: false,
        chatUrl: null,
        startedAt: null,
        finishedAt: null,
        artifactPath: null,
        error: null,
      }])),
    };
    q.order.push(id);
    taskIds.push(id);
  }
  save(q);
  return { batch: batchId, taskIds };
}

export function getTask(id) {
  return load().tasks[id] ?? null;
}

export function listTasks({ batch = null } = {}) {
  const q = load();
  return q.order.map((id) => q.tasks[id]).filter((t) => t && (!batch || t.batch === batch));
}

/**
 * Next FRESH task runnable on `provider` (FIFO): a never-spent queued task,
 * or a never-spent awaiting_quota task once the quota gate passes. Spent
 * tasks are NOT returned here — they resume via nextResumable.
 */
export function nextRunnable(provider, { quotaOk = true, batch = null } = {}) {
  const q = load();
  for (const id of q.order) {
    const t = q.tasks[id];
    if (batch && t.batch !== batch) continue;
    const pp = t?.perProvider?.[provider];
    if (!pp || pp.spent) continue;
    if (pp.status === 'queued') return t;
    if (pp.status === 'awaiting_quota' && quotaOk) return t;
  }
  return null;
}

/**
 * Next task to RESUME on `provider` (FIFO): a spent task whose chat is still
 * unharvested (awaiting_quota after a mid-run banner, or 'running' orphaned
 * by a crashed drainer). Resuming re-opens chatUrl and harvests — it never
 * spends again, so it is not quota-gated.
 */
export function nextResumable(provider, { batch = null } = {}) {
  const q = load();
  for (const id of q.order) {
    const t = q.tasks[id];
    if (batch && t.batch !== batch) continue;
    const pp = t?.perProvider?.[provider];
    if (!pp) continue;
    if (pp.spent && pp.chatUrl && ['awaiting_quota', 'running'].includes(pp.status)) return t;
  }
  return null;
}

/**
 * Reconcile tasks a crashed drainer left mid-flight. A 'running' task that
 * never spent (crashed before send) re-queues; a spent one stays 'running'
 * and is picked up by nextResumable. Call at drain start.
 */
export function reconcileRunning({ batch = null } = {}) {
  const q = load();
  let requeued = 0;
  for (const id of q.order) {
    const t = q.tasks[id];
    if (batch && t.batch !== batch) continue;
    for (const [provider, pp] of Object.entries(t.perProvider)) {
      if (pp.status === 'running' && !pp.spent) {
        pp.status = 'queued';
        pp.error = 'reconciled: runner exited before send';
        requeued += 1;
      }
    }
  }
  if (requeued > 0) save(q);
  return requeued;
}

function update(id, provider, patch) {
  const q = load();
  const t = q.tasks[id];
  if (!t) throw new Error(`unknown task ${id}`);
  const pp = t.perProvider[provider];
  if (!pp) throw new Error(`task ${id} has no provider ${provider}`);
  Object.assign(pp, patch);
  save(q);
  return q.tasks[id];
}

/** Start a FRESH run. Does NOT set chatUrl (the harvestable conversation URL
 * only exists after send) and does NOT touch attempts (a failure counter,
 * incremented in markFailed). */
export function markRunning(id, provider, { now = Date.now() } = {}) {
  return update(id, provider, { status: 'running', startedAt: now });
}

/** Resume a spent run for harvesting — status only; never re-attempts. */
export function markResuming(id, provider, { now = Date.now() } = {}) {
  return update(id, provider, { status: 'running', startedAt: now });
}

/** Seal a spend BEFORE the send click. Sets no chatUrl (the harvestable
 * conversation URL only exists AFTER send — recordChatUrl captures it then).
 * Sealing before the click means a crash mid-send resumes (or fails without
 * a URL), never re-runs — so a paid send is never doubled. */
export function markSpent(id, provider, { now = Date.now() } = {}) {
  return update(id, provider, { spent: true, spentAt: now });
}

/** Unseal a spend when the send was PROVABLY not delivered — the retry must
 * re-run fresh (no report exists), and the ledger count is refunded too. */
export function clearSpend(id, provider) {
  return update(id, provider, { spent: false, spentAt: null, chatUrl: null });
}

/** Record the live conversation URL — set once, never clobbered. */
export function recordChatUrl(id, provider, chatUrl) {
  if (!chatUrl) return;
  const pp = load().tasks[id]?.perProvider?.[provider];
  if (pp?.chatUrl) return; // a spent/known chat URL wins over later navigations
  update(id, provider, { chatUrl });
}

export function markComplete(id, provider, { artifactPath, now = Date.now() } = {}) {
  return update(id, provider, { status: 'complete', finishedAt: now, artifactPath, error: null });
}

export function markAwaitingQuota(id, provider, { reason, now = Date.now() } = {}) {
  return update(id, provider, { status: 'awaiting_quota', finishedAt: now, error: reason ?? 'provider limit' });
}

export function markPausedFlagged(id, provider, { evidence, now = Date.now() } = {}) {
  return update(id, provider, { status: 'paused_flagged', finishedAt: now, error: evidence ?? 'provider safety pause' });
}

export function markBlockedLogin(id, provider, { reason, now = Date.now() } = {}) {
  return update(id, provider, { status: 'blocked_login', finishedAt: now, error: reason ?? 'login expired' });
}

/**
 * Failure with attempt accounting. attempts is incremented HERE (not on
 * start), so failures that occur BEFORE a run reaches send — tab missing,
 * ensureChat unverified — still count toward MAX_ATTEMPTS; otherwise the
 * task re-queues forever. `terminal: true` never retries — a timed-out DR
 * run may still be completing in its chat, and an automatic resend would
 * DOUBLE the spend.
 */
export function markFailed(id, provider, { error, terminal = false, now = Date.now() } = {}) {
  const pp = load().tasks[id]?.perProvider?.[provider];
  const attempts = (pp?.attempts ?? 0) + 1;
  return update(id, provider, {
    status: (terminal || attempts >= MAX_ATTEMPTS) ? 'failed' : 'queued',
    attempts,
    finishedAt: now,
    error: String(error ?? 'unknown').slice(0, 500),
  });
}

/** Per-batch status table (also the research_status payload in PR-11). */
export function statusTable(batch = null) {
  const tasks = listTasks({ batch });
  return tasks.map((t) => ({
    id: t.id,
    batch: t.batch,
    prompt: `${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '…' : ''}`,
    project: t.project,
    geminiPriority: t.geminiPriority,
    providers: Object.fromEntries(Object.entries(t.perProvider).map(([p, s]) => [p, {
      status: s.status,
      attempts: s.attempts,
      spent: s.spent,
      chatUrl: s.chatUrl,
      artifactPath: s.artifactPath,
      error: s.error,
    }])),
  }));
}

/** True when nothing on this provider can ever run again without help. */
export function providerDrained(provider) {
  const q = load();
  return q.order.every((id) => {
    const pp = q.tasks[id]?.perProvider?.[provider];
    return !pp || TERMINAL.has(pp.status) || ['paused_flagged', 'blocked_login', 'awaiting_quota'].includes(pp.status);
  });
}

export function artifactDir(task, provider) {
  return join(RESEARCH_HOME, task.batch, task.id);
}

export function artifactPathFor(task, provider) {
  return join(artifactDir(task, provider), `${provider}.md`);
}
