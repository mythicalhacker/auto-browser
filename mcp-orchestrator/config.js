// config.js — Centralized configuration for MCP Orchestrator.
// Provider-specific facts (URL patterns, entry URLs, selectors, per-model
// timeout defaults) live in models/registry.js; this module layers env-var
// precedence on top and re-exports the legacy provider-keyed views so
// existing imports keep working unchanged.
import { join } from 'path';
import { homedir } from 'os';
import {
  patternsView, entryUrlsView, selectorsView, responseTimeoutDefaults, providerNames,
} from './models/registry.js';

// Runtime artifacts (the debug profile with live logins, consensus state)
// live OUTSIDE the repo by default.
const AUTO_BROWSER_HOME = join(homedir(), '.auto-browser');

function defaultChromePath() {
  switch (process.platform) {
    case 'darwin': return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32': return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    default: return '/usr/bin/google-chrome';
  }
}

// Per-model response ceilings: extended-thinking models (GPT 5.5 Pro et al.)
// routinely think for minutes, so the limit must fit the slowest normal
// response, not the median. Precedence: TIMEOUT_RESPONSE_<MODEL> env >
// TIMEOUT_RESPONSE env > registry descriptor default. A per-call
// response_timeout_ms tool argument beats all of these.
function buildResponseByModel() {
  const defaults = responseTimeoutDefaults();
  return Object.freeze(Object.fromEntries(providerNames().map((model) => [
    model,
    Number(process.env[`TIMEOUT_RESPONSE_${model.toUpperCase()}`])
      || Number(process.env.TIMEOUT_RESPONSE)
      || defaults[model]
      || 300000,
  ])));
}

export const CONFIG = Object.freeze({
  cdpUrl: process.env.CDP_URL || 'http://localhost:9222',
  stateFile: process.env.STATE_FILE || join(AUTO_BROWSER_HOME, 'consensus_state.json'),
  chromePath: process.env.CHROME_PATH || defaultChromePath(),
  chromeUserData: process.env.CHROME_USER_DATA || join(AUTO_BROWSER_HOME, 'chrome-profile'),
  autoLaunchChrome: process.env.AUTO_LAUNCH_CHROME !== '0',
  timeouts: Object.freeze({
    response: Number(process.env.TIMEOUT_RESPONSE) || 120000,
    responseByModel: buildResponseByModel(),
    navigation: Number(process.env.TIMEOUT_NAVIGATION) || 30000,
    action: Number(process.env.TIMEOUT_ACTION) || 10000,
    stabilityCheck: 1000,
    microDelay: 100,
  }),
});

// Legacy registry views. The registry deep-freezes descriptor internals
// (selector arrays are already frozen); freeze the view wrappers here.
export const PATTERNS = Object.freeze(patternsView());

// Entry URLs used when the auto-launched Chrome is missing a model tab.
export const ENTRY_URLS = Object.freeze(entryUrlsView());

const selectors = selectorsView();
for (const model of Object.keys(selectors)) Object.freeze(selectors[model]);
export const SELECTORS = Object.freeze(selectors);
