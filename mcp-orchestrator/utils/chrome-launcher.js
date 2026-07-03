// utils/chrome-launcher.js - Auto-launch Chrome with CDP debugging port
import { exec } from 'child_process';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { CONFIG } from '../config.js';

const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = '9222';

function parseCdpTarget(cdpUrl) {
  const fallback = { protocol: 'http:', host: DEFAULT_CDP_HOST, port: DEFAULT_CDP_PORT };

  if (!cdpUrl || typeof cdpUrl !== 'string') {
    console.error('[chrome-launcher] CONFIG.cdpUrl missing or invalid; using default 127.0.0.1:9222');
    return fallback;
  }

  let url;
  try {
    url = new URL(cdpUrl);
  } catch {
    try {
      url = new URL(`http://${cdpUrl}`);
    } catch {
      console.error('[chrome-launcher] CONFIG.cdpUrl could not be parsed; using default 127.0.0.1:9222');
      return fallback;
    }
  }

  return {
    protocol: url.protocol || fallback.protocol,
    host: url.hostname || fallback.host,
    port: url.port || fallback.port
  };
}

async function isCdpAvailable(protocol, host, port, timeoutMs = 2000) {
  const path = '/json/version';
  const targetUrl = `${protocol}//${host}:${port}${path}`;

  if (typeof fetch === 'function') {
    let timeoutId;
    let signal;

    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs);
    } else if (typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      signal = controller.signal;
    }

    try {
      const response = await fetch(targetUrl, { signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  const isHttps = protocol === 'https:';
  const request = isHttps ? httpsRequest : httpRequest;

  return await new Promise((resolve) => {
    const req = request(
      { hostname: host, port: Number(port), path, method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Attempt to connect to Chrome CDP. If connection fails, launch Chrome with debug flags.
 * Returns true if Chrome is ready (either already running or just launched).
 *
 * @param {number} maxWaitMs - Maximum time to wait for Chrome to start (default: 5000)
 * @returns {Promise<boolean>}
 */
export async function ensureChromeRunning(maxWaitMs = 5000) {
  const { protocol, host, port } = parseCdpTarget(CONFIG.cdpUrl);
  console.error(`[chrome-launcher] CDP target ${protocol}//${host}:${port}`);

  if (await isCdpAvailable(protocol, host, port)) {
    console.error('[chrome-launcher] Chrome already running on CDP port ' + port);
    return true;
  }

  const chromePath = CONFIG.chromePath;
  const userDataDir = CONFIG.chromeUserData;

  if (!chromePath || !userDataDir) {
    console.error('[chrome-launcher] Missing CONFIG.chromePath or CONFIG.chromeUserData; cannot launch Chrome');
    return false;
  }

  console.error('[chrome-launcher] Chrome not found on CDP target, launching...');
  const cmd = `start "" "${chromePath}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}"`;

  exec(cmd, (error) => {
    if (error) {
      console.error('[chrome-launcher] Failed to launch Chrome:', error.message);
    }
  });

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 500));
    if (await isCdpAvailable(protocol, host, port)) {
      console.error('[chrome-launcher] Chrome started successfully');
      return true;
    }
  }

  console.error('[chrome-launcher] Chrome did not start within ' + maxWaitMs + 'ms');
  return false;
}
