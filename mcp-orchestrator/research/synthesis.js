// research/synthesis.js — per-task synthesis: compile all provider reports
// into one final report via a two-stage pipeline.
//   Stage 1 (compilation): every active model receives ALL of the task's
//     reports (embedded FULL, no compression) + the user's compilation prompt,
//     and produces a synthesis draft.
//   Stage 2 (verdict rounds): 1–2 cross-pollinated VERDICT rounds over the
//     drafts (peer drafts compressed via the existing context-compression,
//     verdict-strip applied) converge to one final report.
// Final = the converged synthesis (consensus) or, if max rounds hit, the
// fullest draft with the disagreement noted.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as consensus from '../tools/consensus.js';
import * as queue from './research-queue.js';

const PROMPTS_DIR = process.env.PROMPTS_DIR || join(homedir(), '.auto-browser', 'prompts');
const COMPILATION_TEMPLATE_FILE = join(PROMPTS_DIR, 'compilation.md');

// Sane built-in used when the user has not dropped their own template (PAUSE-C
// deferral). Placeholders: {{TOPIC}}, {{COUNT}}, {{REPORTS}}.
export const DEFAULT_COMPILATION_TEMPLATE = `You are compiling ONE authoritative report from {{COUNT}} independent research reports produced by different AI systems on the same task.

TASK:
{{TOPIC}}

Below are the {{COUNT}} reports. Treat every claim as a hypothesis to verify, not as fact — they may disagree or contain errors.

{{REPORTS}}

YOUR JOB:
1. Cross-check the reports against each other. Where they AGREE, state the shared finding once, confidently.
2. Where they DISAGREE or only one report makes a claim, flag it explicitly and give your best-judged resolution (or note the open question).
3. Adversarially test the strongest claims — call out anything unsupported, outdated, or internally inconsistent.
4. Produce a single, well-structured final report that a decision-maker could act on: the verified findings, the disagreements and how you resolved them, and any remaining uncertainties.

Write the final report now.`;

export function loadCompilationTemplate() {
  try {
    if (existsSync(COMPILATION_TEMPLATE_FILE)) {
      const t = readFileSync(COMPILATION_TEMPLATE_FILE, 'utf8').trim();
      // A template without {{REPORTS}} would silently drop every report while
      // the FINAL still claims N sources — reject it and use the built-in.
      if (t && t.includes('{{REPORTS}}')) return { template: t, source: COMPILATION_TEMPLATE_FILE };
      if (t) console.error(`[synthesis] ${COMPILATION_TEMPLATE_FILE} is missing {{REPORTS}} — using the built-in template`);
    }
  } catch {
    // unreadable → fall back to the built-in
  }
  return { template: DEFAULT_COMPILATION_TEMPLATE, source: 'built-in' };
}

/** Reports for a task from its complete providers' artifacts. */
export function loadReports(task) {
  const reports = [];
  for (const [provider, pp] of Object.entries(task.perProvider)) {
    if (pp.status !== 'complete' || !pp.artifactPath || !existsSync(pp.artifactPath)) continue;
    try {
      reports.push({ provider, text: readFileSync(pp.artifactPath, 'utf8') });
    } catch {
      // artifact vanished — skip
    }
  }
  return reports;
}

export function buildCompilationPrompt(task, reports, template) {
  const reportsBlock = reports
    .map((r) => `=== REPORT FROM ${r.provider.toUpperCase()} ===\n${r.text}`)
    .join('\n\n');
  // Single pass with a FUNCTION replacement: $-sequences in report text
  // ($', $&, $$) are never interpreted, and substituted values are never
  // rescanned for further placeholders.
  const values = { TOPIC: task.prompt, COUNT: String(reports.length), REPORTS: reportsBlock };
  return String(template).replace(/\{\{(TOPIC|COUNT|REPORTS)\}\}/g, (_, key) => values[key]);
}

/**
 * Pick the final report from the most recent round that produced drafts. An
 * all-error final verdict round must NOT discard good earlier drafts (and the
 * paid synthesis with them) — fall back newest→oldest.
 */
function selectFinal(rounds, consensusReached) {
  let drafts = [];
  let usedRound = rounds.length;
  for (let i = rounds.length - 1; i >= 0; i--) {
    drafts = Object.entries(rounds[i].outputs || {})
      .map(([model, text]) => [model, consensus.stripVerdictLines(text)])
      .filter(([, text]) => text && text.trim());
    if (drafts.length > 0) { usedRound = i + 1; break; }
  }
  if (drafts.length === 0) return { text: null, from: null };
  // Fullest draft is the most complete synthesis; when converged they are
  // substantially equivalent anyway.
  drafts.sort((a, b) => b[1].length - a[1].length);
  const [from, text] = drafts[0];
  const header = consensusReached
    ? `_Synthesis converged (consensus) across ${drafts.length} model(s); final drawn from ${from}._`
    : `_No full consensus after ${rounds.length} round(s); final is the fullest synthesis (${from}, round ${usedRound}). Divergences may remain — see the per-provider reports._`;
  return { text: `${header}\n\n${text}`, from };
}

