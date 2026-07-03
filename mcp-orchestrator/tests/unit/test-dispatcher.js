/**
 * Dispatcher Unit Tests
 * Validates tool definitions, dispatch routing (single-model, consensus, auto),
 * dispatchAll with dependencies, error handling, and MCP handler responses.
 */

import {
  getDispatchToolDefinitions, handleDispatchToolCall, DISPATCH_TOOL_NAMES,
  dispatchTask, dispatchAll
} from '../../services/dispatcher.js';
import {
  handleTaskToolCall, updateTask, areDependenciesMet, clearAllTasks
} from '../../tools/task-queue.js';

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

// --- Mock browserService ---

function createMockBrowserService(options = {}) {
  const activeModels = options.activeModels || ['claude', 'chatgpt', 'gemini'];
  const outputText = options.outputText || 'Mock response';
  const shouldFail = options.shouldFail || false;
  const failMessage = options.failMessage || 'Mock failure';

  // Track calls for verification
  const calls = { connect: 0, getPage: [], getActiveModels: 0 };

  const mockPage = {
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
    evaluate: async () => {},
    // findAll needs to return elements via page.$$
    $$: async (selector) => {
      // Return different counts to simulate pre/post send
      if (!mockPage._sent) return [{ innerText: async () => 'old' }];
      return [{ innerText: async () => 'old' }, { innerText: async () => outputText }];
    },
    _sent: false
  };

  return {
    calls,
    connect: async () => {
      calls.connect++;
      if (shouldFail) throw new Error(failMessage);
    },
    getPage: (model) => {
      calls.getPage.push(model);
      if (!activeModels.includes(model)) return null;
      return mockPage;
    },
    getActiveModels: () => {
      calls.getActiveModels++;
      return activeModels;
    },
    _mockPage: mockPage
  };
}

