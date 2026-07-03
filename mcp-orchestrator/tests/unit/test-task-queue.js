/**
 * Task Queue Unit Tests
 * Validates tool definitions, submit/status/list/cancel operations,
 * priority sorting, dependencies, handler signature, and error cases.
 */

import {
  getTaskToolDefinitions, handleTaskToolCall, TASK_TOOL_NAMES,
  updateTask, areDependenciesMet, clearAllTasks
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

async function runTests() {
  console.log('Task Queue Tests\n');

  // Clean slate
  clearAllTasks();

  // --- Tool Definitions ---
  console.log('Tool Definitions:');

  const defs = getTaskToolDefinitions();
  assert(defs.length === 4, `4 task tool definitions (got ${defs.length})`);

  const expectedNames = ['task_submit', 'task_status', 'task_list', 'task_cancel'];
  for (const name of expectedNames) {
    assert(defs.some(d => d.name === name), `has tool: ${name}`);
  }

  assert(TASK_TOOL_NAMES instanceof Set, 'TASK_TOOL_NAMES is a Set');
  assert(TASK_TOOL_NAMES.size === 4, `TASK_TOOL_NAMES has 4 entries (got ${TASK_TOOL_NAMES.size})`);

  for (const def of defs) {
    assert(typeof def.name === 'string' && def.name.length > 0, `${def.name} has name`);
    assert(typeof def.description === 'string' && def.description.length > 0, `${def.name} has description`);
    assert(def.inputSchema && def.inputSchema.type === 'object', `${def.name} has object inputSchema`);
  }

  // --- Submit ---
  console.log('\nSubmit:');

  clearAllTasks();

  const submitResult = await handleTaskToolCall('task_submit', {
    prompt: 'Test prompt', name: 'My Test Task', target: 'claude', priority: 'high'
  });
  const submitText = submitResult.content[0].text;
  assert(submitText.includes('task_'), 'submit returns task ID');
  assert(submitText.includes('My Test Task'), 'submit returns task name');
  assert(submitText.includes('pending'), 'submit status is pending');
  assert(submitText.includes('claude'), 'submit target is claude');

  // Submit with defaults
  const defaultResult = await handleTaskToolCall('task_submit', { prompt: 'Default prompt' });
  const defaultText = defaultResult.content[0].text;
  assert(defaultText.includes('auto'), 'default target is auto');

  // --- Status (single task) ---
  console.log('\nStatus (single):');

  const statusResult = await handleTaskToolCall('task_status', { task_id: 'task_1' });
  const statusData = JSON.parse(statusResult.content[0].text);
  assert(statusData.id === 'task_1', 'status returns correct task ID');
  assert(statusData.prompt === 'Test prompt', 'status returns correct prompt');
  assert(statusData.priority === 'high', 'status returns correct priority');

  // --- Status (all tasks) ---
  console.log('\nStatus (all):');

  const allStatusResult = await handleTaskToolCall('task_status', {});
  const allStatusData = JSON.parse(allStatusResult.content[0].text);
  assert(Array.isArray(allStatusData), 'all-status returns array');
  assert(allStatusData.length === 2, `all-status has 2 tasks (got ${allStatusData.length})`);

  // --- List (all) ---
  console.log('\nList:');

  const listResult = await handleTaskToolCall('task_list', {});
  const listText = listResult.content[0].text;
  assert(listText.includes('Tasks (2)'), 'list shows 2 tasks');
  assert(listText.includes('task_1'), 'list includes task_1');
  assert(listText.includes('task_2'), 'list includes task_2');

  // --- List (filtered — empty result) ---
  console.log('\nList (filtered empty):');

  const emptyListResult = await handleTaskToolCall('task_list', { status: 'completed' });
  assert(emptyListResult.content[0].text === 'No tasks found.', 'filtered list with no matches returns empty message');

  // --- List (filtered — matching) ---
  console.log('\nList (filtered match):');

  const pendingListResult = await handleTaskToolCall('task_list', { status: 'pending' });
  assert(pendingListResult.content[0].text.includes('Tasks (2)'), 'filtered list for pending shows 2');

  // --- Priority sorting ---
  console.log('\nPriority Sorting:');

  clearAllTasks();

  await handleTaskToolCall('task_submit', { prompt: 'low prio', priority: 'low', name: 'Low' });
  await handleTaskToolCall('task_submit', { prompt: 'critical prio', priority: 'critical', name: 'Critical' });
  await handleTaskToolCall('task_submit', { prompt: 'normal prio', priority: 'normal', name: 'Normal' });

  const sortedResult = await handleTaskToolCall('task_list', {});
  const sortedText = sortedResult.content[0].text;
  const critIdx = sortedText.indexOf('Critical');
  const normIdx = sortedText.indexOf('Normal');
  const lowIdx = sortedText.indexOf('Low');
  assert(critIdx < normIdx && normIdx < lowIdx, 'tasks sorted by priority: critical < normal < low');

  // --- Cancel (valid) ---
  console.log('\nCancel:');

  clearAllTasks();

  await handleTaskToolCall('task_submit', { prompt: 'to cancel', name: 'Cancelable' });
  const cancelResult = await handleTaskToolCall('task_cancel', { task_id: 'task_1' });
  assert(cancelResult.content[0].text.includes('cancelled'), 'cancel returns cancelled confirmation');

  // Verify cancelled status
  const cancelledStatus = await handleTaskToolCall('task_status', { task_id: 'task_1' });
  const cancelledData = JSON.parse(cancelledStatus.content[0].text);
  assert(cancelledData.status === 'cancelled', 'task status is cancelled after cancel');

  // --- Cancel (completed task — error) ---
  console.log('\nCancel Errors:');

  clearAllTasks();

  await handleTaskToolCall('task_submit', { prompt: 'completed task' });
  updateTask('task_1', { status: 'completed' });

  let completedCancelError = false;
  try {
    await handleTaskToolCall('task_cancel', { task_id: 'task_1' });
  } catch (e) {
    completedCancelError = e.message.includes('Cannot cancel');
  }
  assert(completedCancelError, 'cannot cancel completed task');

  // --- Cancel (cancelled task — error) ---
  clearAllTasks();

  await handleTaskToolCall('task_submit', { prompt: 'to cancel twice' });
  await handleTaskToolCall('task_cancel', { task_id: 'task_1' });

  let doubleCancelError = false;
  try {
    await handleTaskToolCall('task_cancel', { task_id: 'task_1' });
  } catch (e) {
    doubleCancelError = e.message.includes('Cannot cancel');
  }
  assert(doubleCancelError, 'cannot cancel already-cancelled task');

  // --- Nonexistent task error ---
  console.log('\nNonexistent Task:');

  let notFoundError = false;
  try {
    await handleTaskToolCall('task_status', { task_id: 'task_999' });
  } catch (e) {
    notFoundError = e.message.includes('Task not found');
  }
  assert(notFoundError, 'nonexistent task throws Task not found');

  // --- Dependencies ---
  console.log('\nDependencies:');

  clearAllTasks();

  // Create a task with a dependency
  await handleTaskToolCall('task_submit', { prompt: 'parent', name: 'Parent' });
  await handleTaskToolCall('task_submit', { prompt: 'child', name: 'Child', depends_on: ['task_1'] });

  // Dependency not met (parent is pending)
  assert(!areDependenciesMet('task_2'), 'dependencies not met when parent is pending');

  // Complete parent
  updateTask('task_1', { status: 'completed' });
  assert(areDependenciesMet('task_2'), 'dependencies met when parent is completed');

  // Task with no dependencies
  assert(areDependenciesMet('task_1'), 'task with no dependencies returns true');

  // Nonexistent dependency
  clearAllTasks();
  await handleTaskToolCall('task_submit', { prompt: 'orphan', depends_on: ['task_999'] });
  assert(!areDependenciesMet('task_1'), 'nonexistent dependency returns false');

  // --- Handler signature (3 params) ---
  console.log('\nHandler Signature:');

  clearAllTasks();

  const threeParamResult = await handleTaskToolCall('task_submit', { prompt: 'sig test' }, { fake: 'browserService' });
  assert(threeParamResult.content[0].text.includes('task_'), 'handler works with 3 params (browserService ignored)');

  // --- Unknown tool error ---
  console.log('\nUnknown Tool:');

  let unknownToolError = false;
  try {
    await handleTaskToolCall('nonexistent_tool', {});
  } catch (e) {
    unknownToolError = e.message.includes('Unknown task tool');
  }
  assert(unknownToolError, 'unknown tool throws error');

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
