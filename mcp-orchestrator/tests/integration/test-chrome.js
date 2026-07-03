/**
 * Chrome Connection Test
 * Tests CDP connection to Chrome browser
 * 
 * Prerequisites:
 * - Chrome running with: --remote-debugging-port=9222 --user-data-dir=<path-to>\chrome-debug
 */

import { chromium } from "playwright";

const CDP_URL = "http://localhost:9222";

async function testChromeConnection() {
  console.log("🧪 Chrome Connection Test\n");
  
  const results = {
    cdpPort: false,
    browserConnect: false,
    contextsAvailable: false,
    pagesAccessible: false
  };
  
  // Test 1: CDP Port Available
  console.log("1. Testing CDP port availability...");
  try {
    const response = await fetch(`${CDP_URL}/json/version`);
    if (response.ok) {
      const data = await response.json();
      console.log(`   ✓ CDP available: ${data.Browser}`);
      results.cdpPort = true;
    }
  } catch (e) {
    console.log(`   ✗ CDP not available: ${e.message}`);
    console.log("\n   💡 Fix: Start Chrome with:");
    console.log('   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=<path-to>\\chrome-debug');
    return results;
  }
  
  // Test 2: Playwright Connect
  console.log("\n2. Testing Playwright connection...");
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log(`   ✓ Connected to browser`);
    results.browserConnect = true;
  } catch (e) {
    console.log(`   ✗ Connection failed: ${e.message}`);
    return results;
  }
  
  // Test 3: Browser Contexts
  console.log("\n3. Testing browser contexts...");
  try {
    const contexts = browser.contexts();
    console.log(`   ✓ Found ${contexts.length} context(s)`);
    results.contextsAvailable = contexts.length > 0;
  } catch (e) {
    console.log(`   ✗ Context error: ${e.message}`);
  }
  
  // Test 4: Page Access
  console.log("\n4. Testing page access...");
  try {
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      const pages = contexts[0].pages();
      console.log(`   ✓ Found ${pages.length} page(s)`);
      pages.forEach((p, i) => {
        const url = p.url();
        const title = url.length > 50 ? url.substring(0, 50) + "..." : url;
        console.log(`      [${i}] ${title}`);
      });
      results.pagesAccessible = pages.length > 0;
    }
  } catch (e) {
    console.log(`   ✗ Page access error: ${e.message}`);
  }
  
  // Summary
  console.log("\n" + "─".repeat(40));
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;
  console.log(`Result: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log("✅ Chrome connection fully operational");
  } else {
    console.log("❌ Some tests failed - see above for details");
  }
  
  return results;
}

// Run test
testChromeConnection()
  .then(results => {
    process.exit(Object.values(results).every(Boolean) ? 0 : 1);
  })
  .catch(e => {
    console.error("Test crashed:", e);
    process.exit(1);
  });
