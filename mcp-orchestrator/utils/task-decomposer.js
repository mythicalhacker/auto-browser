// utils/task-decomposer.js — Task Decomposition Engine
// Breaks complex prompts into routed subtasks using pipeline, parallel, or consensus strategies.

import { routeTask } from './model-router.js';

// Sentinel value for dependency chaining — caller resolves to real task IDs
const PREV_SENTINEL = '$PREV';

// Pipeline stage keywords → model routing hints
const PIPELINE_STAGES = [
  { keywords: ['research', 'investigate', 'gather', 'survey', 'find information'], type: 'research', label: 'Research' },
  { keywords: ['analyze', 'analysis', 'evaluate', 'assess', 'examine'], type: 'analysis', label: 'Analysis' },
  { keywords: ['write', 'draft', 'compose', 'create content', 'author'], type: 'creative', label: 'Writing' },
  { keywords: ['code', 'implement', 'build', 'develop', 'program'], type: 'code', label: 'Implementation' },
  { keywords: ['review', 'polish', 'final pass', 'refine', 'proofread'], type: 'review', label: 'Review' },
  { keywords: ['summarize', 'synthesize', 'combine', 'merge', 'consolidate'], type: 'synthesis', label: 'Synthesis' },
];

// Keywords that signal consensus strategy
const CONSENSUS_KEYWORDS = ['consensus', 'agree', 'all models', 'compare models', 'cross-model', 'vote'];

// Keywords that signal parallel strategy
const PARALLEL_KEYWORDS = ['compare', 'parallel', 'independently', 'each model', 'side by side', 'side-by-side'];

/**
 * Detect which pipeline stages match the prompt.
 * Returns matched stages in order of appearance in PIPELINE_STAGES.
 */
function detectPipelineStages(prompt) {
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  return PIPELINE_STAGES.filter(stage =>
    stage.keywords.some(kw => lower.includes(kw))
  );
}

/**
 * Check if prompt matches any keywords in a list.
 */
function matchesAny(prompt, keywords) {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/**
 * Build a single subtask object.
 */
function buildSubtask({ prompt, type, label, dependsOn }) {
  const route = routeTask({ description: prompt, type });
  return {
    prompt,
    type: type || null,
    label: label || null,
    model: route.model,
    mode: route.mode,
    rationale: route.rationale,
    dependsOn: dependsOn || [],
  };
}

/**
 * Decompose a complex prompt into routed subtasks.
 *
 * @param {Object} options
 * @param {string} options.prompt - The user's prompt
 * @param {string} [options.strategy] - Force a strategy: 'pipeline', 'parallel', 'consensus', or 'auto'
 * @returns {{ strategy: string, subtasks: Array }}
 */
export function decomposeTask({ prompt, strategy } = {}) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { strategy: 'consensus', subtasks: [buildSubtask({ prompt: prompt || '', type: 'consensus', label: 'Consensus' , dependsOn: [] })] };
  }

  const trimmed = prompt.trim();
  const resolvedStrategy = resolveStrategy(trimmed, strategy);

  switch (resolvedStrategy) {
    case 'pipeline':
      return buildPipeline(trimmed);
    case 'parallel':
      return buildParallel(trimmed);
    case 'consensus':
    default:
      return buildConsensus(trimmed);
  }
}

/**
 * Determine the decomposition strategy.
 * Explicit strategy param wins; otherwise detect from prompt keywords.
 */
function resolveStrategy(prompt, explicit) {
  if (explicit && ['pipeline', 'parallel', 'consensus'].includes(explicit)) {
    return explicit;
  }

  // Auto-detect: consensus keywords first (highest priority)
  if (matchesAny(prompt, CONSENSUS_KEYWORDS)) {
    return 'consensus';
  }

  // Parallel keywords
  if (matchesAny(prompt, PARALLEL_KEYWORDS)) {
    return 'parallel';
  }

  // Pipeline: if 2+ stages detected
  const stages = detectPipelineStages(prompt);
  if (stages.length >= 2) {
    return 'pipeline';
  }

  // Default to consensus for single/unclear tasks
  return 'consensus';
}

/**
 * Build a pipeline decomposition: sequential stages with $PREV dependencies.
 */
function buildPipeline(prompt) {
  const stages = detectPipelineStages(prompt);

  // Should have 2+ stages (resolveStrategy guarantees this), but safeguard
  if (stages.length < 2) {
    return buildConsensus(prompt);
  }

  const subtasks = stages.map((stage, i) => {
    const stagePrompt = `[${stage.label}] ${prompt}`;
    const dependsOn = i === 0 ? [] : [PREV_SENTINEL];
    return buildSubtask({ prompt: stagePrompt, type: stage.type, label: stage.label, dependsOn });
  });

  return { strategy: 'pipeline', subtasks };
}

/**
 * Build a parallel decomposition: same prompt sent to all 3 models independently.
 */
function buildParallel(prompt) {
  const models = ['claude', 'chatgpt', 'gemini'];
  const subtasks = models.map(model => {
    const route = routeTask({ description: prompt });
    return {
      prompt,
      type: null,
      label: model,
      model,
      mode: route.mode,
      rationale: `Parallel execution on ${model}`,
      dependsOn: [],
    };
  });

  return { strategy: 'parallel', subtasks };
}

/**
 * Build a consensus decomposition: single task routed to all models.
 */
function buildConsensus(prompt) {
  return {
    strategy: 'consensus',
    subtasks: [buildSubtask({ prompt, type: 'consensus', label: 'Consensus', dependsOn: [] })],
  };
}
