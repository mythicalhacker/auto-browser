#!/usr/bin/env node
// scripts/e2e/dr-harvest-recover.mjs — ZERO-SPEND ChatGPT deep-research harvest
// + recovery gate (PR-15). ChatGPT DR reports render in a sandboxed cross-
// origin iframe; the PR-14 harvester counted assistant turns (0) and discarded
// finished PAID reports as "no output". This gate proves the frame-harvest fix
// against REAL completed reports without spending a cent:
//
//   1. Resume the triage queue task through the PRODUCT resume path
//      (resumeProviderTask → waitForResearchComplete → harvest). No re-send,
//      no recordDRSpend — spend-safe by construction.
//   2. Sweep additional preserved chat URLs (prior "failed" DR runs) and re-
//      harvest each via harvestReportFrame → recovered artifacts on disk.
//   3. Assert the DR quota is UNCHANGED start→end (proves zero spend).
//
// Reuses the running debug Chrome; never logs in. Read-only except the
// recovered artifacts it writes and the triage task it flips to complete.
//
// Usage (supply your own targets — no real conversation URLs are baked in):
//   node scripts/e2e/dr-harvest-recover.mjs \
//     [--task=<queue-task-id>] \
//     [--urls=<c1>,<c2>,...] [--urls-file=<path>] [--out=<dir>]
//   or via env: DR_RECOVER_TASK / DR_RECOVER_URLS / DR_RECOVER_URLS_FILE.
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { browserService } from '../../services/browser-service.js';
import { resumeProviderTask } from '../../research/runner.js';
import { harvestReportFrame } from '../../research/dr-frame.js';
import { getTask } from '../../research/research-queue.js';
import { reportFrameFor } from '../../models/registry.js';
import { quotaSnapshot } from '../../research/quota-ledger.js';
import { RESEARCH_HOME } from '../../research/research-queue.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };

// Triage task recovered via the product resume path (step 1). This is a local
// queue id, not a conversation URL — supply your own via --task or DR_RECOVER_TASK.
// Empty ⇒ the product-resume step is skipped and only the sweep runs.
const TRIAGE_TASK = flag('task', process.env.DR_RECOVER_TASK || '');

// Prior "failed" ChatGPT DR chats whose paid reports the old harvester discarded,
// re-harvested in the sweep (step 2). Real conversation URLs are PRIVATE — they are
// NEVER hardcoded in this tracked file. Provide your own, in priority order:
//   --urls=<c1>,<c2>,...            (comma-separated) | DR_RECOVER_URLS env
//   --urls-file=<path>              (one URL per line; blank + #comment lines ignored)
//                                   | DR_RECOVER_URLS_FILE env
//   default fixtures file (untracked): $RESEARCH_HOME/e2e-fixtures/dr-recover-urls.txt
// With none provided the sweep is skipped and only the product-resume step runs.
function loadSweepUrls() {
  const inline = flag('urls', process.env.DR_RECOVER_URLS || '');
  if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean);
  const file = flag('urls-file', process.env.DR_RECOVER_URLS_FILE
    || join(RESEARCH_HOME, 'e2e-fixtures', 'dr-recover-urls.txt'));
  try {
    return readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  } catch { return []; }
}
const SWEEP_URLS = loadSweepUrls();
const OUT = flag('out', join(RESEARCH_HOME, 'recovered'));

// Mirror the runner's DR_MIN_REPORT_CHARS (intentionally module-private there).
const MIN_REPORT_CHARS = 400;
const log = (m) => console.log(`[dr-recover ${new Date().toISOString().slice(11, 19)}] ${m}`);
const markers = (t) => ({
  chars: t.length,
  isReport: t.length >= MIN_REPORT_CHARS,
  execSummary: /executive summary/i.test(t),
  nodejs: /node\.js/i.test(t),
  lts: /\bLTS\b/.test(t),
  researchCompleted: /research completed/i.test(t),
  citations: /citation/i.test(t),
});

let recovered = 0;
let attempted = 0;
const results = [];

