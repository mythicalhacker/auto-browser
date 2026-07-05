// tools/research.js — MCP tools for the deep-research batch pipeline.
// Thin wrappers over research/research-queue.js, research/synthesis.js, and
// research/quota-ledger.js. Execution (DR runs) is done by the headless
// runner or a future attach path; these tools submit, inspect, collect,
// synthesize, and export. STDIO-safe: no console.log.
import { existsSync, readFileSync } from 'fs';
import * as queue from '../research/research-queue.js';
import { synthesizeTask, finalPath } from '../research/synthesis.js';
import { quotaSnapshot } from '../research/quota-ledger.js';
import { acquireDrainLock, releaseDrainLock } from '../research/lockfile.js';
import { providerNames } from '../models/registry.js';
import { validateModelsArg, validateModelPolicy } from '../models/resolve.js';

const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

function statusLine(providers) {
  return Object.entries(providers)
    .map(([p, s]) => `${p}:${s.status}${s.spent ? '*' : ''}${s.artifactPath ? ' ✓' : ''}`)
    .join('  ');
}

export async function handleResearchToolCall(name, args = {}, browserService = null) {
  switch (name) {
    case 'research_submit_batch': {
      const items = args.items;
      if (!Array.isArray(items) || items.length === 0) {
        return err('research_submit_batch: "items" must be a non-empty array of {prompt, project?, gemini_priority?}');
      }
      try {
        // Validate model args up front (batch-level + per item) so a bad
        // policy/provider errors at submit, not mid-drain.
        const models = validateModelsArg(args.models);
        const modelPolicy = validateModelPolicy(args.model_policy);
        for (const it of items) {
          if (it.models) validateModelsArg(it.models);
          if (it.model != null && (typeof it.model !== 'string' || !it.model.trim())) {
            throw new Error("each item's 'model' must be a non-empty string");
          }
          if (it.model_policy != null) validateModelPolicy(it.model_policy);
        }
        const { batch, taskIds } = queue.submitBatch(items, { models, modelPolicy });
        const geminiPriority = items.filter((i) => i.gemini_priority).length;
        return ok(`Submitted batch ${batch}: ${taskIds.length} task(s), ${geminiPriority} gemini-priority.\n`
          + `Routing: gemini-priority → gemini+claude+chatgpt; others → claude+chatgpt.\n`
          + `Task ids:\n${taskIds.map((id, i) => `  ${i + 1}. ${id}`).join('\n')}\n\n`
          + `Run them with the headless runner (drains unattended):\n`
          + `  caffeinate -dims node scripts/run-queue.js --batch=${batch}`);
      } catch (e) {
        return err(`research_submit_batch failed: ${e.message}`);
      }
    }

    case 'research_status': {
      const table = queue.statusTable(args.batch ?? null);
      if (table.length === 0) return ok('No research tasks.' + (args.batch ? ` (batch ${args.batch})` : ''));
      const lines = table.map((t) =>
        `${t.id}  [${t.geminiPriority ? 'G' : ' '}] ${t.prompt}\n    ${statusLine(t.providers)}`);
      return ok(`Research status${args.batch ? ` (batch ${args.batch})` : ''}:\n\n${lines.join('\n')}\n\n`
        + `legend: status  * = spent (DR started)  ✓ = artifact on disk`);
    }

    case 'research_collect': {
      const task = queue.getTask(args.task_id);
      if (!task) return err(`research_collect: unknown task ${args.task_id}`);
      const parts = [];
      for (const [provider, pp] of Object.entries(task.perProvider)) {
        if (pp.status === 'complete' && pp.artifactPath && existsSync(pp.artifactPath)) {
          const body = readFileSync(pp.artifactPath, 'utf8');
          parts.push(`=== ${provider.toUpperCase()} (${body.length} chars) → ${pp.artifactPath} ===\n${body.slice(0, 1200)}${body.length > 1200 ? '\n…(truncated; full report on disk)' : ''}`);
        } else {
          parts.push(`=== ${provider.toUpperCase()} — ${pp.status}${pp.error ? `: ${pp.error}` : ''} ===${pp.chatUrl ? `\n   chat: ${pp.chatUrl}` : ''}`);
        }
      }
      return ok(`Task ${task.id}: ${task.prompt}\n\n${parts.join('\n\n')}`);
    }

    case 'research_synthesize': {
      const task = queue.getTask(args.task_id);
      if (!task) return err(`research_synthesize: unknown task ${args.task_id}`);
      if (!browserService) return err('research_synthesize needs a live browser (call via the MCP server, not headless).');
      // Mutual exclusion with the headless drain / another synthesis: both
      // drive the shared browser tabs, and interleaved sends corrupt each
      // other. Same cross-process lock the runner uses.
      const lock = acquireDrainLock();
      if (!lock.ok) return err(`research_synthesize: a research runner/synthesis is active (pid ${lock.holder.pid}) — try again when it finishes.`);
      try {
        await browserService.connect(); // fresh server has null page slots until connected
        const res = await synthesizeTask(browserService, args.task_id, {
          maxVerdictRounds: args.max_verdict_rounds,
          responseTimeoutMs: args.response_timeout_ms ?? null,
        });
        if (res.status !== 'complete') {
          return err(`research_synthesize ${res.status}: ${res.reason ?? ''}`);
        }
        return ok(`Synthesized ${task.id}: ${res.rounds} round(s), consensus=${res.consensusReached}.\n`
          + `FINAL → ${res.finalPath}\nRetrieve with research_export.`);
      } finally {
        releaseDrainLock();
      }
    }

    case 'research_export': {
      const task = queue.getTask(args.task_id);
      if (!task) return err(`research_export: unknown task ${args.task_id}`);
      const path = finalPath(task);
      if (!existsSync(path)) {
        return err(`No FINAL.md for ${task.id} yet — run research_synthesize first. Expected at ${path}`);
      }
      const body = readFileSync(path, 'utf8');
      return ok(`FINAL report for ${task.id} → ${path}\n\n${body}`);
    }

    case 'quota_status': {
      const snap = quotaSnapshot(providerNames());
      const lines = Object.entries(snap).map(([p, s]) => {
        const cap = s.cap === null ? 'uncapped' : `${s.used}/${s.cap}`;
        const cd = s.cooldownUntil ? ` · cooldown until ${new Date(s.cooldownUntil).toISOString()}` : '';
        return `  ${p}: DR today ${cap}${s.eligible ? '' : ` · BLOCKED (${s.reason})`}${cd}`;
      });
      return ok(`Deep-research quota (day ${snap[providerNames()[0]]?.day}):\n${lines.join('\n')}`);
    }

    default:
      return err(`Unknown research tool: ${name}`);
  }
}

