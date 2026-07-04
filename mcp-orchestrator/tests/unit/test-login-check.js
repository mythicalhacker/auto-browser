import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * Login Check Unit Tests
 * Tests login detection with mock page objects — no Chrome needed.
 */

import { checkLogin, checkAllLogins } from '../../utils/login-check.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

/** Create a mock Playwright page */
function mockPage({ url = 'https://claude.ai/chat/abc', matchSelectors = [] } = {}) {
  return {
    url: () => url,
    $(selector) {
      if (matchSelectors.includes(selector)) {
        return Promise.resolve({ selector }); // truthy element handle
      }
      return Promise.resolve(null);
    },
  };
}

async function runTests() {
  console.log('🧪 Login Check Tests\n');

  // --- checkLogin ---

  console.log('checkLogin():');

  // 1. Logged in — input selector found
  {
    const page = mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] });
    const r = await checkLogin(page, 'claude');
    assert(r.loggedIn === true, 'claude logged in when input found');
    assert(r.reason.includes('.ProseMirror'), 'reason mentions matched selector');
  }

  // 2. Not logged in — no input selector
  {
    const page = mockPage({ url: 'https://chatgpt.com/', matchSelectors: [] });
    const r = await checkLogin(page, 'chatgpt');
    assert(r.loggedIn === false, 'chatgpt not logged in when no input');
  }

  // 3. Login URL detected
  {
    const page = mockPage({ url: 'https://chatgpt.com/auth/login', matchSelectors: [] });
    const r = await checkLogin(page, 'chatgpt');
    assert(r.loggedIn === false, 'detects login URL');
    assert(r.reason.includes('login pattern'), 'reason mentions login pattern');
  }

  // 4. Login URL takes precedence even if input exists
  {
    const page = mockPage({ url: 'https://accounts.google.com/signin', matchSelectors: ['div[contenteditable="true"]'] });
    const r = await checkLogin(page, 'gemini');
    assert(r.loggedIn === false, 'login URL overrides input presence');
  }

  // 5. Unknown model
  {
    const page = mockPage();
    const r = await checkLogin(page, 'unknown');
    assert(r.loggedIn === false, 'unknown model returns not logged in');
    assert(r.reason.includes('Unknown model'), 'reason mentions unknown model');
  }

  // --- checkAllLogins ---

  console.log('\ncheckAllLogins():');

  // 6. All logged in
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      chatgpt: mockPage({ url: 'https://chatgpt.com/', matchSelectors: ['#prompt-textarea'] }),
      gemini: mockPage({ url: 'https://gemini.google.com/app', matchSelectors: ['div[contenteditable="true"].ql-editor'] }),
    };
    const r = await checkAllLogins(pages);
    assert(r.allLoggedIn === true, 'allLoggedIn true when all have input');
    assert(Object.keys(r.results).length === 3, 'results has 3 entries');
  }

  // 7. One not logged in
  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      chatgpt: mockPage({ url: 'https://chatgpt.com/auth/login', matchSelectors: [] }),
    };
    const r = await checkAllLogins(pages);
    assert(r.allLoggedIn === false, 'allLoggedIn false when one fails');
    assert(r.results.claude.loggedIn === true, 'claude still shows logged in');
    assert(r.results.chatgpt.loggedIn === false, 'chatgpt shows not logged in');
  }

  // 8. Empty pages object
  {
    const r = await checkAllLogins({});
    assert(r.allLoggedIn === false, 'allLoggedIn false for empty pages');
  }

  // 9. page.url() throws (closed page)
  {
    const page = {
      url() { throw new Error('page closed'); },
      $(sel) { return Promise.resolve(null); },
    };
    const r = await checkLogin(page, 'claude');
    assert(r.loggedIn === false, 'handles page.url() throwing');
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
