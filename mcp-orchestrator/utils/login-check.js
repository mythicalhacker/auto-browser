// utils/login-check.js — Login detection for AI platform tabs
import { getProvider, loginUrlPatternsFor } from '../models/registry.js';
import { findFirst } from './selectors.js';

/**
 * Check whether a single model tab appears to be logged in.
 * A tab is considered logged in if its input selector is found on the page.
 * URL-based login page detection is used as a secondary signal.
 *
 * @param {import('playwright').Page} page
 * @param {string} model — a registry provider name
 * @returns {Promise<{loggedIn: boolean, reason: string}>}
 */
export async function checkLogin(page, model) {
  const provider = getProvider(model);
  if (!provider) {
    return { loggedIn: false, reason: `Unknown model: ${model}` };
  }

  // Secondary signal: URL looks like a login page
  try {
    const url = page.url().toLowerCase();
    for (const pattern of loginUrlPatternsFor(model)) {
      if (url.includes(pattern)) {
        return { loggedIn: false, reason: `URL contains login pattern: ${pattern}` };
      }
    }
  } catch {
    // page.url() can throw if page is closed
  }

  // Primary signal: can we find the input element?
  try {
    const result = await findFirst(page, provider.selectors.input);
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
 * @param {Object<string, import('playwright').Page>} pages — keyed by registry provider name
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
