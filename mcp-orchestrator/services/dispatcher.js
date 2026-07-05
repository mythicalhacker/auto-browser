// services/dispatcher.js — Dispatch engine: bridges task queue with execution
import { updateTask, areDependenciesMet, listTasks } from '../tools/task-queue.js';
import { sendToModel, waitForComplete, getOutput, runConsensusRound, selectModelsForRun } from '../tools/consensus.js';
import { SELECTORS } from '../config.js';
import { providerNames, getProvider } from '../models/registry.js';
import { getDriver } from '../models/drivers/index.js';
import { resolveModelName } from '../models/resolve.js';
import { findAll } from '../utils/selectors.js';
import { checkLogin } from '../utils/login-check.js';

const MODELS = providerNames();

// Model router: decide which model(s) to target for 'auto' tasks
function resolveTarget(target) {
  if (target === 'consensus' || target === 'all') return 'consensus';
  if (MODELS.includes(target)) return target;
  // 'auto' or anything else → consensus
  return 'consensus';
}

async function executeSingleModel(browserService, model, prompt, { explicit = null, policy = null } = {}) {
  await browserService.connect();
  const page = browserService.getPage(model);
  if (!page) throw new Error(`${model} tab not found — is Chrome open with ${model} logged in?`);

  // Same fast-fail as consensus rounds: a tab parked on a login URL must not
  // burn the full response ceiling. Selector misses stay inconclusive.
  const { loggedIn, reason } = await checkLogin(page, model);
  if (!loggedIn && reason.startsWith('URL contains login pattern')) {
    throw new Error(`${model} login_expired: ${reason}`);
  }

  // Explicit model selection before send (never inherit last-used). ensureChat
  // opens a fresh, model-pinned chat; an unavailable model falls back to the
  // configured default with a typed warning, surfaced in the result.
  const requested = resolveModelName(model, { explicit, policy });
  let selectedModel = null;
  let modelWarning = null;
  if (requested) {
    const setup = await getDriver(model).ensureChat(page, {
      model: requested,
      modelFallback: getProvider(model)?.models?.default ?? null,
    });
    selectedModel = setup.verified.model?.ok ? setup.verified.model.evidence : null;
    modelWarning = setup.warnings.find((w) => w.code === 'model_unavailable')?.detail ?? null;
  }

  const initialCount = (await findAll(page, SELECTORS[model].output)).length;
  await sendToModel(browserService, model, prompt);
  const result = await waitForComplete(browserService, page, model, initialCount);

  if (!result.complete) throw new Error(`${model} timed out after ${result.time}ms`);

  const output = await getOutput(browserService, model);
  return { model, requestedModel: requested, selectedModel, modelWarning, output, time: result.time };
}

async function executeConsensus(browserService, prompt, { models = null, policy = null } = {}) {
  await browserService.connect();
  const active = browserService.getActiveModels();
  const selection = await selectModelsForRun(browserService, active, { models, policy });
  const round = await runConsensusRound(browserService, prompt, 1);
  return {
    model: 'consensus',
    models: selection,
    output: round.outputs,
    errors: round.errors,
    time: round.duration
  };
}

export async function dispatchTask(taskId, browserService) {
  const task = updateTask(taskId, { status: 'active', started_at: new Date().toISOString() });

  try {
    const resolved = resolveTarget(task.target);
    const policy = task.modelPolicy ?? null;
    let result;

    if (resolved === 'consensus') {
      result = await executeConsensus(browserService, task.prompt, { models: task.models ?? null, policy });
    } else {
      // Single-provider target: its explicit model, if any, is models[provider].
      result = await executeSingleModel(browserService, resolved, task.prompt, {
        explicit: task.models?.[resolved] ?? null,
        policy,
      });
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
        let output = typeof result.output === 'object'
          ? Object.entries(result.output).map(([m, o]) => `=== ${m.toUpperCase()} ===\n${o}`).join('\n\n')
          : result.output;
        const failures = Object.entries(result.errors || {})
          .map(([m, e]) => `=== ${m.toUpperCase()} — FAILED (${e.phase}) ===\n${e.message}`).join('\n\n');
        if (failures) output = output ? `${output}\n\n${failures}` : failures;
        let modelLine = '';
        if (result.model === 'consensus' && result.models) {
          modelLine = 'Models: ' + Object.entries(result.models)
            .map(([m, s]) => `${m}=${s.ok ? s.verified : (s.warning ? 'default (unavailable)' : 'unverified')}`).join(', ') + '\n';
        } else if (result.requestedModel) {
          modelLine = `Model: ${result.requestedModel}${result.selectedModel ? ` → verified "${result.selectedModel}"` : ''}`
            + `${result.modelWarning ? ` — ${result.modelWarning}` : ''}\n`;
        }
        return { content: [{ type: 'text', text: `Task ${args.task_id} completed (${(result.time / 1000).toFixed(1)}s)\nTarget: ${result.model}\n${modelLine}\n${output}` }] };
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
