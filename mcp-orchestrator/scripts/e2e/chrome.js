// scripts/e2e/chrome.js — Debug-Chrome lifecycle for e2e tests.
// Policy: if port 9222 is already serving CDP we REUSE that Chrome and never
// kill it or close its tabs; we only ever stop/manage a Chrome we spawned
// ourselves (pid recorded in .state/chrome.pid).
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { chromium } from 'playwright';
import { CONFIG, PATTERNS } from '../../config.js';
import { checkAllLogins } from '../../utils/login-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '.state');
const PID_FILE = join(STATE_DIR, 'chrome.pid');

const CDP_URL = CONFIG.cdpUrl;
const CHROME_BIN =
  process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)
    ? process.env.CHROME_PATH
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const MODEL_URLS = {
  claude: 'https://claude.ai',
  chatgpt: 'https://chatgpt.com',
  gemini: 'https://gemini.google.com',
};

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
