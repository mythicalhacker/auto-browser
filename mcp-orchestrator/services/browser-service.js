// services/browser-service.js — Singleton managing browser connection and page discovery
import { chromium } from 'playwright';
import { CONFIG, PATTERNS } from '../config.js';

class BrowserService {
  #browser = null;
  #pages = { claude: null, chatgpt: null, gemini: null };

  async connect() {
    // Re-discover pages if browser disconnected since last call
    if (this.#browser && !this.#browser.isConnected()) {
      this.#browser = null;
      this.#pages = { claude: null, chatgpt: null, gemini: null };
    }

    if (this.#browser) return this.#browser;

    this.#browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
    const contexts = this.#browser.contexts();
    if (contexts.length > 0) {
      const allPages = contexts[0].pages();

      // For Claude, prefer chat pages over other claude.ai pages
      const claudeChatPage = allPages.find(p => p.url().includes('claude.ai/chat/'));
      const claudeAnyPage = allPages.find(p => p.url().includes('claude.ai') && !p.url().includes('/chrome/'));
      this.#pages.claude = claudeChatPage || claudeAnyPage || null;

      // For ChatGPT and Gemini, find any matching page
      this.#pages.chatgpt = allPages.find(p => p.url().includes('chatgpt.com')) || null;
      this.#pages.gemini = allPages.find(p => p.url().includes('gemini.google.com')) || null;
    }

    return this.#browser;
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
          await this.#browser.disconnect(); // disconnect, don't close — close kills the user's Chrome
        }
      } catch (e) {
        console.error('[cleanup] Browser disconnect error (non-fatal):', e.message);
      }
      this.#browser = null;
      this.#pages = { claude: null, chatgpt: null, gemini: null };
    }
  }
}

export const browserService = new BrowserService();
