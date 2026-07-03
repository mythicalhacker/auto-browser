/**
 * Task Decomposer Unit Tests
 * Validates strategy detection, pipeline/parallel/consensus decomposition,
 * subtask field structure, dependency chaining, and edge cases.
 */

import { decomposeTask } from '../../utils/task-decomposer.js';

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

function runTests() {
  console.log('Task Decomposer Tests\n');

  // --- Strategy Detection ---
  console.log('Strategy Detection:');

  // Consensus keywords
  {
    const result = decomposeTask({ prompt: 'Get consensus from all models on this topic' });
    assert(result.strategy === 'consensus', 'consensus keyword detected');
  }

  {
    const result = decomposeTask({ prompt: 'Show answers side by side on this question' });
    assert(result.strategy === 'parallel', 'parallel keyword "side by side" detected');
  }

  {
    const result = decomposeTask({ prompt: 'Have each model independently answer' });
    assert(result.strategy === 'parallel', 'parallel keyword "independently" detected');
  }

  // Pipeline: 2+ stages
  {
    const result = decomposeTask({ prompt: 'Research the topic and then write a report' });
    assert(result.strategy === 'pipeline', 'pipeline detected with research + write');
  }

  {
    const result = decomposeTask({ prompt: 'Analyze the data and review the results' });
    assert(result.strategy === 'pipeline', 'pipeline detected with analyze + review');
  }

  // Single stage → consensus fallback
  {
    const result = decomposeTask({ prompt: 'Just research this topic for me' });
    assert(result.strategy === 'consensus', 'single stage falls back to consensus');
  }

  // No keywords → consensus default
  {
    const result = decomposeTask({ prompt: 'Hello world' });
    assert(result.strategy === 'consensus', 'no keywords defaults to consensus');
  }

  // --- Explicit Strategy Override ---
  console.log('\nExplicit Strategy Override:');

  {
    const result = decomposeTask({ prompt: 'Research and write a report', strategy: 'parallel' });
    assert(result.strategy === 'parallel', 'explicit parallel overrides pipeline detection');
  }

  {
    const result = decomposeTask({ prompt: 'Compare independently', strategy: 'consensus' });
    assert(result.strategy === 'consensus', 'explicit consensus overrides parallel detection');
  }

  {
    const result = decomposeTask({ prompt: 'Research the topic and then write a report', strategy: 'pipeline' });
    assert(result.strategy === 'pipeline', 'explicit pipeline works');
  }

  // Invalid strategy ignored → auto-detect
  {
    const result = decomposeTask({ prompt: 'Hello world', strategy: 'invalid_strategy' });
    assert(result.strategy === 'consensus', 'invalid strategy falls back to auto-detect');
  }

  // --- Consensus Decomposition ---
  console.log('\nConsensus Decomposition:');

  {
    const result = decomposeTask({ prompt: 'What is the meaning of life?' });
    assert(result.subtasks.length === 1, 'consensus produces 1 subtask');
    assert(result.subtasks[0].model === 'all', 'consensus subtask targets all models');
    assert(result.subtasks[0].label === 'Consensus', 'consensus subtask label is Consensus');
    assert(result.subtasks[0].dependsOn.length === 0, 'consensus subtask has no dependencies');
  }

  // --- Parallel Decomposition ---
  console.log('\nParallel Decomposition:');

  {
    const result = decomposeTask({ prompt: 'Answer side by side on quantum computing' });
    assert(result.subtasks.length === 3, 'parallel produces 3 subtasks');

    const models = result.subtasks.map(s => s.model);
    assert(models.includes('claude'), 'parallel includes claude');
    assert(models.includes('chatgpt'), 'parallel includes chatgpt');
    assert(models.includes('gemini'), 'parallel includes gemini');

    // All parallel tasks have no dependencies
    assert(result.subtasks.every(s => s.dependsOn.length === 0), 'parallel subtasks have no dependencies');

    // All have the same prompt
    assert(result.subtasks.every(s => s.prompt === result.subtasks[0].prompt), 'parallel subtasks share prompt');
  }

  // --- Pipeline Decomposition ---
  console.log('\nPipeline Decomposition:');

  {
    const result = decomposeTask({ prompt: 'Research AI safety, then write a comprehensive report' });
    assert(result.strategy === 'pipeline', 'research + write triggers pipeline');
    assert(result.subtasks.length === 2, 'pipeline produces 2 subtasks for 2 stages');

    // First subtask has no dependencies
    assert(result.subtasks[0].dependsOn.length === 0, 'first pipeline stage has no dependencies');
    assert(result.subtasks[0].label === 'Research', 'first stage label is Research');

    // Second subtask depends on $PREV
    assert(result.subtasks[1].dependsOn.includes('$PREV'), 'second stage depends on $PREV');
    assert(result.subtasks[1].label === 'Writing', 'second stage label is Writing');
  }

  // 3-stage pipeline
  {
    const result = decomposeTask({ prompt: 'Research the topic, analyze the findings, and write a summary' });
    assert(result.strategy === 'pipeline', '3-stage pipeline detected');
    assert(result.subtasks.length === 3, 'pipeline produces 3 subtasks');
    assert(result.subtasks[0].dependsOn.length === 0, 'stage 1 has no deps');
    assert(result.subtasks[1].dependsOn.includes('$PREV'), 'stage 2 depends on $PREV');
    assert(result.subtasks[2].dependsOn.includes('$PREV'), 'stage 3 depends on $PREV');
  }

  // --- Subtask Field Validation ---
  console.log('\nSubtask Field Validation:');

  {
    const result = decomposeTask({ prompt: 'Test field structure' });
    const subtask = result.subtasks[0];

    assert(typeof subtask.prompt === 'string', 'subtask.prompt is string');
    assert(typeof subtask.model === 'string', 'subtask.model is string');
    assert(typeof subtask.mode === 'string', 'subtask.mode is string');
    assert(typeof subtask.rationale === 'string', 'subtask.rationale is string');
    assert(Array.isArray(subtask.dependsOn), 'subtask.dependsOn is array');
    assert('type' in subtask, 'subtask has type field');
    assert('label' in subtask, 'subtask has label field');
  }

  // --- Pipeline Model Routing ---
  console.log('\nPipeline Model Routing:');

  {
    const result = decomposeTask({ prompt: 'Research the problem and then implement a solution in code' });
    assert(result.strategy === 'pipeline', 'research + code triggers pipeline');

    // Research stage should route to gemini
    assert(result.subtasks[0].model === 'gemini', 'research stage routes to gemini');
    // Code stage should route to chatgpt
    assert(result.subtasks[1].model === 'chatgpt', 'code stage routes to chatgpt');
  }

  // --- Edge Cases ---
  console.log('\nEdge Cases:');

  // Empty/null prompt
  {
    const result = decomposeTask({ prompt: '' });
    assert(result.strategy === 'consensus', 'empty prompt returns consensus');
    assert(result.subtasks.length === 1, 'empty prompt produces 1 subtask');
  }

  {
    const result = decomposeTask({ prompt: null });
    assert(result.strategy === 'consensus', 'null prompt returns consensus');
  }

  {
    const result = decomposeTask({});
    assert(result.strategy === 'consensus', 'missing prompt returns consensus');
  }

  {
    const result = decomposeTask();
    assert(result.strategy === 'consensus', 'no args returns consensus');
  }

  // Whitespace-only prompt
  {
    const result = decomposeTask({ prompt: '   ' });
    assert(result.strategy === 'consensus', 'whitespace-only prompt returns consensus');
  }

  // Consensus keyword priority over parallel
  {
    const result = decomposeTask({ prompt: 'Get consensus and compare independently' });
    assert(result.strategy === 'consensus', 'consensus keyword beats parallel keyword');
  }

  // Pipeline stage prompts include label prefix
  {
    const result = decomposeTask({ prompt: 'Research and write about cats' });
    assert(result.subtasks[0].prompt.startsWith('[Research]'), 'pipeline stage prompt has label prefix');
  }

  // Summary
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

const ok = runTests();
process.exit(ok ? 0 : 1);
