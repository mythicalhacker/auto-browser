/**
 * Tab Detection Test
 * Tests detection of Claude, ChatGPT, and Gemini tabs
 */

import { chromium } from "playwright";

const CDP_URL = "http://localhost:9222";

const TAB_PATTERNS = {
  claude: ["claude.ai"],
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  gemini: ["gemini.google.com", "bard.google.com"]
};

async function testTabDetection() {
  console.log("🧪 Tab Detection Test\n");
  
  const results = {
    claude: { found: false, url: null, ready: false },
    chatgpt: { found: false, url: null, ready: false },
    gemini: { found: false, url: null, ready: false }
  };
  
  // Connect to browser
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.log("✗ Cannot connect to Chrome. Run test-chrome.js first.");
    process.exit(1);
  }
  
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.log("✗ No browser contexts found");
    process.exit(1);
  }
  
  const pages = contexts[0].pages();
  console.log(`Found ${pages.length} open tab(s)\n`);
  
  // Find AI tabs
  for (const page of pages) {
    const url = page.url();
    
    for (const [model, patterns] of Object.entries(TAB_PATTERNS)) {
      if (patterns.some(p => url.includes(p)) && !results[model].found) {
        results[model].found = true;
        results[model].url = url;
        
        // Check if tab is ready (not on login page)
        try {
          const isLoginPage = await page.evaluate(() => {
            const url = window.location.href;
            return url.includes('login') || 
                   url.includes('signin') || 
                   url.includes('accounts.google.com');
          });
          results[model].ready = !isLoginPage;
        } catch (e) {
          results[model].ready = false;
        }
      }
    }
  }
  
  // Report results
  console.log("Tab Status:");
  console.log("─".repeat(50));
  
  for (const [model, status] of Object.entries(results)) {
    const icon = status.found ? (status.ready ? "✓" : "⚠") : "✗";
    const state = status.found 
      ? (status.ready ? "ready" : "needs login") 
      : "not found";
    
    console.log(`${icon} ${model.padEnd(10)} ${state}`);
    if (status.url) {
      const shortUrl = status.url.length > 40 
        ? status.url.substring(0, 40) + "..." 
        : status.url;
      console.log(`  └─ ${shortUrl}`);
    }
  }
  
  // Summary
  console.log("\n" + "─".repeat(50));
  const foundCount = Object.values(results).filter(r => r.found).length;
  const readyCount = Object.values(results).filter(r => r.ready).length;
  
  console.log(`Found: ${foundCount}/3 tabs`);
  console.log(`Ready: ${readyCount}/3 tabs`);
  
  if (readyCount === 3) {
    console.log("\n✅ All AI tabs detected and ready");
  } else if (foundCount === 3) {
    console.log("\n⚠️  All tabs found but some need login");
  } else {
    console.log("\n❌ Missing tabs. Please open:");
    if (!results.claude.found) console.log("   - https://claude.ai");
    if (!results.chatgpt.found) console.log("   - https://chatgpt.com");
    if (!results.gemini.found) console.log("   - https://gemini.google.com");
  }
  
  return results;
}

// Run test
testTabDetection()
  .then(results => {
    const allReady = Object.values(results).every(r => r.ready);
    process.exit(allReady ? 0 : 1);
  })
  .catch(e => {
    console.error("Test crashed:", e);
    process.exit(1);
  });