const RESEARCH_TOOLS = [
  {
    name: 'research_submit_batch',
    description: 'Submit a batch of deep-research prompts. gemini_priority tasks run on Gemini (daily-capped) + Claude + ChatGPT; others on Claude + ChatGPT. Returns task ids; drain with the headless runner.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              project: { type: 'string', description: 'optional provider project/notebook to run inside' },
              gemini_priority: { type: 'boolean', description: 'also run on Gemini (top-5 priority set)' },
              timeout_ms: { type: 'integer', description: 'per-task DR wait ceiling override' },
              model: { type: 'string', description: 'explicit DR model for ALL of this task\'s providers (overrides the batch default)' },
              models: { type: 'object', description: 'explicit DR model per provider for this task, e.g. {"gemini":"3.1 Pro"} (overrides model + batch default)' },
              model_policy: { type: 'string', enum: ['default', 'cheapest'], description: "this task's model tier when no explicit model is set" },
            },
            required: ['prompt'],
          },
        },
        models: { type: 'object', description: 'batch-level default DR model per provider, e.g. {"chatgpt":"Pro Extended"}. Per-item model/models override it; otherwise the provider\'s DR research profile model is used.' },
        model_policy: { type: 'string', enum: ['default', 'cheapest'], description: "batch-level model tier when neither an explicit model nor the DR profile applies" },
      },
      required: ['items'],
    },
  },
  {
    name: 'research_status',
    description: 'Per task × provider status table for a batch (or all).',
    inputSchema: { type: 'object', properties: { batch: { type: 'string' } } },
  },
  {
    name: 'research_collect',
    description: 'Show a task\'s collected reports (per provider) with on-disk artifact paths.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'research_synthesize',
    description: 'Synthesize one task\'s reports (≥2) into a final report via compilation + verdict rounds. Runs the consensus machinery live (long-running).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        max_verdict_rounds: { type: 'integer', minimum: 1, maximum: 5, description: 'verdict rounds over the drafts (default 2)' },
        response_timeout_ms: { type: 'integer', minimum: 1000, maximum: 7200000, description: 'per-response wait ceiling (synthesis prompts are large)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'research_export',
    description: 'Return the FINAL.md synthesized report for a task.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'quota_status',
    description: 'Deep-research quota per provider: today\'s count vs cap, cooldowns, eligibility.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function getResearchToolDefinitions() { return RESEARCH_TOOLS; }
export const RESEARCH_TOOL_NAMES = new Set(RESEARCH_TOOLS.map((t) => t.name));
