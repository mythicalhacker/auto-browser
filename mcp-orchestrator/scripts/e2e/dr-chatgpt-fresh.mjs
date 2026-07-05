#!/usr/bin/env node
// scripts/e2e/dr-chatgpt-fresh.mjs — ONE fresh composed ChatGPT deep-research
// run, end to end through the PRODUCT queue (PR-16 / GATE 16b). Generation (5
// recovered reports) and harvest (GATE 15, 4/4 recovery) were proven SEPARATELY;
// this is the first COMPOSED one-pass proof: submit → clarify-gate → OOPIF
// frame-wait → harvest, in a single product drain.
//
// Budget: exactly ONE ChatGPT DR (the only spend in PR-16). Drains ONLY chatgpt
// (the task's claude side stays queued and untouched — 0 claude, 0 gemini). The
// DR run itself is ≤2 chatgpt messages (the prompt + at most one clarify reply).
//
// Reuses the running debug Chrome; never logs in. Holds the cross-process drain
// lock for the duration.
//
// Usage: node scripts/e2e/dr-chatgpt-fresh.mjs [--prompt="..."]
import { readFileSync } from 'fs';
import { browserService } from '../../services/browser-service.js';
import { drainQueue } from '../../research/runner.js';
import { submitBatch, getTask, listTasks } from '../../research/research-queue.js';
import { quotaSnapshot } from '../../research/quota-ledger.js';
import { acquireDrainLock, releaseDrainLock } from '../../research/lockfile.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const PROMPT = flag('prompt', 'Provide a concise 2-paragraph history of the Python programming language: who created it, in what year it was first released, and its core design philosophy. Keep it short.');

const log = (m) => console.log(`[chatgpt-fresh ${new Date().toISOString().slice(11, 19)}] ${m}`);
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
// Content gates use BODY-only signals. NOTE "python" appears in the artifact
// HEADER (the header is the prompt, runner writeArtifact) — a topical match on
// it is a tautology, so it is reported for information but NOT gated on. The
// real report body signals — "Guido van Rossum" (not in the prompt) and the
// frame's "Research completed" marker (never in a plain message) — are what
// distinguish a real DR report from a long clarify/refusal turn.
const markers = (t) => ({
  chars: t.length,
  isReport: t.length >= 400,
  python: /python/i.test(t), // informational only (header tautology)
  vanRossum: /van rossum|guido/i.test(t),
  researchCompleted: /research completed/i.test(t),
});

const lock = acquireDrainLock();
if (!lock.ok) {
  console.error(`drain lock held by pid ${lock.holder?.pid} — another drainer is running; aborting`);
  process.exit(2);
}

try {
  await browserService.connect();
  const quotaBefore = quotaSnapshot(['chatgpt']).chatgpt;
  log(`chatgpt DR quota BEFORE: used=${quotaBefore.used} cap=${quotaBefore.cap ?? 'uncapped'}`);

  const { batch, taskIds } = submitBatch([{ prompt: PROMPT }], {});
  const taskId = taskIds[0];
  log(`submitted ${taskId} (batch ${batch}); draining chatgpt ONLY`);

  // Product drain, chatgpt only. DR runs take minutes — generous ceiling.
  const summary = await drainQueue(browserService, {
    providers: ['chatgpt'],
    batch,
    log,
    waitOpts: { stableMs: 45000, pollMs: 5000, timeoutMs: 25 * 60 * 1000 },
  });

  const after = getTask(taskId).perProvider.chatgpt;
  const claudeSide = getTask(taskId).perProvider.claude;
  const artifact = readText(after.artifactPath);
  const m = markers(artifact);

  const quotaAfter = quotaSnapshot(['chatgpt']).chatgpt;
  log(`chatgpt DR quota AFTER: used=${quotaAfter.used} cap=${quotaAfter.cap ?? 'uncapped'}`);

  const spentExactlyOne = quotaAfter.used === quotaBefore.used + 1;
  const claudeUntouched = claudeSide.status === 'queued' && claudeSide.spent === false;

  console.log('\n=== FRESH CHATGPT DR RESULT ===');
  console.log(JSON.stringify({
    drainSummary: summary,
    status: after.status,
    chatUrl: after.chatUrl,
    spentExactlyOne, quotaBefore: quotaBefore.used, quotaAfter: quotaAfter.used,
    claudeUntouched, claudeStatus: claudeSide.status,
    artifactPath: after.artifactPath,
    markers: m,
    head: artifact.split('\n').slice(0, 10).join(' / ').slice(0, 260),
  }, null, 2));

  // Gate on BODY-content signals (vanRossum + researchCompleted), NOT the
  // header-tautology `python` — a long clarify/refusal turn must not false-PASS.
  const ok = after.status === 'complete' && m.isReport && m.vanRossum && m.researchCompleted
    && spentExactlyOne && claudeUntouched;
  console.log(`\n${ok ? '✅ FRESH CHATGPT DR PASS' : '❌ FAIL'} · status=${after.status} · ${m.chars} chars · spent ${quotaBefore.used}→${quotaAfter.used}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  releaseDrainLock();
  await browserService.disconnect().catch(() => {});
}
