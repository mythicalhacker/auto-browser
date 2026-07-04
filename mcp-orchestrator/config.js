// config.js — Centralized configuration for MCP Orchestrator
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIG = Object.freeze({
  cdpUrl: process.env.CDP_URL || 'http://localhost:9222',
  stateFile: process.env.STATE_FILE || resolve(__dirname, 'consensus_state.json'),
  chromePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  chromeUserData: process.env.CHROME_USER_DATA || resolve(__dirname, '.chrome-debug'),
  timeouts: Object.freeze({
    response: Number(process.env.TIMEOUT_RESPONSE) || 120000,
    // Per-model response ceilings: extended-thinking models (GPT 5.5 Pro et
    // al.) routinely think for minutes, so the limit must fit the slowest
    // normal response, not the median. Precedence: TIMEOUT_RESPONSE_<MODEL>
    // env > TIMEOUT_RESPONSE env > per-model default. A per-call
    // response_timeout_ms tool argument beats all of these.
    responseByModel: Object.freeze({
      claude: Number(process.env.TIMEOUT_RESPONSE_CLAUDE) || Number(process.env.TIMEOUT_RESPONSE) || 300000,
      chatgpt: Number(process.env.TIMEOUT_RESPONSE_CHATGPT) || Number(process.env.TIMEOUT_RESPONSE) || 600000,
      gemini: Number(process.env.TIMEOUT_RESPONSE_GEMINI) || Number(process.env.TIMEOUT_RESPONSE) || 300000,
    }),
    navigation: Number(process.env.TIMEOUT_NAVIGATION) || 30000,
    action: Number(process.env.TIMEOUT_ACTION) || 10000,
    stabilityCheck: 1000,
    microDelay: 100,
  }),
});

export const PATTERNS = Object.freeze({
  claude: 'claude.ai',
  chatgpt: 'chatgpt.com',
  gemini: 'gemini.google.com',
});

export const SELECTORS = Object.freeze({
  claude: Object.freeze({
    input: Object.freeze(['.ProseMirror', 'div[contenteditable="true"]']),
    submit: Object.freeze(['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label="Send"]']),
    output: Object.freeze(['.font-claude-response .standard-markdown']),
    streaming: Object.freeze(['[data-is-streaming="true"]']),
  }),
  chatgpt: Object.freeze({
    input: Object.freeze(['#prompt-textarea', 'textarea[name="prompt-textarea"]', 'div[contenteditable="true"]']),
    submit: Object.freeze(['button[aria-label="Send prompt"]', 'button[data-testid="send-button"]', 'button[data-testid="composer-send-button"]']),
    output: Object.freeze(['[data-message-author-role="assistant"] .markdown', '[data-message-author-role="assistant"]']),
    streaming: Object.freeze(['button[aria-label="Stop streaming"]', 'button[data-testid="stop-button"]']),
  }),
  gemini: Object.freeze({
    input: Object.freeze(['div[contenteditable="true"].ql-editor', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]']),
    submit: Object.freeze(['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label="Submit"]']),
    output: Object.freeze(['.model-response-text .markdown-main-panel', 'message-content .markdown', '.response-content']),
    streaming: Object.freeze(['button[aria-label="Stop response"]', 'button[aria-label="Stop"]']),
  }),
});
