import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * Health Check Unit Tests
 * Tests getHealthReport() and formatHealthReport() with mock objects — no Chrome needed.
 */

import { getHealthReport, formatHealthReport } from '../../utils/health-check.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  \u2713 ${name}`);
    passed++;
  } else {
    console.log(`  \u2717 ${name}`);
    failed++;
  }
}

/** Create a mock BrowserService */
function mockBrowserService({ connected = false, models = [], pages = {} } = {}) {
  return {
    isConnected() { return connected; },
    getActiveModels() { return models; },
    getPage(model) { return pages[model] || null; },
  };
}

/** Create a mock Playwright page for login-check */
function mockPage({ url = 'https://claude.ai/chat/abc', matchSelectors = [] } = {}) {
  return {
    url: () => url,
    $(selector) {
      if (matchSelectors.includes(selector)) {
        return Promise.resolve({ selector });
      }
      return Promise.resolve(null);
    },
  };
}

async function runTests() {
  console.log('Health Check Tests\n');

  // --- getHealthReport ---

  console.log('getHealthReport():');

  // 1. Disconnected state
  {
    const bs = mockBrowserService({ connected: false });
    const report = await getHealthReport(bs);
    assert(report.overall === 'disconnected', 'overall is disconnected when not connected');
    assert(report.chrome.connected === false, 'chrome.connected is false');
    assert(report.chrome.models.length === 0, 'no models when disconnected');
    assert(typeof report.timestamp === 'string', 'has timestamp');
    assert(typeof report.uptime === 'number', 'has uptime');
  }

  // 2. Connected but no model tabs
  {
    const bs = mockBrowserService({ connected: true, models: [] });
    const report = await getHealthReport(bs);
    assert(report.overall === 'no_model_tabs', 'overall is no_model_tabs when connected but no models');
    assert(report.chrome.connected === true, 'chrome.connected is true');
    assert(report.chrome.tabCount === 0, 'tabCount is 0');
  }

  // 3. All models logged in — healthy
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      chatgpt: mockPage({ url: 'https://chatgpt.com/', matchSelectors: ['#prompt-textarea'] }),
      gemini: mockPage({ url: 'https://gemini.google.com/app', matchSelectors: ['div[contenteditable="true"].ql-editor'] }),
    };
    const bs = mockBrowserService({
      connected: true,
      models: ['claude', 'chatgpt', 'gemini'],
      pages
    });
    const report = await getHealthReport(bs);
    assert(report.overall === 'healthy', 'overall is healthy when all logged in');
    assert(report.chrome.models.length === 3, 'has 3 models');
    assert(report.chrome.tabCount === 3, 'tabCount is 3');
    assert(report.logins.claude.loggedIn === true, 'claude login detected');
    assert(report.logins.chatgpt.loggedIn === true, 'chatgpt login detected');
    assert(report.logins.gemini.loggedIn === true, 'gemini login detected');
  }

  // 4. Partial — one model not logged in
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      chatgpt: mockPage({ url: 'https://chatgpt.com/auth/login', matchSelectors: [] }),
    };
    const bs = mockBrowserService({
      connected: true,
      models: ['claude', 'chatgpt'],
      pages
    });
    const report = await getHealthReport(bs);
    assert(report.overall === 'partial', 'overall is partial when one not logged in');
    assert(report.logins.claude.loggedIn === true, 'claude still logged in');
    assert(report.logins.chatgpt.loggedIn === false, 'chatgpt not logged in');
  }

  // 5. Memory formatted correctly
  {
    const bs = mockBrowserService({ connected: false });
    const report = await getHealthReport(bs);
    assert(report.memoryFormatted.heapUsed.endsWith('MB'), 'heapUsed has MB suffix');
    assert(report.memoryFormatted.heapTotal.endsWith('MB'), 'heapTotal has MB suffix');
    assert(report.memoryFormatted.rss.endsWith('MB'), 'rss has MB suffix');
  }

  // 6. Error in browserService — handles gracefully
  {
    const bs = {
      isConnected() { throw new Error('boom'); },
      getActiveModels() { return []; },
      getPage() { return null; },
    };
    const report = await getHealthReport(bs);
    assert(report.chrome.error === 'boom', 'captures error message');
    assert(report.overall === 'disconnected', 'falls back to disconnected on error');
  }

  // 7. _allLoggedIn field is cleaned up
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
    };
    const bs = mockBrowserService({ connected: true, models: ['claude'], pages });
    const report = await getHealthReport(bs);
    assert(report._allLoggedIn === undefined, '_allLoggedIn is cleaned up before return');
  }

  // 8. checkAllLogins destructuring — report.logins has per-model entries, not allLoggedIn/results keys
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      chatgpt: mockPage({ url: 'https://chatgpt.com/', matchSelectors: ['#prompt-textarea'] }),
    };
    const bs = mockBrowserService({ connected: true, models: ['claude', 'chatgpt'], pages });
    const report = await getHealthReport(bs);
    assert(report.logins.allLoggedIn === undefined, 'report.logins does not have allLoggedIn key');
    assert(report.logins.results === undefined, 'report.logins does not have results key');
    assert(report.logins.claude !== undefined, 'report.logins has per-model claude entry');
    assert(report.logins.chatgpt !== undefined, 'report.logins has per-model chatgpt entry');
  }

  // --- formatHealthReport ---

  console.log('\nformatHealthReport():');

  // 9. Format disconnected report
  {
    const report = {
      timestamp: '2026-02-10T00:00:00.000Z',
      overall: 'disconnected',
      uptime: 120,
      memoryFormatted: { heapUsed: '50MB', heapTotal: '100MB', rss: '150MB' },
      chrome: { connected: false, models: [], tabCount: 0 },
      logins: {}
    };
    const text = formatHealthReport(report);
    assert(text.includes('DISCONNECTED'), 'shows DISCONNECTED status');
    assert(text.includes('120s'), 'shows uptime');
    assert(text.includes('50MB / 100MB'), 'shows memory');
    assert(text.includes('Disconnected'), 'shows Chrome disconnected');
    assert(!text.includes('Login Status'), 'no login section when empty');
  }

  // 10. Format healthy report with logins
  {
    const report = {
      timestamp: '2026-02-10T00:00:00.000Z',
      overall: 'healthy',
      uptime: 300,
      memoryFormatted: { heapUsed: '50MB', heapTotal: '100MB', rss: '150MB' },
      chrome: { connected: true, models: ['claude', 'chatgpt'], tabCount: 2 },
      logins: {
        claude: { loggedIn: true, reason: 'Input found: .ProseMirror' },
        chatgpt: { loggedIn: true, reason: 'Input found: #prompt-textarea' }
      }
    };
    const text = formatHealthReport(report);
    assert(text.includes('HEALTHY'), 'shows HEALTHY status');
    assert(text.includes('Connected'), 'shows Chrome connected');
    assert(text.includes('claude, chatgpt'), 'shows model names');
    assert(text.includes('Login Status'), 'has login section');
    assert(text.includes('claude: OK'), 'shows claude OK');
    assert(text.includes('chatgpt: OK'), 'shows chatgpt OK');
  }

  // 11. MCP tool integration — simulates the handler call pattern
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
    };
    const bs = mockBrowserService({ connected: true, models: ['claude'], pages });
    const report = await getHealthReport(bs);
    const text = formatHealthReport(report);
    // Simulates what the MCP handler does
    const result = { content: [{ type: "text", text }] };
    assert(result.content[0].type === 'text', 'MCP result has text content type');
    assert(result.content[0].text.includes('HEALTHY'), 'MCP result text includes health status');
  }

  // Summary
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

runTests()
  .then(ok => process.exit(ok ? 0 : 1))
  .catch(e => {
    console.error('Test crashed:', e);
    process.exit(1);
  });
