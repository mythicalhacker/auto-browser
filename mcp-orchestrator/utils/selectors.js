// utils/selectors.js — Selector fallback helpers for array-based selector chains

/**
 * Find the first element matching any selector in the array (ordered fallback).
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @returns {Promise<{element: import('playwright').ElementHandle, selector: string} | null>}
 */
export async function findFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return { element: el, selector: sel };
    } catch {
      // Selector invalid or page context destroyed — try next
    }
  }
  return null;
}

/**
 * Find all elements matching any selector in the array (deduplicated).
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @returns {Promise<import('playwright').ElementHandle[]>}
 */
export async function findAll(page, selectors) {
  const seen = new Set();
  const results = [];

  for (const sel of selectors) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        // Use Playwright's internal node reference for dedup
        const id = await el.evaluate(node => {
          if (!node.__selectorDedup) node.__selectorDedup = Math.random().toString(36);
          return node.__selectorDedup;
        });
        if (!seen.has(id)) {
          seen.add(id);
          results.push(el);
        }
      }
    } catch {
      // Selector invalid or page context destroyed — try next
    }
  }

  return results;
}
