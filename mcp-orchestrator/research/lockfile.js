// research/lockfile.js — cross-process single-drain guard for the research
// queue. The in-process single-flight (consensus runActive) cannot see a
// second PROCESS: the MCP server and the headless runner share the persisted
// queue, so whoever drains takes ~/.auto-browser/research/runner.lock
// ({pid, startedAt}); a live pid refuses, a dead pid's lock is taken over.
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { RESEARCH_HOME } from './research-queue.js';

const LOCK_FILE = join(RESEARCH_HOME, 'runner.lock');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Atomic exclusive create ('wx' → O_EXCL). Returns true on success, false
 * if the file already exists (loser of a create race). */
function tryCreateLock(payload) {
  let fd;
  try {
    fd = openSync(LOCK_FILE, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeFileSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Acquire the cross-process drain lock atomically. Two runners starting at
 * the same instant cannot both win: exactly one O_EXCL create succeeds; the
 * loser reads the holder and refuses (live pid) or takes over (dead pid).
 * @returns {{ok: true, takeover: boolean} | {ok: false, holder: {pid, startedAt}}}
 */
export function acquireDrainLock(now = Date.now()) {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: now });

  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreateLock(payload)) return { ok: true, takeover: attempt > 0 };

    let holder = null;
    try {
      holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      holder = null; // unreadable/torn → treat as stale
    }
    if (holder && Number.isInteger(holder.pid)) {
      if (holder.pid === process.pid) return { ok: true, takeover: false }; // re-entrant same pid
      if (pidAlive(holder.pid)) return { ok: false, holder };
    }
    // Stale (dead pid / unreadable): remove and retry the atomic create. If a
    // third process removes it first, our next create wins or we re-read.
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // someone else already cleared it — loop and retry create
    }
  }
  // Contended beyond retries: report the current holder rather than clobber.
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    holder = { pid: -1, startedAt: now };
  }
  return { ok: false, holder };
}

export function releaseDrainLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const holder = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (holder.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    // releasing best-effort; a dead-pid lock is recoverable anyway
  }
}
