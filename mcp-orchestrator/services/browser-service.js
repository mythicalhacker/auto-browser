// services/browser-service.js — Singleton managing browser connection and page discovery
import { chromium } from 'playwright';
import { CONFIG, ENTRY_URLS } from '../config.js';
import { ensureChromeRunning } from '../utils/chrome-launcher.js';
import { withRetry } from '../utils/barrier.js';

class BrowserService {
  #browser = null;
  #pages = { claude: null, chatgpt: null, gemini: null };
  #connectPromise = null;

  async connect() {
    // Serialize concurrent connects: two parallel cold connects must not
    // both auto-launch a Chrome against the same profile and port.
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#doConnect().finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  async #doConnect() {
    // Re-discover pages if browser disconnected since last call
    if (this.#browser && !this.#browser.isConnected()) {
      this.#browser = null;
      this.#pages = { claude: null, chatgpt: null, gemini: null };
    }

    if (this.#browser) return this.#browser;

    let launchedHere = false;
    try {
      this.#browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
    } catch (connectErr) {
      // Cold start: no debug Chrome on the CDP port. Launch one ourselves
      // unless auto-launch is disabled, then retry the connection.
      if (!CONFIG.autoLaunchChrome) throw connectErr;
      // `launched` (not mere availability) gates tab auto-opening below: a
      // Chrome that appeared on the port between our probe and now is a
      // REUSED one and its tab set is not ours to change.
      const chrome = await ensureChromeRunning();
      if (!chrome.up) throw connectErr;
      launchedHere = chrome.launched;
      this.#browser = await withRetry(() => chromium.connectOverCDP(CONFIG.cdpUrl), {
        maxRetries: 3,
        initialDelay: 1000,
      });
    }

    this.#discoverPages();

    // Only a Chrome WE just launched gets missing model tabs opened
    // automatically: in a reused Chrome the open-tab set is the user's
    // choice, and the insufficient_models guard depends on reading it as-is.
    if (launchedHere) {
      const ctx = this.#browser.contexts()[0];
      for (const [model, url] of Object.entries(ENTRY_URLS)) {
        if (ctx && !this.#pages[model]) {
          try {
            const page = await ctx.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.navigation });
            await page.waitForTimeout(3000); // let the SPA settle
          } catch (e) {
            console.error(`[connect] could not open ${model} tab: ${e.message}`);
          }
        }
      }
      this.#discoverPages();
    }

    return this.#browser;
  }

  #discoverPages() {
    const contexts = this.#browser.contexts();
    if (contexts.length === 0) return;
    const allPages = contexts[0].pages();

    // For Claude, prefer chat pages over other claude.ai pages
    const claudeChatPage = allPages.find(p => p.url().includes('claude.ai/chat/'));
    const claudeAnyPage = allPages.find(p => p.url().includes('claude.ai') && !p.url().includes('/chrome/'));
    this.#pages.claude = claudeChatPage || claudeAnyPage || null;

    // For ChatGPT and Gemini, find any matching page
    this.#pages.chatgpt = allPages.find(p => p.url().includes('chatgpt.com')) || null;
    this.#pages.gemini = allPages.find(p => p.url().includes('gemini.google.com')) || null;
  }

  getPage(model) {
    return this.#pages[model] || null;
  }

  getActiveModels() {
    return Object.keys(this.#pages).filter(m => this.#pages[m]);
  }

  getAllPages() {
    if (!this.#browser || !this.#browser.isConnected()) return [];
    const contexts = this.#browser.contexts();
    if (contexts.length === 0) return [];
    return contexts[0].pages();
  }

  getPageByIndex(index = 0) {
    const pages = this.getAllPages();
    if (index < 0 || index >= pages.length) return null;
    return pages[index];
  }

  isConnected() {
    return !!(this.#browser && this.#browser.isConnected());
  }

  async disconnect() {
    if (this.#browser) {
      try {
        if (this.#browser.isConnected()) {
          // For a connectOverCDP browser, close() only drops the CDP
          // websocket — it does NOT terminate the user's Chrome. (Playwright
          // has no Browser.disconnect(); calling it threw on every cleanup.)
          await this.#browser.close();
        }
      } catch (e) {
        console.error('[cleanup] Browser close error (non-fatal):', e.message);
      }
      this.#browser = null;
      this.#pages = { claude: null, chatgpt: null, gemini: null };
    }
  }
}

export const browserService = new BrowserService();
