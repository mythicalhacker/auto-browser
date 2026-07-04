// utils/chrome-launcher.js — Auto-launch the debug Chrome with a CDP port.
// Cross-platform: child_process.spawn (detached, no shell) — never the
// Windows-only exec('start "" ...') this file used before.
import { spawn } from 'child_process';
import { statSync, mkdirSync } from 'fs';
import { CONFIG } from '../config.js';

const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = '9222';

export function parseCdpTarget(cdpUrl) {
  const fallback = { protocol: 'http:', host: DEFAULT_CDP_HOST, port: DEFAULT_CDP_PORT };
  if (!cdpUrl || typeof cdpUrl !== 'string') return fallback;
  // 'localhost:9223' parses as a URL with protocol 'localhost:' — only accept
  // http(s), otherwise re-parse with an explicit scheme.
  let url = null;
  try {
    url = new URL(cdpUrl);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol)) {
    try {
      url = new URL(`http://${cdpUrl}`);
    } catch {
      return fallback;
    }
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return fallback;
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || fallback.port,
  };
}

async function isCdpAvailable(protocol, host, port, timeoutMs = 2000) {
  try {
    const r = await fetch(`${protocol}//${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure a debug Chrome serves CDP: reuse a running one (never killed by
 * us), else spawn the configured binary detached against the configured
 * profile and poll until ready.
 * @returns {Promise<{up: boolean, launched: boolean}>}
 *   up       — CDP answers on the configured target
 *   launched — WE spawned this Chrome (false for a reused one; callers must
 *              not treat a reused Chrome's tab set as theirs to change)
 */
export async function ensureChromeRunning(maxWaitMs = 45000) {
  const { protocol, host, port } = parseCdpTarget(CONFIG.cdpUrl);

  if (await isCdpAvailable(protocol, host, port)) {
    return { up: true, launched: false };
  }

  const chromePath = CONFIG.chromePath;
  const userDataDir = CONFIG.chromeUserData;
  let stat = null;
  try {
    stat = statSync(chromePath);
  } catch {
    stat = null;
  }
  // isFile: existsSync alone passes for the .app bundle DIRECTORY on macOS,
  // which spawn cannot execute.
  if (!stat || !stat.isFile()) {
    console.error(`[chrome-launcher] Chrome binary not found at '${chromePath}' — set CHROME_PATH`);
    return { up: false, launched: false };
  }

  mkdirSync(userDataDir, { recursive: true });
  console.error(`[chrome-launcher] launching Chrome with profile ${userDataDir}`);
  let spawnFailed = false;
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.on('error', (e) => {
    spawnFailed = true;
    console.error(`[chrome-launcher] spawn failed: ${e.message}`);
  });
  child.unref();

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (spawnFailed) return { up: false, launched: true };
    await new Promise((r) => setTimeout(r, 500));
    if (await isCdpAvailable(protocol, host, port)) {
      console.error('[chrome-launcher] Chrome CDP ready');
      return { up: true, launched: true };
    }
  }
  console.error(`[chrome-launcher] Chrome did not serve CDP within ${maxWaitMs}ms`);
  return { up: false, launched: true };
}
