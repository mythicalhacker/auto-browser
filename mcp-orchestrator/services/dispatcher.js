// services/dispatcher.js — Dispatch engine: bridges task queue with execution
import { updateTask, areDependenciesMet, listTasks } from '../tools/task-queue.js';
import { sendToModel, waitForComplete, getOutput, runConsensusRound } from '../tools/consensus.js';
import { SELECTORS } from '../config.js';
import { findAll } from '../utils/selectors.js';

const MODELS = ['claude', 'chatgpt', 'gemini'];

// Model router: decide which model(s) to target for 'auto' tasks
function resolveTarget(target) {
  if (target === 'consensus' || target === 'all') return 'consensus';
  if (MODELS.includes(target)) return target;
  // 'auto' or anything else → consensus
  return 'consensus';
}

async function executeSingleModel(browserService, model, prompt) {
  await browserService.connect();
  const page = browserService.getPage(model);
  if (!page) throw new Error(`${model} tab not found — is Chrome open with ${model} logged in?`);

  const initialCount = (await findAll(page, SELECTORS[model].output)).length;
  await sendToModel(browserService, model, prompt);
  const result = await waitForComplete(browserService, page, model, initialCount);

  if (!result.complete) throw new Error(`${model} timed out after ${result.time}ms`);

  const output = await getOutput(browserService, model);
  return { model, output, time: result.time };
}

async function executeConsensus(browserService, prompt) {
  await browserService.connect();
  const round = await runConsensusRound(browserService, prompt, 1);
  return {
    model: 'consensus',
    output: round.outputs,
    time: round.duration
  };
}

export async function dispatchTask(taskId, browserService) {
  const task = updateTask(taskId, { status: 'active', started_at: new Date().toISOString() });

  try {
    const resolved = resolveTarget(task.target);
    let result;

    if (resolved === 'consensus') {
      result = await executeConsensus(browserService, task.prompt);
    } else {
      result = await executeSingleModel(browserService, resolved, task.prompt);
    }

    updateTask(taskId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result
    });

    return result;
  } catch (err) {
    updateTask(taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: err.message
    });
    throw err;
  }
}

export async function dispatchAll(browserService) {
  const pending = listTasks('pending');
  const results = [];

  for (const task of pending) {
    if (!areDependenciesMet(task.id)) {
      results.push({ id: task.id, name: task.name, status: 'blocked', reason: 'unmet dependencies' });
      continue;
    }

    try {
      const result = await dispatchTask(task.id, browserService);
      results.push({ id: task.id, name: task.name, status: 'completed', result });
    } catch (err) {
      results.push({ id: task.id, name: task.name, status: 'failed', error: err.message });
    }
  }

  return results;
}

// --- MCP Tool Definitions ---

const DISPATCH_TOOLS = [
  {
    name: 'task_run',
    description: 'Run a specific pending task by ID. Dispatches to the appropriate model or consensus workflow based on the task\'s target field.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to run (e.g. "task_1")' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'task_run_all',
    description: 'Run all pending tasks whose dependencies are met. Tasks are executed sequentially in priority order.',
    inputSchema: { type: 'object', properties: {} }
  }
];

export const DISPATCH_TOOL_NAMES = new Set(DISPATCH_TOOLS.map(t => t.name));

export function getDispatchToolDefinitions() {
  return DISPATCH_TOOLS;
}

export async function handleDispatchToolCall(name, args, browserService) {
  if (!DISPATCH_TOOL_NAMES.has(name)) return null;

  switch (name) {
    case 'task_run': {
      try {
        const result = await dispatchTask(args.task_id, browserService);
        const output = typeof result.output === 'object'
          ? Object.entries(result.output).map(([m, o]) => `=== ${m.toUpperCase()} ===\n${o}`).join('\n\n')
          : result.output;
        return { content: [{ type: 'text', text: `Task ${args.task_id} completed (${(result.time / 1000).toFixed(1)}s)\nModel: ${result.model}\n\n${output}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Task ${args.task_id} failed: ${err.message}` }] };
      }
    }

    case 'task_run_all': {
      const results = await dispatchAll(browserService);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No pending tasks to run.' }] };
      }
      let text = `Dispatched ${results.length} task(s):\n\n`;
      for (const r of results) {
        if (r.status === 'completed') {
          text += `  [${r.id}] ${r.name} — completed\n`;
        } else if (r.status === 'blocked') {
          text += `  [${r.id}] ${r.name} — blocked (${r.reason})\n`;
        } else {
          text += `  [${r.id}] ${r.name} — failed: ${r.error}\n`;
        }
      }
      return { content: [{ type: 'text', text }] };
    }

    default:
      return null;
  }
}
