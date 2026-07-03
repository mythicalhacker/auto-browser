/**
 * Selector Test
 * Tests UI selectors for all 3 AI models
 * This is the most important test - selectors break often!
 */

import { chromium } from "playwright";

const CDP_URL = "http://localhost:9222";

// Current selectors (update these when UI changes)
// Order matters - first working selector wins
const SELECTORS = {
  claude: {
    input: [
      '.ProseMirror',
      'div[contenteditable="true"]',
      '[data-placeholder*="Reply"]'
    ],
    submit: [
      'button[aria-label="Send message"]',  // Current working selector (lowercase 'm')
      'button[aria-label="Send Message"]',
      'button[aria-label="Send"]'
    ],
    output: [
      '.font-claude-response .standard-markdown',  // Primary: verified working (excludes thinking)
      '.standard-markdown',                        // Fallback 1: simpler selector
      '.font-claude-response-body',                // Fallback 2: paragraph level
    ],
    streaming: [
      '[data-is-streaming="true"]',
      '[data-testid="stop-button"]'
    ]
  },
  chatgpt: {
    input: [
      '#prompt-textarea',
      'textarea[name="prompt-textarea"]',
      'textarea[data-id="root"]',
      'div[contenteditable="true"]'
    ],
    submit: [
      'button[aria-label="Send prompt"]',  // Current working selector
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]'
    ],
    output: [
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
      '.agent-turn .markdown'
    ],
    streaming: [
      'button[aria-label="Stop streaming"]',
      'button[data-testid="stop-button"]'
    ]
  },
  gemini: {
    input: [
      'div[contenteditable="true"].ql-editor',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    submit: [
      'button[aria-label="Send message"]',
      'button.send-button',
      'button[aria-label="Submit"]'
    ],
    output: [
      '.model-response-text .markdown-main-panel',
      'message-content .markdown',
      '.response-content'
    ],
    streaming: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop"]'
    ]
  }
};

const TAB_PATTERNS = {
  claude: "claude.ai",
  chatgpt: "chatgpt.com",
  gemini: "gemini.google.com"
};

async function testSelectors() {
  console.log("🧪 Selector Test\n");
  
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.log("✗ Cannot connect to Chrome");
    process.exit(1);
  }
  
  const pages = browser.contexts()[0]?.pages() || [];
  const modelPages = {};

  // Find pages - prefer chat pages for Claude
  const claudeChatPage = pages.find(p => p.url().includes("claude.ai/chat/"));
  const claudeAnyPage = pages.find(p => p.url().includes("claude.ai") && !p.url().includes("/chrome/"));
  modelPages.claude = claudeChatPage || claudeAnyPage || null;

  modelPages.chatgpt = pages.find(p => p.url().includes("chatgpt.com")) || null;
  modelPages.gemini = pages.find(p => p.url().includes("gemini.google.com")) || null;
  
  const results = {};
  
  for (const [model, selectors] of Object.entries(SELECTORS)) {
    const page = modelPages[model];
    results[model] = { input: null, submit: null, output: null, streaming: null };
    
    console.log(`\n${model.toUpperCase()}`);
    console.log("─".repeat(30));
    
    if (!page) {
      console.log("  ✗ Tab not found");
      continue;
    }
    
    // Test input selector
    let inputEl = null;
    for (const sel of selectors.input) {
      try {
        const el = await page.$(sel);
        if (el) {
          results[model].input = sel;
          inputEl = el;
          console.log(`  ✓ Input: ${sel}`);
          break;
        }
      } catch {}
    }
    if (!results[model].input) {
      console.log(`  ✗ Input: No working selector found`);
    }

    // Type text to reveal send button (some UIs only show it with text)
    if (inputEl) {
      try {
        await inputEl.click();
        await page.keyboard.type("test");
        await page.waitForTimeout(300);
      } catch {}
    }

    // Test submit selector
    for (const sel of selectors.submit) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          results[model].submit = sel;
          console.log(`  ✓ Submit: ${sel}${visible ? "" : " (hidden until text)"}`);
          break;
        }
      } catch {}
    }
    if (!results[model].submit) {
      console.log(`  ✗ Submit: No working selector found`);
    }

    // Clear the typed text
    if (inputEl) {
      try {
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Backspace");
      } catch {}
    }
    
    // Test output selector
    for (const sel of selectors.output) {
      try {
        const els = await page.$$(sel);
        if (els.length > 0) {
          results[model].output = sel;
          console.log(`  ✓ Output: ${sel} (${els.length} found)`);
          break;
        }
      } catch {}
    }
    if (!results[model].output) {
      console.log(`  ✗ Output: No working selector found`);
      console.log(`    (This may be OK if no messages exist yet)`);
    }
    
    // Test streaming selector (only check existence, not visibility)
    for (const sel of selectors.streaming) {
      try {
        // Just check if selector is valid
        await page.$(sel);
        results[model].streaming = sel;
        console.log(`  ✓ Streaming: ${sel} (selector valid)`);
        break;
      } catch {}
    }
    if (!results[model].streaming) {
      console.log(`  ✗ Streaming: No working selector found`);
    }
  }
  
  // Summary
  console.log("\n" + "═".repeat(40));
  console.log("SUMMARY");
  console.log("═".repeat(40));
  
  let totalWorking = 0;
  let totalRequired = 0;
  
  for (const [model, sels] of Object.entries(results)) {
    const working = [sels.input, sels.submit].filter(Boolean).length;
    const required = 2; // input + submit are required
    totalWorking += working;
    totalRequired += required;
    
    const status = working === required ? "✓" : "✗";
    console.log(`${status} ${model}: ${working}/${required} required selectors`);
  }
  
  if (totalWorking === totalRequired) {
    console.log("\n✅ All required selectors working");
  } else {
    console.log("\n❌ Some selectors need updating");
    console.log("   Update SELECTORS in server.js");
  }
  
  return results;
}

// Export for use in other tests
export { SELECTORS };

// Run test
testSelectors()
  .then(results => {
    const allWorking = Object.values(results).every(r => r.input && r.submit);
    process.exit(allWorking ? 0 : 1);
  })
  .catch(e => {
    console.error("Test crashed:", e);
    process.exit(1);
  });
