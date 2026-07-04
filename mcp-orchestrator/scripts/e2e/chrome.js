// scripts/e2e/chrome.js — Debug-Chrome lifecycle for e2e tests.
// Policy: if port 9222 is already serving CDP we REUSE that Chrome and never
// kill it or close its tabs; we only ever stop/manage a Chrome we spawned
// ourselves (pid recorded in .state/chrome.pid).
import { spawn, spawnSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { chromium } from 'playwright';
import { CONFIG, PATTERNS } from '../../config.js';
import { getRegistry } from '../../models/registry.js';
import { checkAllLogins } from '../../utils/login-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '.state');
const PID_FILE = join(STATE_DIR, 'chrome.pid');

const CDP_URL = CONFIG.cdpUrl;
const CHROME_BIN =
  process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)
    ? process.env.CHROME_PATH
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Entry URLs per provider, straight from the registry (keys double as the
// harness's canonical model set).
export const MODEL_URLS = Object.fromEntries(
  Object.entries(getRegistry()).map(([model, d]) => [model, d.entryUrl])
);

export async function cdpReady(timeoutMs = 1500) {
  return (await cdpVersion(timeoutMs)) !== null;
}

async function cdpVersion(timeoutMs = 1500) {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function readOwnership() {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a debug Chrome is serving CDP. Reuses an existing one (never killed
 * by us); otherwise spawns the macOS binary against `profileDir`.
 * @returns {{reused: boolean, pid: number|null}}
 */
export async function ensureChrome({ profileDir } = {}) {
  const existing = await cdpVersion();
  if (existing) {
    // Reused Chrome. If a stale ownership record points at a dead pid or a
    // different browser instance, clear it so we can never claim this one.
    const own = readOwnership();
    if (own && (!pidAlive(own.pid) || own.wsUrl !== existing.webSocketDebuggerUrl)) {
      unlinkSync(PID_FILE);
    }
    return { reused: true, pid: null };
  }

  const profile = resolve(profileDir || CONFIG.chromeUserData);
  mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(
    CHROME_BIN,
    [
      '--remote-debugging-port=9222',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const version = await cdpVersion();
    if (version) {
      // Ownership recorded only once CDP is confirmed up, keyed to THIS
      // browser instance's websocket GUID — a later user-started Chrome on
      // the same port can never match.
      writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, wsUrl: version.webSocketDebuggerUrl }));
      return { reused: false, pid: child.pid };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Chrome CDP did not become ready within 45s');
}

/**
 * Adopt an already-running Chrome as harness-owned. Used after gateColdStart:
 * the SERVER (a child we spawned and killed) auto-launched Chrome detached,
 * so no pid record exists and cleanup/re-runs would be blocked. Adoption
 * demands proof it is ours: the process listening on the CDP port must carry
 * `mustIncludeArg` (e.g. our profile path) on its command line.
 * @returns {Promise<boolean>} true if ownership was recorded
 */
export async function adoptRunningChrome(mustIncludeArg) {
  const version = await cdpVersion();
  if (!version) return false;
  let port = '9222';
  try {
    port = new URL(CDP_URL).port || '9222';
  } catch {
    // keep default
  }
  const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pids = (lsof.stdout || '').trim().split('\n').filter(Boolean).map(Number);
  for (const pid of pids) {
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if ((ps.stdout || '').includes(mustIncludeArg)) {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(PID_FILE, JSON.stringify({ pid, wsUrl: version.webSocketDebuggerUrl }));
      return true;
    }
  }
  return false;
}

/** True only if the CURRENT Chrome on :9222 is one this harness spawned. */
export async function weSpawnedChrome() {
  const own = readOwnership();
  if (!own || !pidAlive(own.pid)) return false;
  const version = await cdpVersion();
  return !!version && version.webSocketDebuggerUrl === own.wsUrl;
}

/** Stop ONLY a Chrome this harness spawned. No-op for a reused Chrome. */
export async function stopSpawnedChrome() {
  if (!(await weSpawnedChrome())) {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE); // stale record
    return false;
  }
  const { pid } = readOwnership();
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (await cdpReady(500))) {
    await new Promise((r) => setTimeout(r, 500));
  }
  unlinkSync(PID_FILE);
  return true;
}

/**
 * Connect over CDP and make sure a tab exists for each requested model,
 * opening missing ones. Never closes anything.
 * @param {string[]} models — subset of Object.keys(MODEL_URLS)
 * @returns {{browser, pages: Object<string, import('playwright').Page>}}
 */
export async function ensureModelTabs(models = Object.keys(MODEL_URLS)) {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP browser has no default context');
  const pages = {};
  for (const model of models) {
    const pattern = PATTERNS[model];
    let page = ctx.pages().find((p) => p.url().includes(pattern));
    if (!page) {
      page = await ctx.newPage();
      await page.goto(MODEL_URLS[model], { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000); // let the SPA settle before selector queries
    }
    pages[model] = page;
  }
  return { browser, pages };
}

/**
 * Navigate each open model tab to its new-chat entry URL. Live consensus
 * gates call this first so a PRIOR gate's conversation can never satisfy
 * waitForComplete's count check and be extracted as a fresh response
 * (observed live 2026-07-04: race-gate sentinel returned as round-1 output).
 * Never closes tabs; never touches non-model tabs.
 */
export async function freshModelChats() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    for (const page of ctx ? ctx.pages() : []) {
      const url = page.url();
      for (const [model, pattern] of Object.entries(PATTERNS)) {
        if (url.includes(pattern)) {
          // Mirror the product's discovery rule: excluded paths (e.g. the
          // claude.ai/chrome/* extension pages) are NOT model tabs — never
          // navigate one.
          const excludes = getRegistry()[model]?.excludePathPatterns ?? [];
          if (excludes.some((frag) => url.includes(frag))) continue;
          await page.goto(MODEL_URLS[model], { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3000); // SPA settle before selector queries
        }
      }
    }
  } finally {
    await browser.close();
  }
}

/** List which models currently have an open tab (no side effects). */
export async function openModelTabs() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx ? ctx.pages() : [];
    const result = {};
    for (const [model, pattern] of Object.entries(PATTERNS)) {
      const page = pages.find((p) => p.url().includes(pattern));
      if (page) result[model] = page;
    }
    return result;
  } finally {
    await browser.close(); // closes the CDP connection only, not Chrome
  }
}

/**
 * Close model tabs so that only `keep` remains open. ONLY permitted in a
 * Chrome this harness spawned (session-restored tabs of our own launch);
 * throws if the Chrome was reused.
 */
export async function reduceModelTabsTo(keep) {
  if (!(await weSpawnedChrome())) {
    throw new Error('refusing to close tabs in a Chrome this harness did not spawn');
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const ctx = browser.contexts()[0];
    for (const page of ctx.pages()) {
      const url = page.url();
      for (const [model, pattern] of Object.entries(PATTERNS)) {
        if (model !== keep && url.includes(pattern)) {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

/** Login status for the given pages map, via the production login-check. */
export async function loginStatus(pages) {
  return checkAllLogins(pages);
}
