// research/dr-artifact.js — harvest a deep-research report that Claude renders
// as an expandable "Document" ARTIFACT, not (fully) in the assistant-message
// DOM. Unlike the ChatGPT OOPIF (dr-frame.js), this is all SAME-ORIGIN main
// DOM — no cross-origin frame gymnastics — but the full report lives in a side
// panel that must be OPENED (a click) before its text is in the DOM.
//
// Live-probed 2026-07-05 (Claude): a completed DR report renders as
//   assistant message
//   ├─ .font-claude-response .standard-markdown   ← a SHORT inline SUMMARY (~0.5k)
//   └─ div.group/artifact-block  "…Document…"      ← the artifact CARD (a preview)
//        └─ button[aria-label^="View …"]           ← opens the side panel
//   div[role="region"][aria-label^="Artifact panel"]   ← the OPEN panel
//        └─ .standard-markdown                     ← the FULL report body (~1.4k)
//
// The message-DOM harvest captured only the summary + a truncated card preview
// (PR-15 got ~1.2k of the report; the summary alone is ~0.5k). The full report
// is the panel's inner markdown. On a WIDE viewport the panel auto-opens
// side-by-side; on a narrow/fresh run it starts closed and the View button
// must be clicked. So: read the panel if already mounted, else click the
// trigger and wait for the panel region to appear (verified open).
import { findFirst } from '../utils/selectors.js';
import { cleanDrReportText } from './dr-frame.js';

// After clicking the trigger, poll this long for the panel region to mount.
export const ARTIFACT_OPEN_POLLS = 6;
const ARTIFACT_OPEN_POLL_MS = 500;

/**
 * Runs INSIDE the page via `panelElement.evaluate(panelContentReader, sels)`.
 * Returns the LONGEST innerText among the content selectors found WITHIN the
 * panel (the report body), or — only if none match — the panel's own text.
 * Preferring a content match over the panel text drops the panel's "Copy /
 * Publish" toolbar chrome. Defined as a real function so Playwright serializes
 * it and passes contentSelectors as the argument.
 */
export function panelContentReader(node, contentSelectors) {
  let best = '';
  for (const sel of (contentSelectors || [])) {
    let els = [];
    try { els = node.querySelectorAll ? Array.from(node.querySelectorAll(sel)) : []; } catch (e) { els = []; }
    for (const el of els) {
      const t = ((el.innerText || '') + '').trim();
      if (t.length > best.length) best = t;
    }
  }
  // Fallback only when no content selector matched: the panel's own text still
  // carries the report (with a little toolbar chrome) — better than losing it.
  if (!best) best = ((node.innerText || '') + '').trim();
  return best;
}

/**
 * Harvest the full report for a provider whose report renders in an expandable
 * artifact panel (registry `reportArtifact`). Returns:
 *   { artifactPresent, text }
 * artifactPresent — the artifact CARD is in the message. This is the "a full
 *   report exists beyond the inline summary" signal; a present card with empty
 *   text means the panel is not open/readable yet, NOT that there is no report.
 * text — the cleaned full report body, or '' if the panel could not be read.
 * @param {import('playwright').Page} page
 * @param {{card: string[], trigger?: string[], panel: string[], content?: string[]}} cfg
 */
export async function harvestReportArtifact(page, cfg) {
  if (!cfg || !Array.isArray(cfg.card) || cfg.card.length === 0) {
    return { artifactPresent: false, text: '' };
  }
  const card = await findFirst(page, cfg.card);
  if (!card) return { artifactPresent: false, text: '' };

  const panelSel = Array.isArray(cfg.panel) ? cfg.panel : [];
  let panel = await findFirst(page, panelSel);
  // Panel not open yet → click the View trigger and wait for it to mount.
  if (!panel && Array.isArray(cfg.trigger) && cfg.trigger.length > 0) {
    const trig = await findFirst(page, cfg.trigger);
    if (trig) {
      try { await trig.element.click({ force: true }); } catch { /* control moved — try to read anyway */ }
      for (let i = 0; i < ARTIFACT_OPEN_POLLS && !panel; i++) {
        try { await page.waitForTimeout(ARTIFACT_OPEN_POLL_MS); } catch { /* */ }
        panel = await findFirst(page, panelSel);
      }
    }
  }
  // Artifact exists but its panel is not readable yet (click failed / still
  // opening): report the card presence so the caller keeps the inline summary
  // rather than concluding there is no report.
  if (!panel) return { artifactPresent: true, text: '' };

  let raw = '';
  try {
    raw = await panel.element.evaluate(panelContentReader, cfg.content ?? []);
  } catch {
    raw = ''; // panel detached / mid-render → keep polling / fall back
  }
  return { artifactPresent: true, text: cleanDrReportText(raw || '') };
}
