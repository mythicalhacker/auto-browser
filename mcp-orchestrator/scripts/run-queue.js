#!/usr/bin/env node
// scripts/run-queue.js — headless research-queue runner. Drains the persisted
// deep-research queue with NO MCP attach: same product modules, same state
// (~/.auto-browser/research + quotas.json), guarded by the cross-process
// drain lock. Long batches run for days — keep the Mac awake:
//   caffeinate -dims node scripts/run-queue.js
//
// Usage: node scripts/run-queue.js [--providers=claude,chatgpt,gemini]
//                                  [--once] [--status] [--batch=<id>]
// Exit codes: 0 drained · 2 lock held · 4 login needed (which site printed)
import { acquireDrainLock, releaseDrainLock } from '../research/lockfile.js';
import { drainQueue } from '../research/runner.js';
import { statusTable, listTasks, getTask } from '../research/research-queue.js';
import { synthesizeTask } from '../research/synthesis.js';
import { quotaSnapshot } from '../research/quota-ledger.js';
import { providerNames } from '../models/registry.js';
import { browserService } from '../services/browser-service.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name) => args.includes(`--${name}`);
const providersRaw = flag('providers');
// flag absent (undefined) → default to all; flag present-but-empty → error.
const providers = providersRaw === undefined
  ? providerNames()
  : providersRaw.split(',').map((s) => s.trim()).filter(Boolean);
if (providers.length === 0) {
  console.error(`--providers was given but had no valid entries. Known: ${providerNames().join(', ')}`);
  process.exit(2);
}
const unknownProviders = providers.filter((p) => !providerNames().includes(p));
if (unknownProviders.length > 0) {
  console.error(`unknown provider(s): ${unknownProviders.join(', ')}. Known: ${providerNames().join(', ')}`);
  process.exit(2);
}
const batch = flag('batch') ?? null;
const log = (m) => console.log(`[run-queue ${new Date().toISOString().slice(11, 19)}] ${m}`);

if (has('status')) {
  console.log(JSON.stringify({ tasks: statusTable(batch), quotas: quotaSnapshot(providers) }, null, 2));
  process.exit(0);
}

const lock = acquireDrainLock();
if (!lock.ok) {
  console.error(`another drain is running (pid ${lock.holder.pid} since ${new Date(lock.holder.startedAt).toISOString()}) — refusing`);
  process.exit(2);
}
if (lock.takeover) log('took over a stale drain lock (previous runner died)');

let stopping = false;
const cleanup = () => {
  releaseDrainLock();
  browserService.disconnect().catch(() => {});
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(130);
    stopping = true;
    log(`${sig} — finishing nothing new, releasing lock`);
    cleanup();
    process.exit(130);
  });
}
process.on('exit', releaseDrainLock);

const pendingWork = () => listTasks({ batch }).some((t) =>
  Object.values(t.perProvider).some((pp) => ['queued', 'awaiting_quota', 'running'].includes(pp.status)));

try {
  if (has('synthesize')) {
    // Synthesize every in-scope task with >=2 complete reports, skipping any
    // whose FINAL already exists (unless --force) — a paid re-synthesis of an
    // already-final task is wasteful.
    await browserService.connect();
    const { existsSync } = await import('fs');
    const { finalPath } = await import('../research/synthesis.js');
    const force = has('force');
    const tasks = listTasks({ batch }).filter((t) => {
      const enough = Object.values(t.perProvider).filter((pp) => pp.status === 'complete').length >= 2;
      if (!enough) return false;
      if (!force && existsSync(finalPath(t))) {
        log(`skip ${t.id}: FINAL already exists (use --force to redo)`);
        return false;
      }
      return true;
    });
    log(`synthesizing ${tasks.length} task(s) with >=2 reports`);
    const results = [];
    for (const t of tasks) {
      const res = await synthesizeTask(browserService, t.id, { log });
      log(`synthesize ${t.id}: ${res.status}${res.finalPath ? ` → ${res.finalPath}` : ` (${res.reason})`}`);
      results.push({ task: t.id, ...res });
    }
    console.log(JSON.stringify({ synthesized: results }, null, 2));
    cleanup();
    process.exit(0);
  }

  for (;;) {
    const summary = await drainQueue(browserService, { providers, batch, log });
    log(`drain pass: ${JSON.stringify(summary)}`);

    const blockedLogin = Object.entries(summary).filter(([, s]) => s.statuses.blocked_login);
    if (blockedLogin.length > 0) {
      console.error(`LOGIN NEEDED: re-login to ${blockedLogin.map(([p]) => p).join(', ')} in the debug Chrome, then rerun.`);
      process.exit(4);
    }
    if (has('once') || !pendingWork()) break;

    // Everything left is awaiting quota: sleep until the earliest reset.
    const snap = quotaSnapshot(providers);
    const wakeups = Object.values(snap).map((s) => s.nextEligibleAt).filter(Boolean);
    if (wakeups.length === 0) break; // nothing schedulable ever — statuses say why
    const wake = Math.min(...wakeups) + 60000; // minute of slack past the reset
    log(`all remaining work awaits quota — sleeping until ${new Date(wake).toISOString()}`);
    await new Promise((r) => setTimeout(r, Math.max(60000, wake - Date.now())));
  }
  log('queue drained (or nothing runnable without the user)');
  console.log(JSON.stringify({ tasks: statusTable(batch), quotas: quotaSnapshot(providers) }, null, 2));
} finally {
  cleanup();
}
