import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * Context Enricher Unit Tests
 * Validates enrichContext() and buildEnrichedPrompt() with mock objects — no Chrome needed.
 */

import { enrichContext, buildEnrichedPrompt } from '../../services/context-enricher.js';
import { handleTaskToolCall, clearAllTasks } from '../../tools/task-queue.js';

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
function mockBrowserService({ activeModels = [], pages = {} } = {}) {
  return {
    getActiveModels() { return activeModels; },
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
  console.log('Context Enricher Tests\n');

  // --- enrichContext: auto target (multi-model) ---
  console.log('enrichContext — auto target:');

  clearAllTasks();

  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      chatgpt: mockPage({ url: 'https://chatgpt.com/', matchSelectors: ['#prompt-textarea'] }),
    };
    const bs = mockBrowserService({ activeModels: ['claude', 'chatgpt'], pages });
    const task = { prompt: 'Hello world', target: 'auto', depends_on: [] };
    const result = await enrichContext(task, bs);

    assert(result.modelStatuses !== undefined, 'auto target produces modelStatuses');
    assert(result.modelStatus === undefined, 'auto target does not produce modelStatus');
    assert(result.modelStatuses.claude.loggedIn === true, 'claude login detected');
    assert(result.modelStatuses.chatgpt.loggedIn === true, 'chatgpt login detected');
    assert(Array.isArray(result.urls), 'urls is an array');
    assert(result.urls.length === 0, 'no URLs in prompt');
  }

  // --- enrichContext: single model target ---
  console.log('\nenrichContext — single model target:');

  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
    };
    const bs = mockBrowserService({ activeModels: ['claude'], pages });
    const task = { prompt: 'Test prompt', target: 'claude', depends_on: [] };
    const result = await enrichContext(task, bs);

    assert(result.modelStatus !== undefined, 'single target produces modelStatus');
    assert(result.modelStatuses === undefined, 'single target does not produce modelStatuses');
    assert(result.modelStatus.loggedIn === true, 'claude login detected for single target');
  }

  // --- enrichContext: single model target missing page ---
  console.log('\nenrichContext — single model missing page:');

  {
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = { prompt: 'Test prompt', target: 'gemini', depends_on: [] };
    const result = await enrichContext(task, bs);

    assert(result.modelStatus !== undefined, 'missing page still produces modelStatus');
    assert(result.modelStatus.loggedIn === false, 'missing page reports not logged in');
    assert(result.modelStatus.reason.includes('No page found'), 'reason mentions no page found');
  }

  // --- enrichContext: consensus target ---
  console.log('\nenrichContext — consensus target:');

  {
    const pages = {
      claude: mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }),
      gemini: mockPage({ url: 'https://gemini.google.com/app', matchSelectors: ['div[contenteditable="true"].ql-editor'] }),
    };
    const bs = mockBrowserService({ activeModels: ['claude', 'gemini'], pages });
    const task = { prompt: 'Test consensus', target: 'consensus', depends_on: [] };
    const result = await enrichContext(task, bs);

    assert(result.modelStatuses !== undefined, 'consensus target produces modelStatuses');
    assert(result.modelStatus === undefined, 'consensus target does not produce modelStatus');
    assert(Object.keys(result.modelStatuses).length === 2, 'modelStatuses has 2 entries');
  }

  // --- enrichContext: URL extraction ---
  console.log('\nenrichContext — URL extraction:');

  {
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = {
      prompt: 'Check https://example.com and http://test.org/page for info',
      target: 'auto',
      depends_on: []
    };
    const result = await enrichContext(task, bs);

    assert(result.urls.length === 2, `found 2 URLs (got ${result.urls.length})`);
    assert(result.urls[0] === 'https://example.com', 'first URL is https://example.com');
    assert(result.urls[1] === 'http://test.org/page', 'second URL is http://test.org/page');
  }

  // --- enrichContext: no URLs in prompt ---
  console.log('\nenrichContext — no URLs:');

  {
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = { prompt: 'No links here', target: 'auto', depends_on: [] };
    const result = await enrichContext(task, bs);

    assert(result.urls.length === 0, 'no URLs found in prompt');
  }

  // --- enrichContext: dependency results ---
  console.log('\nenrichContext — dependency results:');

  clearAllTasks();

  {
    // Create a parent task and complete it
    await handleTaskToolCall('task_submit', { prompt: 'parent task', name: 'Parent' });
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = { prompt: 'child task', target: 'auto', depends_on: ['task_1'] };
    const result = await enrichContext(task, bs);

    assert(result.dependencyResults !== undefined, 'dependencyResults present');
    assert(result.dependencyResults['task_1'] !== undefined, 'task_1 result included');
    assert(result.dependencyResults['task_1'].id === 'task_1', 'dependency result has correct id');
  }

  // --- enrichContext: missing dependency ---
  console.log('\nenrichContext — missing dependency:');

  clearAllTasks();

  {
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = { prompt: 'orphan task', target: 'auto', depends_on: ['task_999'] };
    const result = await enrichContext(task, bs);

    assert(result.dependencyResults !== undefined, 'dependencyResults present even with missing dep');
    assert(result.dependencyResults['task_999'] === undefined, 'missing dep not included in results');
  }

  // --- enrichContext: no depends_on ---
  console.log('\nenrichContext — no depends_on:');

  {
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = { prompt: 'no deps', target: 'auto' };
    const result = await enrichContext(task, bs);

    assert(result.dependencyResults === undefined, 'no dependencyResults when no depends_on');
  }

  // --- enrichContext: empty depends_on ---
  console.log('\nenrichContext — empty depends_on:');

  {
    const bs = mockBrowserService({ activeModels: [], pages: {} });
    const task = { prompt: 'empty deps', target: 'auto', depends_on: [] };
    const result = await enrichContext(task, bs);

    assert(result.dependencyResults === undefined, 'no dependencyResults when depends_on is empty');
  }

  // --- buildEnrichedPrompt: no dependencies ---
  console.log('\nbuildEnrichedPrompt — no dependencies:');

  {
    const task = { prompt: 'Simple prompt' };
    const enrichments = { urls: [] };
    const result = buildEnrichedPrompt(task, enrichments);

    assert(result === 'Simple prompt', 'returns original prompt when no dependencies');
  }

  // --- buildEnrichedPrompt: with dependencies ---
  console.log('\nbuildEnrichedPrompt — with dependencies:');

  {
    const task = { prompt: 'Child task prompt' };
    const enrichments = {
      dependencyResults: {
        'task_1': { id: 'task_1', status: 'completed', result: 'some output' }
      },
      urls: []
    };
    const result = buildEnrichedPrompt(task, enrichments);

    assert(result.includes('CONTEXT FROM PREVIOUS TASKS'), 'includes context header');
    assert(result.includes('[Previous task task_1 result]'), 'includes dependency reference');
    assert(result.includes('CURRENT TASK'), 'includes current task header');
    assert(result.includes('Child task prompt'), 'includes original prompt');
  }

  // --- buildEnrichedPrompt: empty dependencyResults ---
  console.log('\nbuildEnrichedPrompt — empty dependencyResults:');

  {
    const task = { prompt: 'No dep context' };
    const enrichments = { dependencyResults: {}, urls: [] };
    const result = buildEnrichedPrompt(task, enrichments);

    assert(result === 'No dep context', 'returns original prompt when dependencyResults is empty object');
  }

  // --- buildEnrichedPrompt: multiple dependencies ---
  console.log('\nbuildEnrichedPrompt — multiple dependencies:');

  {
    const task = { prompt: 'Multi dep task' };
    const enrichments = {
      dependencyResults: {
        'task_1': { id: 'task_1', status: 'completed' },
        'task_2': { id: 'task_2', status: 'completed' }
      },
      urls: []
    };
    const result = buildEnrichedPrompt(task, enrichments);

    assert(result.includes('[Previous task task_1 result]'), 'includes task_1 reference');
    assert(result.includes('[Previous task task_2 result]'), 'includes task_2 reference');
  }

  // --- buildEnrichedPrompt: long result truncation ---
  console.log('\nbuildEnrichedPrompt — long result truncation:');

  {
    const longResult = 'x'.repeat(600);
    const task = { prompt: 'Truncation test' };
    const enrichments = {
      dependencyResults: {
        'task_1': { id: 'task_1', data: longResult }
      },
      urls: []
    };
    const result = buildEnrichedPrompt(task, enrichments);
    const contextLine = result.split('\n').find(l => l.includes('[Previous task task_1 result]'));

    assert(contextLine !== undefined, 'context line exists');
    // JSON.stringify of the object + substring(0, 500) should truncate
    assert(contextLine.length < 600, `context line truncated (length: ${contextLine.length})`);
  }

  // Cleanup
  clearAllTasks();

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
