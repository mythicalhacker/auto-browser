/**
 * Browser Tools Unit Tests
 * Validates tool definitions, handler defaults, and no duplicate tool names.
 */

import { getBrowserToolDefinitions, handleBrowserToolCall, BROWSER_TOOL_NAMES } from '../../tools/browser.js';
import { getConsensusToolDefinitions, CONSENSUS_TOOL_NAMES } from '../../tools/consensus.js';

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
  console.log('Browser Tools Tests\n');

  // --- Tool Definitions ---

  console.log('Tool Definitions:');

  const defs = getBrowserToolDefinitions();
  assert(defs.length === 18, `18 browser tool definitions (got ${defs.length})`);

  const expectedNames = [
    // Tier 1
    'browser_navigate', 'browser_back', 'browser_forward',
    'browser_tabs', 'browser_new_tab', 'browser_close_tab',
    'browser_screenshot', 'browser_get_text', 'browser_click', 'browser_type',
    // Tier 2
    'browser_snapshot', 'browser_hover', 'browser_select', 'browser_press_key',
    'browser_get_html', 'browser_evaluate', 'browser_wait', 'browser_file_upload'
  ];
  for (const name of expectedNames) {
    assert(defs.some(d => d.name === name), `has tool: ${name}`);
  }

  assert(BROWSER_TOOL_NAMES.size === 18, `BROWSER_TOOL_NAMES has 18 entries (got ${BROWSER_TOOL_NAMES.size})`);

  // Every tool has name, description, and inputSchema
  for (const def of defs) {
    assert(typeof def.name === 'string' && def.name.length > 0, `${def.name} has name`);
    assert(typeof def.description === 'string' && def.description.length > 0, `${def.name} has description`);
    assert(def.inputSchema && def.inputSchema.type === 'object', `${def.name} has object inputSchema`);
  }

  // --- Consensus Tool Count ---

  console.log('\nConsensus Tool Count:');

  const consensusDefs = getConsensusToolDefinitions();
  assert(CONSENSUS_TOOL_NAMES.size === 7, `CONSENSUS_TOOL_NAMES has 7 entries (got ${CONSENSUS_TOOL_NAMES.size})`);
  assert(consensusDefs.length === 7, `7 consensus tool definitions (got ${consensusDefs.length})`);

  // --- No Duplicate Tool Names ---

  console.log('\nDuplicate Check:');

  const allNames = [...CONSENSUS_TOOL_NAMES, ...BROWSER_TOOL_NAMES];
  const uniqueNames = new Set(allNames);
  assert(uniqueNames.size === allNames.length, `no duplicate tool names across consensus + browser (${uniqueNames.size} unique of ${allNames.length} total)`);

  // --- Unknown Tool Returns Null ---

  console.log('\nHandler Defaults:');

  const result = await handleBrowserToolCall('nonexistent_tool', {}, {});
  assert(result === null, 'unknown tool returns null');

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