export function finalPath(task) {
  return join(queue.artifactDir(task, null), 'FINAL.md');
}

/**
 * Synthesize one task. Requires ≥2 complete reports.
 * @param browserService live browser service
 * @param taskId
 * @param opts { maxVerdictRounds=2, responseTimeoutMs, template, deps }
 *   deps lets tests inject the consensus round primitives.
 * @returns {status, finalPath?, consensusReached?, rounds?, reason?}
 */
export async function synthesizeTask(browserService, taskId, opts = {}) {
  const task = queue.getTask(taskId);
  if (!task) return { status: 'error', reason: `unknown task ${taskId}` };

  const reports = loadReports(task);
  if (reports.length < 2) {
    return { status: 'insufficient_reports', reason: `need ≥2 complete reports, have ${reports.length}` };
  }

  // Fan-out is driven by the OPEN model tabs, not the report set — gate on
  // active models BEFORE building/sending the huge compilation prompt so we
  // never spend a message on a <2-model run that can't produce a synthesis.
  const activeModels = browserService.getActiveModels();
  if (activeModels.length < 2) {
    return { status: 'insufficient_models', reason: `found ${activeModels.length} model tab(s), need ≥2 to synthesize` };
  }

  const deps = opts.deps ?? {
    runConsensusRound: consensus.runConsensusRound,
    generateConsensusPrompt: consensus.generateConsensusPrompt,
    checkConsensusReached: consensus.checkConsensusReached,
  };
  const rawRounds = Number(opts.maxVerdictRounds);
  const maxVerdictRounds = Number.isFinite(rawRounds) ? Math.min(Math.max(Math.trunc(rawRounds), 1), 5) : 2;
  const { template } = opts.template ? { template: opts.template } : loadCompilationTemplate();
  const compilationPrompt = buildCompilationPrompt(task, reports, template);
  // Verdict rounds reference the reports already in the conversation rather
  // than re-embedding all of them (that made each round LARGER than stage 1).
  const verdictTaskLine = `Compile one authoritative final report for this research task: ${task.prompt}\n`
    + `(The ${reports.length} source reports and your first synthesis are earlier in this conversation.)`;

  // Stage 1 — compilation drafts (same big prompt to every active model).
  const rounds = [];
  const stage1 = await deps.runConsensusRound(browserService, compilationPrompt, 1, {
    responseTimeoutMs: opts.responseTimeoutMs ?? null,
  });
  rounds.push(stage1);
  const draftCount = Object.keys(stage1.outputs || {}).length;
  if (draftCount < 2) {
    return { status: 'failed', reason: `only ${draftCount} model produced a synthesis draft`, rounds };
  }

  // Stage 2 — verdict rounds over the drafts until consensus or the cap.
  // Consensus is NOT checked after stage 1: that round carries no verdict
  // instruction, so a draft quoting "VERDICT: AGREE" must not short-circuit.
  let consensusReached = false;
  for (let r = 0; r < maxVerdictRounds && !consensusReached; r++) {
    const active = browserService.getActiveModels();
    if (active.length < 2) break;
    // Build a prompt for EVERY active model (runConsensusRound sends to all
    // of them); a model absent from the last round still gets a valid prompt.
    const prompts = Object.fromEntries(
      active.map((model) => [model, deps.generateConsensusPrompt(verdictTaskLine, rounds, model)])
    );
    const round = await deps.runConsensusRound(browserService, prompts, rounds.length + 1, {
      responseTimeoutMs: opts.responseTimeoutMs ?? null,
    });
    rounds.push(round);
    consensusReached = deps.checkConsensusReached(rounds);
  }

  const final = selectFinal(rounds, consensusReached);
  if (!final.text) return { status: 'failed', reason: 'no synthesis draft to export', rounds };

  const dir = queue.artifactDir(task, null);
  mkdirSync(dir, { recursive: true });
  const path = finalPath(task);
  writeFileSync(path, `# FINAL — ${task.prompt.slice(0, 120)}\n\n`
    + `_task ${task.id} · batch ${task.batch} · ${reports.length} source report(s) · `
    + `${rounds.length} synthesis round(s) · consensus=${consensusReached}_\n\n---\n\n${final.text}\n`);
  writeFileSync(join(dir, 'FINAL.meta.json'), JSON.stringify({
    task: task.id,
    batch: task.batch,
    sources: reports.map((r) => r.provider),
    rounds: rounds.length,
    consensusReached,
    finalFrom: final.from,
    chars: final.text.length,
  }, null, 2));

  return { status: 'complete', finalPath: path, consensusReached, rounds: rounds.length };
}
