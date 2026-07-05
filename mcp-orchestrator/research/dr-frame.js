// research/dr-frame.js — harvest a deep-research report that renders inside a
// sandboxed cross-origin iframe (OOPIF), not in the assistant-message DOM.
//
// Live-probed 2026-07-05 (ChatGPT): a completed DR report renders as
//   chatgpt page
//   └─ <iframe title="internal://deep-research"
//              src="…connector_openai_deep_research.web-sandbox.oaiusercontent.com"
//              sandbox="allow-scripts allow-same-origin allow-forms">   ← OOPIF, empty #root shell
//      └─ <iframe src="about:blank">   ← SAME-ORIGIN grandchild = the report (main.innerText)
//
// page.frames()/contentFrame().locator() CANNOT read the OOPIF grandchild
// (Playwright does not traverse into it — bodyLen 0). But JS run INSIDE the
// sandbox frame reaches the same-origin grandchild via contentDocument. So the
// harvest is: main-DOM iframe element → contentFrame() (the sandbox shell) →
// frame.evaluate(reportWalker) which descends contentDocument to the report.
//
// This replaces the broken completion signal for ChatGPT DR: assistant-turn
// count is 0 for a finished report (it never lands in the message DOM). The
// presence of the report iframe ELEMENT is the real completion HOST signal.
//
// (Fallback not implemented, documented per plan: the report card also exposes
// a download control in main DOM. It would require driving a download + reading
// a file, and risks a save dialog — the in-frame text read below is sufficient
// and dialog-free, so it is the only path. Revisit only if OpenAI stops
// rendering the report text in the same-origin grandchild.)
import { findFirst } from '../utils/selectors.js';

/**
 * Runs INSIDE the sandbox OOPIF frame (via frame.evaluate). Descends all
 * SAME-ORIGIN nested iframes (the report lives in a nested about:blank doc),
 * and returns the LONGEST text matched by any bodySelector — the report.
 * Cross-origin children throw on contentDocument and are skipped. Returns ''
 * when nothing matches yet (frame still hydrating → caller keeps polling).
 * Defined as a real function (not a string) so Playwright serializes it and
 * passes bodySelectors as an argument.
 */
export function reportWalker(bodySelectors) {
  const docs = [];
  (function collect(doc, depth) {
    if (!doc || depth > 6) return;
    docs.push(doc);
    let frames = [];
    try { frames = doc.querySelectorAll ? Array.from(doc.querySelectorAll('iframe')) : []; } catch (e) { frames = []; }
    for (const f of frames) {
      let cd = null;
      try { cd = f.contentDocument; } catch (e) { cd = null; } // cross-origin → skip
      if (cd) collect(cd, depth + 1);
    }
  })(document, 0);
  let best = '';
  for (const doc of docs) {
    for (const sel of bodySelectors) {
      let el = null;
      try { el = doc.querySelector(sel); } catch (e) { el = null; }
      if (el) {
        const t = ((el.innerText || '') + '').trim();
        if (t.length > best.length) best = t;
      }
    }
  }
  return best;
}

// The animated citation/search COUNTERS ("… · 12 citations · 55 searches")
// render each digit as an odometer column — the FULL ascending 0..9 stack,
// which innerText reads as `0\n1\n2\n…\n9`, one column per digit, several in a
// row. Match ONLY that exact ascending-0-9 shape (one or more consecutive
// columns), so a real single-digit DATA column in the report (e.g. a
// "5\n4\n3\n2\n1" table) is NEVER eaten — the reason a looser "4+ newline-
// separated digits" collapse was wrong (adversarial review, PR-15).
const COUNTER_REEL_RE = /(?:\n[ \t]*0[ \t]*\n[ \t]*1[ \t]*\n[ \t]*2[ \t]*\n[ \t]*3[ \t]*\n[ \t]*4[ \t]*\n[ \t]*5[ \t]*\n[ \t]*6[ \t]*\n[ \t]*7[ \t]*\n[ \t]*8[ \t]*\n[ \t]*9)+/g;

/**
 * Cosmetic cleanup of harvested DR report text (pure — unit-tested). Collapses
 * the animated odometer counter reels; contiguous numbers (years "2026",
 * versions "24.11.0", inline footnote markers, single-digit data columns) all
 * survive untouched.
 */
export function cleanDrReportText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let t = raw.replace(/\r\n?/g, '\n');
  t = t.replace(COUNTER_REEL_RE, ''); // animated 0-9 odometer counters
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/**
 * Harvest the report-frame text for a provider whose reports render in an
 * OOPIF (registry `reportFrame`). Returns:
 *   { hostPresent, text }
 * hostPresent — the report iframe ELEMENT is mounted in main DOM. This is the
 *   DR completion HOST signal (present ⟺ a report host exists) and must gate
 *   any "no output" conclusion: a present host with empty text means the frame
 *   is still hydrating, NOT that the run produced nothing.
 * text — the cleaned report body, or '' if the frame is not yet readable.
 * @param {import('playwright').Page} page
 * @param {{frameElement: string[], bodySelector?: string[]}} cfg
 */
export async function harvestReportFrame(page, cfg) {
  if (!cfg || !Array.isArray(cfg.frameElement) || cfg.frameElement.length === 0) {
    return { hostPresent: false, text: '' };
  }
  const match = await findFirst(page, cfg.frameElement);
  if (!match) return { hostPresent: false, text: '' };
  let frame = null;
  try {
    frame = await match.element.contentFrame();
  } catch {
    frame = null;
  }
  // Host is mounted regardless of whether the sandbox frame is readable yet.
  if (!frame) return { hostPresent: true, text: '' };
  // `?? ` would NOT replace an empty array, and an empty bodySelector makes the
  // walker read nothing → a present-but-empty host that strands a finished paid
  // report as a timeout. Fall back to the default whenever it is empty/missing.
  const bodySelectors = cfg.bodySelector?.length ? cfg.bodySelector : ['main', 'body'];
  let raw = '';
  try {
    raw = await frame.evaluate(reportWalker, bodySelectors);
  } catch {
    raw = ''; // frame detached / mid-navigation → keep polling
  }
  return { hostPresent: true, text: cleanDrReportText(raw || '') };
}