try {
  await browserService.connect();
  const cfg = reportFrameFor('chatgpt');
  if (!cfg) throw new Error('chatgpt has no reportFrame descriptor — did PR-15 land?');

  const quotaBefore = quotaSnapshot(['chatgpt']).chatgpt;
  log(`chatgpt DR quota BEFORE: used=${quotaBefore.used} cap=${quotaBefore.cap ?? 'uncapped'}`);

  // ---- 1. Product resume path against the triage task ----
  const task = getTask(TRIAGE_TASK);
  if (task && task.perProvider?.chatgpt?.chatUrl) {
    attempted += 1;
    log(`resuming ${TRIAGE_TASK} chatgpt (product path, spend-safe): ${task.perProvider.chatgpt.chatUrl}`);
    const status = await resumeProviderTask(browserService, 'chatgpt', task, {
      log,
      waitOpts: { stableMs: 6000, pollMs: 3000, timeoutMs: 120000 },
    });
    const after = getTask(TRIAGE_TASK).perProvider.chatgpt;
    let text = '';
    if (after.artifactPath) { try { text = (await import('fs')).readFileSync(after.artifactPath, 'utf8'); } catch {} }
    const m = markers(text);
    const ok = status === 'complete' && m.isReport;
    if (ok) recovered += 1;
    results.push({ which: `${TRIAGE_TASK} (resume)`, status, artifact: after.artifactPath, ...m });
    log(`  → status=${status} artifact=${after.artifactPath ?? 'none'} chars=${m.chars} execSummary=${m.execSummary}`);
  } else {
    log(`triage task ${TRIAGE_TASK} not found or has no chatUrl — skipping product-path step`);
  }

  // ---- 2. Sweep prior chat URLs (direct navigate + frame harvest) ----
  const page = browserService.getPage('chatgpt');
  if (!page) throw new Error('no chatgpt page in the debug Chrome');
  mkdirSync(OUT, { recursive: true });
  for (const url of SWEEP_URLS) {
    attempted += 1;
    const id = (url.match(/\/c\/([a-f0-9-]+)/) || [])[1] || url.slice(-12);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // Give the OOPIF report frame time to attach + hydrate.
      let harvested = { hostPresent: false, text: '' };
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(2500);
        harvested = await harvestReportFrame(page, cfg);
        if (harvested.text.length >= MIN_REPORT_CHARS) break;
      }
      const m = markers(harvested.text);
      const ok = m.isReport;
      if (ok) {
        recovered += 1;
        const path = join(OUT, `chatgpt-${id}.md`);
        writeFileSync(path, `# Recovered ChatGPT DR report\n\n_source: ${url}_\n_recovered: PR-15 frame harvest_\n\n---\n\n${harvested.text}\n`);
        results.push({ which: id, status: 'recovered', hostPresent: harvested.hostPresent, artifact: path, ...m });
        log(`  ${id}: RECOVERED ${m.chars} chars → ${path} (execSummary=${m.execSummary} citations=${m.citations})`);
      } else {
        results.push({ which: id, status: harvested.hostPresent ? 'host-present-no-report' : 'no-report-frame', hostPresent: harvested.hostPresent, ...m });
        log(`  ${id}: no report (hostPresent=${harvested.hostPresent} chars=${m.chars})`);
      }
    } catch (e) {
      results.push({ which: id, status: `error: ${e.message.slice(0, 80)}` });
      log(`  ${id}: ERROR ${e.message.slice(0, 80)}`);
    }
  }

  const quotaAfter = quotaSnapshot(['chatgpt']).chatgpt;
  log(`chatgpt DR quota AFTER: used=${quotaAfter.used} cap=${quotaAfter.cap ?? 'uncapped'}`);
  const zeroSpend = quotaAfter.used === quotaBefore.used;

  console.log('\n=== DR HARVEST/RECOVERY RESULT ===');
  console.log(JSON.stringify({
    recovered, attempted,
    zeroSpend, quotaBefore: quotaBefore.used, quotaAfter: quotaAfter.used,
    results,
  }, null, 2));
  console.log(`\n${zeroSpend ? '✅ ZERO SPEND' : '❌ SPEND DETECTED'} · recovered ${recovered}/${attempted} report(s)`);
  process.exitCode = (zeroSpend && recovered > 0) ? 0 : 1;
} finally {
  await browserService.disconnect().catch(() => {});
}
