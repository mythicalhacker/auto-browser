#!/usr/bin/env node
// scripts/e2e/dr-claude-artifact.mjs — ZERO-SPEND Claude full-Document harvest
// gate (PR-16 / GATE 16a). Claude renders a deep-research report as an
// expandable "Document" artifact; PR-15's message-DOM harvest captured only the
// inline summary + a truncated card preview (~1.2k). This gate proves the
// artifact-panel harvest against the REAL completed PR-15 report without
// spending a cent:
//
//   1. Read the OLD artifact on disk (the ~1.2k summary-grade capture).
//   2. Resume the PR-15 task through the PRODUCT resume path
//      (resumeProviderTask → waitForResearchComplete → upgradeWithArtifact →
//      harvest). No re-send, no recordDRSpend — spend-safe by construction.
//   3. Assert the re-harvested artifact is materially LONGER (full report body)
//      and toolbar-free, and the DR quota is UNCHANGED start→end (zero spend).
//
// Reuses the running debug Chrome; never logs in.
//
// Usage:
//   DR_GATE_WATCH_MS=4000 DR_GATE_POLL_MS=1000 \
//     node scripts/e2e/dr-claude-artifact.mjs [--task=task-f8c1a87e]
import { readFileSync } from 'fs';
import { browserService } from '../../services/browser-service.js';
import { resumeProviderTask } from '../../research/runner.js';
import { harvestReportArtifact } from '../../research/dr-artifact.js';
import { getTask } from '../../research/research-queue.js';
import { reportArtifactFor } from '../../models/registry.js';
import { quotaSnapshot } from '../../research/quota-ledger.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const TASK_ID = flag('task', 'task-f8c1a87e');

const log = (m) => console.log(`[claude-artifact ${new Date().toISOString().slice(11, 19)}] ${m}`);
const readLen = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const markers = (t) => ({
  chars: t.length,
  eiffel: /eiffel/i.test(t),
  years: /1887|1889/.test(t),
  eiffelName: /gustave eiffel/i.test(t),
  toolbarChrome: /\bCopy\b\s*\n\s*\bPublish\b/.test(t), // panel toolbar must NOT leak in
});

try {
  await browserService.connect();
  const cfg = reportArtifactFor('claude');
  if (!cfg) throw new Error('claude has no reportArtifact descriptor — did PR-16 land?');

  const quotaBefore = quotaSnapshot(['claude']).claude;
  log(`claude DR quota BEFORE: used=${quotaBefore.used} cap=${quotaBefore.cap ?? 'uncapped'}`);

  const task = getTask(TASK_ID);
  if (!task || !task.perProvider?.claude?.chatUrl) throw new Error(`task ${TASK_ID} not found or has no claude chatUrl`);
  const chatUrl = task.perProvider.claude.chatUrl;
  const oldArtifact = readLen(task.perProvider.claude.artifactPath);
  log(`OLD artifact (PR-15 message-DOM harvest): ${oldArtifact.length} chars`);

  // ---- Direct read: message-DOM summary vs artifact panel body (the delta) ----
  const page = browserService.getPage('claude');
  if (!page) throw new Error('no claude page in the debug Chrome');
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const summaryEls = await page.$$('.font-claude-response .standard-markdown');
  let summaryLen = 0;
  if (summaryEls.length) { try { summaryLen = (await summaryEls[0].innerText()).trim().length; } catch {} }
  const direct = await harvestReportArtifact(page, cfg);
  log(`DIRECT: message-DOM summary=${summaryLen} chars · artifact panel=${direct.text.length} chars (present=${direct.artifactPresent})`);

  // ---- Product resume path (spend-safe) — re-harvests + rewrites the artifact ----
  const status = await resumeProviderTask(browserService, 'claude', task, {
    log,
    waitOpts: { stableMs: 5000, pollMs: 2500, timeoutMs: 120000 },
  });
  const after = getTask(TASK_ID).perProvider.claude;
  const newArtifact = readLen(after.artifactPath);
  const m = markers(newArtifact);

  const quotaAfter = quotaSnapshot(['claude']).claude;
  log(`claude DR quota AFTER: used=${quotaAfter.used} cap=${quotaAfter.cap ?? 'uncapped'}`);
  const zeroSpend = quotaAfter.used === quotaBefore.used;

  // Success: complete, the re-harvest is a real report, it GREW vs the old
  // summary-grade capture, it carries the report content, and no toolbar chrome.
  const grew = newArtifact.length > oldArtifact.length;
  const isReport = m.chars >= 400 && m.eiffel && m.years;
  const upgradedViaArtifact = direct.artifactPresent && direct.text.length > summaryLen;

  console.log('\n=== CLAUDE FULL-DOCUMENT HARVEST RESULT ===');
  console.log(JSON.stringify({
    status,
    zeroSpend, quotaBefore: quotaBefore.used, quotaAfter: quotaAfter.used,
    oldArtifactChars: oldArtifact.length,
    newArtifactChars: newArtifact.length,
    messageSummaryChars: summaryLen,
    artifactPanelChars: direct.text.length,
    grew, isReport, upgradedViaArtifact,
    markers: m,
    artifactPath: after.artifactPath,
    newHead: newArtifact.split('\n').slice(0, 8).join(' / ').slice(0, 240),
  }, null, 2));

  const ok = status === 'complete' && zeroSpend && grew && isReport && upgradedViaArtifact && !m.toolbarChrome;
  console.log(`\n${ok ? '✅ CLAUDE FULL-DOCUMENT HARVEST PASS' : '❌ FAIL'} · ${summaryLen}→${newArtifact.length} chars · ${zeroSpend ? 'zero spend' : 'SPEND DETECTED'}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browserService.disconnect().catch(() => {});
}
