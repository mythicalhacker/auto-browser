// utils/login-check.js — Login detection for AI platform tabs
import { SELECTORS, PATTERNS } from '../config.js';
import { findFirst } from './selectors.js';

// URL patterns that indicate a login/auth page (not logged in)
const LOGIN_URL_PATTERNS = [
  '/login', '/signin', '/sign-in', '/auth', '/oauth',
  'accounts.google.com',
];

/**
 * Check whether a single model tab appears to be logged in.
 * A tab is considered logged in if its input selector is found on the page.
 * URL-based login page detection is used as a secondary signal.
 *
 * @param {import('playwright').Page} page
 * @param {'claude'|'chatgpt'|'gemini'} model
 * @returns {Promise<{loggedIn: boolean, reason: string}>}
 */
export async function checkLogin(page, model) {
  const selectors = SELECTORS[model];
  if (!selectors) {
    return { loggedIn: false, reason: `Unknown model: ${model}` };
  }

  // Secondary signal: URL looks like a login page
  try {
    const url = page.url().toLowerCase();
    for (const pattern of LOGIN_URL_PATTERNS) {
      if (url.includes(pattern)) {
        return { loggedIn: false, reason: `URL contains login pattern: ${pattern}` };
      }
    }
  } catch {
    // page.url() can throw if page is closed
  }

  // Primary signal: can we find the input element?
  try {
    const result = await findFirst(page, selectors.input);
    if (result) {
      return { loggedIn: true, reason: `Input found: ${result.selector}` };
    }
    return { loggedIn: false, reason: 'No input element found' };
  } catch {
    return { loggedIn: false, reason: 'Error querying page' };
  }
}

/**
 * Check login status for all provided model pages.
 *
 * @param {Object<string, import('playwright').Page>} pages — e.g. { claude: page, chatgpt: page, gemini: page }
 * @returns {Promise<{allLoggedIn: boolean, results: Object<string, {loggedIn: boolean, reason: string}>}>}
 */
export async function checkAllLogins(pages) {
  const entries = Object.entries(pages);
  const settled = await Promise.all(
    entries.map(async ([model, page]) => [model, await checkLogin(page, model)])
  );

  const results = Object.fromEntries(settled);
  const allLoggedIn = entries.length > 0 && settled.every(([, r]) => r.loggedIn);
  return { allLoggedIn, results };
}
