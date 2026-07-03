/**
 * 2+2 End-to-End Test
 * Simple consensus test to verify full system works
 */

import { chromium } from "playwright";

const CDP_URL = "http://localhost:9222";
const PROMPT = "What is 2+2? Reply with ONLY the number, nothing else.";
const EXPECTED = "4";
const TIMEOUT = 60000;

const TAB_PATTERNS = {
  claude: "claude.ai",
  chatgpt: "chatgpt.com",
  gemini: "gemini.google.com"
};

// Selectors - updated Jan 2026
const SELECTORS = {
  claude: {
    input: '.ProseMirror, div[contenteditable="true"]',
    submit: 'button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label="Send"]',
    output: '.font-claude-response .standard-markdown'  // Response content only (excludes thinking)
  },
  chatgpt: {
    input: '#prompt-textarea, div[contenteditable="true"]',
    submit: 'button[aria-label="Send prompt"], button[data-testid="send-button"]',
    output: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"]'
  },
  gemini: {
    input: 'div[contenteditable="true"].ql-editor, rich-textarea div[contenteditable="true"], div[contenteditable="true"]',
    submit: 'button[aria-label="Send message"], button[aria-label="Submit"]',
    output: '.model-response-text .markdown-main-panel, message-content .markdown, .response-content'
  }
};

async function test2Plus2() {
  console.log("🧪 2+2 End-to-End Test\n");
  console.log(`Prompt: "${PROMPT}"`);
  console.log(`Expected: "${EXPECTED}"`);
  console.log(`Timeout: ${TIMEOUT/1000}s\n`);
  
  const startTime = Date.now();
  
  // Connect
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.log("✗ Cannot connect to Chrome");
    process.exit(1);
  }
  
  // Find tabs - prefer chat pages for Claude
  const pages = browser.contexts()[0]?.pages() || [];
  const modelPages = {};

  // Claude: prefer /chat/ pages over other claude.ai pages
  const claudeChatPage = pages.find(p => p.url().includes("claude.ai/chat/"));
  const claudeAnyPage = pages.find(p => p.url().includes("claude.ai") && !p.url().includes("/chrome/"));
  modelPages.claude = claudeChatPage || claudeAnyPage || null;

  modelPages.chatgpt = pages.find(p => p.url().includes("chatgpt.com")) || null;
  modelPages.gemini = pages.find(p => p.url().includes("gemini.google.com")) || null;

  // Remove null entries
  for (const [model, page] of Object.entries(modelPages)) {
    if (!page) delete modelPages[model];
  }
  
  const models = Object.keys(modelPages);
  console.log(`Found tabs: ${models.join(", ")}\n`);
  
  if (models.length === 0) {
    console.log("✗ No AI tabs found");
    process.exit(1);
  }
  
  // Get initial output counts
  const initialCounts = {};
  for (const [model, page] of Object.entries(modelPages)) {
    try {
      const els = await page.$$(SELECTORS[model].output);
      initialCounts[model] = els.length;
    } catch {
      initialCounts[model] = 0;
    }
  }
  
  // Send prompts - use direct typing for reliability
  console.log("Sending prompts...");
  for (const [model, page] of Object.entries(modelPages)) {
    try {
      const sel = SELECTORS[model];

      // Click input
      const input = await page.$(sel.input);
      if (!input) {
        console.log(`  ✗ ${model}: input not found`);
        continue;
      }
      await input.click();
      await page.waitForTimeout(200);

      // Type prompt directly (more reliable than clipboard)
      await page.keyboard.type(PROMPT, { delay: 5 });
      await page.waitForTimeout(300);

      // Submit - wait for button to become enabled
      await page.waitForTimeout(200);
      const btn = await page.$(sel.submit);
      if (btn) {
        const disabled = await btn.isDisabled().catch(() => false);
        if (!disabled) {
          await btn.click({ force: true });
        } else {
          await page.keyboard.press("Enter");
        }
      } else {
        await page.keyboard.press("Enter");
      }

      console.log(`  ✓ ${model}: sent`);
    } catch (e) {
      console.log(`  ✗ ${model}: ${e.message}`);
    }
  }
  
  // Wait for responses
  console.log("\nWaiting for responses...");
  const results = {};
  
  await Promise.all(Object.entries(modelPages).map(async ([model, page]) => {
    const waitStart = Date.now();
    const sel = SELECTORS[model];

    while (Date.now() - startTime < TIMEOUT) {
      try {
        const els = await page.$$(sel.output);
        if (els.length > initialCounts[model]) {
          // New message appeared, wait for non-empty content
          let text = "";
          let attempts = 0;
          while (attempts < 20 && Date.now() - startTime < TIMEOUT) {
            await page.waitForTimeout(500);
            const freshEls = await page.$$(sel.output);
            text = (await freshEls[freshEls.length - 1].innerText()).trim();
            if (text.length > 0) break;
            attempts++;
          }

          // ChatGPT thinking-mode workaround: DOM empties after streaming.
          // Reload forces React to re-render from server state.
          if (!text && model === 'chatgpt') {
            console.log(`  ⟳ ${model}: empty after streaming, reloading...`);
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);
            const reloadEls = await page.$$(sel.output);
            if (reloadEls.length > 0) {
              text = (await reloadEls[reloadEls.length - 1].innerText()).trim();
            }
          }

          results[model] = {
            success: text.length > 0,
            output: text || null,
            time: Date.now() - waitStart
          };
          return;
        }
      } catch {}
      await page.waitForTimeout(500);
    }

    results[model] = {
      success: false,
      output: null,
      time: TIMEOUT
    };
  }));
  
  // Report results
  console.log("\nResults:");
  console.log("─".repeat(50));
  
  let passed = 0;
  for (const [model, result] of Object.entries(results)) {
    const time = (result.time / 1000).toFixed(1);
    const output = result.output?.substring(0, 50) || "NO RESPONSE";
    const hasExpected = result.output?.includes(EXPECTED);
    
    if (result.success && hasExpected) {
      console.log(`✓ ${model.padEnd(10)} (${time}s): "${output}"`);
      passed++;
    } else if (result.success) {
      console.log(`⚠ ${model.padEnd(10)} (${time}s): "${output}" (expected "${EXPECTED}")`);
    } else {
      console.log(`✗ ${model.padEnd(10)} (${time}s): TIMEOUT`);
    }
  }
  
  // Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "─".repeat(50));
  console.log(`Total time: ${totalTime}s`);
  console.log(`Passed: ${passed}/${Object.keys(results).length}`);
  
  if (passed === Object.keys(results).length) {
    console.log("\n✅ All models returned correct answer");
    return true;
  } else {
    console.log("\n❌ Some models failed");
    return false;
  }
}

// Run test
test2Plus2()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(e => {
    console.error("Test crashed:", e);
    process.exit(1);
  });