async function runTests() {
  console.log('Dispatcher Tests\n');

  // --- Tool Definitions ---
  console.log('Tool Definitions:');

  const defs = getDispatchToolDefinitions();
  assert(defs.length === 2, `2 dispatch tool definitions (got ${defs.length})`);

  const expectedNames = ['task_run', 'task_run_all'];
  for (const name of expectedNames) {
    assert(defs.some(d => d.name === name), `has tool: ${name}`);
  }

  assert(DISPATCH_TOOL_NAMES instanceof Set, 'DISPATCH_TOOL_NAMES is a Set');
  assert(DISPATCH_TOOL_NAMES.size === 2, `DISPATCH_TOOL_NAMES has 2 entries (got ${DISPATCH_TOOL_NAMES.size})`);

  for (const def of defs) {
    assert(typeof def.name === 'string' && def.name.length > 0, `${def.name} has name`);
    assert(typeof def.description === 'string' && def.description.length > 0, `${def.name} has description`);
    assert(def.inputSchema && def.inputSchema.type === 'object', `${def.name} has object inputSchema`);
  }

  // task_run requires task_id
  const taskRunDef = defs.find(d => d.name === 'task_run');
  assert(
    taskRunDef.inputSchema.required && taskRunDef.inputSchema.required.includes('task_id'),
    'task_run requires task_id'
  );

  // --- No collision with other tool sets ---
  console.log('\nNo Name Collisions:');

  // Import task-queue names to verify no overlap
  const { TASK_TOOL_NAMES } = await import('../../tools/task-queue.js');
  for (const name of DISPATCH_TOOL_NAMES) {
    assert(!TASK_TOOL_NAMES.has(name), `${name} does not collide with task-queue tools`);
  }

  // --- resolveTarget routing ---
  console.log('\nTarget Resolution:');

  clearAllTasks();

  // 'claude' target → single model
  await handleTaskToolCall('task_submit', { prompt: 'test claude', target: 'claude' });
  const claudeTask = (await handleTaskToolCall('task_status', { task_id: 'task_1' }));
  const claudeData = JSON.parse(claudeTask.content[0].text);
  assert(claudeData.target === 'claude', 'claude target stored correctly');

  // 'auto' target → should resolve to consensus
  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'test auto', target: 'auto' });
  const autoTask = (await handleTaskToolCall('task_status', { task_id: 'task_1' }));
  const autoData = JSON.parse(autoTask.content[0].text);
  assert(autoData.target === 'auto', 'auto target stored correctly');

  // 'consensus' target
  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'test consensus', target: 'consensus' });
  const consTask = (await handleTaskToolCall('task_status', { task_id: 'task_1' }));
  const consData = JSON.parse(consTask.content[0].text);
  assert(consData.target === 'consensus', 'consensus target stored correctly');

  // --- dispatchTask error: missing model tab ---
  console.log('\nDispatch Single Model — Missing Tab:');

  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'test missing', target: 'gemini' });

  const emptyBrowser = createMockBrowserService({ activeModels: [] });
  let missingError = false;
  try {
    await dispatchTask('task_1', emptyBrowser);
  } catch (e) {
    missingError = e.message.includes('tab not found');
  }
  assert(missingError, 'dispatchTask throws when model tab not found');

  // Verify task status was set to failed
  const failedStatus = (await handleTaskToolCall('task_status', { task_id: 'task_1' }));
  const failedData = JSON.parse(failedStatus.content[0].text);
  assert(failedData.status === 'failed', 'task status set to failed on error');
  assert(failedData.error.includes('tab not found'), 'task error message captured');

  // --- dispatchTask error: connect fails ---
  console.log('\nDispatch — Connect Failure:');

  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'test connect fail', target: 'claude' });

  const failBrowser = createMockBrowserService({ shouldFail: true, failMessage: 'CDP connection refused' });
  let connectError = false;
  try {
    await dispatchTask('task_1', failBrowser);
  } catch (e) {
    connectError = e.message.includes('CDP connection refused');
  }
  assert(connectError, 'dispatchTask propagates connect error');

  // --- dispatchTask sets status to active before running ---
  console.log('\nDispatch — Status Transitions:');

  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'test status', target: 'claude' });

  // Task starts as pending
  const pendingCheck = JSON.parse((await handleTaskToolCall('task_status', { task_id: 'task_1' })).content[0].text);
  assert(pendingCheck.status === 'pending', 'task starts as pending');

  // After failed dispatch, it should be 'failed' (not 'active')
  const failBrowser2 = createMockBrowserService({ activeModels: [] });
  try { await dispatchTask('task_1', failBrowser2); } catch {}

  const afterFail = JSON.parse((await handleTaskToolCall('task_status', { task_id: 'task_1' })).content[0].text);
  assert(afterFail.status === 'failed', 'task status is failed after error');
  assert(afterFail.started_at !== null, 'started_at is set even on failure');

  // --- dispatchAll: skips tasks with unmet dependencies ---
  console.log('\nDispatchAll — Dependencies:');

  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'parent', name: 'Parent', target: 'claude' });
  await handleTaskToolCall('task_submit', { prompt: 'child', name: 'Child', target: 'claude', depends_on: ['task_1'] });

  // Both pending, but task_2 depends on task_1
  // With a failing browser, task_1 will fail, task_2 should be blocked
  const failBrowser3 = createMockBrowserService({ activeModels: [] });
  const allResults = await dispatchAll(failBrowser3);

  assert(allResults.length === 2, `dispatchAll returns 2 results (got ${allResults.length})`);
  assert(allResults[0].status === 'failed', 'parent task failed (no tab)');
  assert(allResults[1].status === 'blocked', 'child task blocked (dependency unmet)');
  assert(allResults[1].reason === 'unmet dependencies', 'blocked reason is unmet dependencies');

  // --- dispatchAll: empty queue ---
  console.log('\nDispatchAll — Empty Queue:');

  clearAllTasks();
  const emptyResults = await dispatchAll(createMockBrowserService());
  assert(emptyResults.length === 0, 'dispatchAll returns empty array for empty queue');

  // --- MCP handler: task_run_all with no pending tasks ---
  console.log('\nMCP Handler — task_run_all empty:');

  clearAllTasks();
  const emptyResponse = await handleDispatchToolCall('task_run_all', {}, createMockBrowserService());
  assert(emptyResponse.content[0].text.includes('No pending tasks'), 'task_run_all reports no pending tasks');

  // --- MCP handler: task_run with bad task_id ---
  console.log('\nMCP Handler — task_run error:');

  clearAllTasks();
  const badIdResponse = await handleDispatchToolCall('task_run', { task_id: 'task_999' }, createMockBrowserService());
  assert(badIdResponse.content[0].text.includes('failed'), 'task_run reports failure for bad task_id');

  // --- MCP handler: unknown tool returns null ---
  console.log('\nMCP Handler — Unknown Tool:');

  const nullResult = await handleDispatchToolCall('nonexistent', {}, createMockBrowserService());
  assert(nullResult === null, 'unknown tool returns null');

  // --- MCP handler: task_run_all with mixed results ---
  console.log('\nMCP Handler — task_run_all mixed:');

  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'p1', name: 'Task A', target: 'claude' });
  await handleTaskToolCall('task_submit', { prompt: 'p2', name: 'Task B', target: 'claude', depends_on: ['task_1'] });

  const mixedBrowser = createMockBrowserService({ activeModels: [] });
  const mixedResponse = await handleDispatchToolCall('task_run_all', {}, mixedBrowser);
  const mixedText = mixedResponse.content[0].text;
  assert(mixedText.includes('Dispatched 2 task(s)'), 'task_run_all reports count');
  assert(mixedText.includes('failed'), 'task_run_all shows failed task');
  assert(mixedText.includes('blocked'), 'task_run_all shows blocked task');

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
