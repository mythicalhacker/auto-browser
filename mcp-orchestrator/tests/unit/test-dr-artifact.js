import './_hermetic-env.js'; // pins REGISTRY_FILE (defaults) + QUOTA_FILE + RESEARCH_HOME
/**
 * DR report-ARTIFACT harvest tests — PR-16.
 * Claude renders a deep-research report as an expandable "Document" artifact.
 * The inline assistant message is only a SHORT summary + a card preview; the
 * FULL report is the side-panel's inner markdown, present in the DOM only once
 * the panel is open. The harvester must:
 *   - detect the artifact card (a full report exists beyond the summary),
 *   - open the panel via the View trigger when it is not already open,
 *   - read the panel's inner report body (longest content match, toolbar-free),
 *   - report {artifactPresent} so a not-yet-open panel never reads as "no report",
 *   - upgrade the runner's completion text to the fuller body ONLY when longer.
 */
import { harvestReportArtifact, panelContentReader } from '../../research/dr-artifact.js';
import { reportArtifactFor, _rebuildForTest, getProvider } from '../../models/registry.js';
import { waitForResearchComplete } from '../../research/runner.js';

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

// ---------------------------------------------------------------------------
console.log('panelContentReader — longest content match, toolbar-free:');
{
  // node with a toolbar prefix in its own innerText and an inner .standard-
  // markdown that is the report body. Content match must win over panel text.
  const node = {
    innerText: 'Copy\nPublish\n' + 'X'.repeat(1400),
    querySelectorAll: (s) => (s === '.standard-markdown' ? [{ innerText: 'X'.repeat(1400) }] : []),
  };
  const out = panelContentReader(node, ['.standard-markdown', '.font-claude-response']);
  assert(out === 'X'.repeat(1400), 'returns the inner content body (drops the Copy/Publish toolbar chrome)');

  // longest wins among multiple matches
  const multi = {
    innerText: 'panel',
    querySelectorAll: (s) => (s === '.a' ? [{ innerText: 'short' }, { innerText: 'a much longer body here' }] : []),
  };
  assert(panelContentReader(multi, ['.a']) === 'a much longer body here', 'longest match among several wins');

  // no content selector matches → fall back to the panel's own text (report
  // still captured, just with a little chrome — better than losing it)
  const noMatch = { innerText: 'the whole panel text', querySelectorAll: () => [] };
  assert(panelContentReader(noMatch, ['.nope']) === 'the whole panel text', 'no content match → panel innerText fallback');

  // robustness: empty selectors, bad querySelectorAll
  assert(panelContentReader({ innerText: 'p', querySelectorAll: () => [] }, []) === 'p', 'empty content selectors → panel text');
  assert(panelContentReader({ innerText: 'p', querySelectorAll: () => { throw new Error('bad'); } }, ['.x']) === 'p', 'throwing querySelectorAll handled → panel text');
}

// ---------------------------------------------------------------------------
console.log('\nharvestReportArtifact — {artifactPresent, text} contract:');
{
  const FULL = 'The Eiffel Tower was built 1887-1889. ' + 'Full report body. '.repeat(90);
  // A panel handle whose evaluate ACTUALLY runs the passed (fn, arg) against a
  // stubbed node — proves harvestReportArtifact threads panelContentReader AND
  // the content-selector arg (drop the arg → reads panel innerText, not the
  // scoped body).
  const panelHandle = {
    evaluate: async (fn, arg) => fn({
      innerText: 'Copy\nPublish\n' + FULL,
      querySelectorAll: (s) => (s === '.standard-markdown' ? [{ innerText: FULL }] : []),
    }, arg),
  };
  const triggerHandle = (opts) => ({ click: async () => { opts.clicked = (opts.clicked || 0) + 1; if (opts.opensOnClick) opts.panelOpen = true; } });
  const cfg = {
    card: ['[class*="artifact-block"]'],
    trigger: ['[class*="artifact-block"] button[aria-label^="View "]', 'button[aria-label^="View "]'],
    panel: ['div[role="region"][aria-label^="Artifact panel"]'],
    content: ['.standard-markdown', '.font-claude-response'],
  };
  const mkPage = (opts) => ({
    waitForTimeout: async () => {},
    $: async (sel) => {
      if (/Artifact panel/.test(sel)) return opts.panelOpen ? panelHandle : null;
      if (/View /.test(sel)) return opts.card ? triggerHandle(opts) : null;      // trigger button
      if (/artifact-block/.test(sel)) return opts.card ? {} : null;              // card
      return null;
    },
  });

  // no card config → not present
  let r = await harvestReportArtifact(mkPage({ card: false }), { card: [] });
  assert(r.artifactPresent === false && r.text === '', 'empty card config → {false, ""}');

  // card absent
  r = await harvestReportArtifact(mkPage({ card: false }), cfg);
  assert(r.artifactPresent === false && r.text === '', 'no artifact card → {false, ""}');

  // card present, panel ALREADY open → reads full body (no click needed)
  let opts = { card: true, panelOpen: true };
  r = await harvestReportArtifact(mkPage(opts), cfg);
  assert(r.artifactPresent === true && r.text.startsWith('The Eiffel Tower'), 'card + open panel → {true, full report}');
  assert(r.text.length > 1000 && !r.text.includes('Copy\nPublish'), 'harvested body is the full report, toolbar-free');
  assert((opts.clicked || 0) === 0, 'already-open panel is NOT clicked');

  // card present, panel CLOSED, opens on click → clicks trigger, then reads
  opts = { card: true, panelOpen: false, opensOnClick: true };
  r = await harvestReportArtifact(mkPage(opts), cfg);
  assert(r.artifactPresent === true && r.text.startsWith('The Eiffel Tower'), 'card + closed panel → clicks View, reads full report');
  assert(opts.clicked === 1, 'the View trigger was clicked exactly once to open the panel');

  // card present, panel CLOSED and click does NOT open it (expand-fails) →
  // {true, ''} so the caller keeps the inline summary, never "no report"
  opts = { card: true, panelOpen: false, opensOnClick: false };
  r = await harvestReportArtifact(mkPage(opts), cfg);
  assert(r.artifactPresent === true && r.text === '', 'card + panel that will not open (expand-fails) → {true, ""} (keep summary)');
  assert(opts.clicked === 1, 'expand-fails still attempted the click once');

  // panel.evaluate throws (detached mid-render) → {true, ''}
  const throwPage = {
    waitForTimeout: async () => {},
    $: async (sel) => {
      if (/Artifact panel/.test(sel)) return { evaluate: async () => { throw new Error('detached'); } };
      if (/View /.test(sel)) return {};
      if (/artifact-block/.test(sel)) return {};
      return null;
    },
  };
  r = await harvestReportArtifact(throwPage, cfg);
  assert(r.artifactPresent === true && r.text === '', 'panel.evaluate throws → {true, ""}');
}

// ---------------------------------------------------------------------------
console.log('\nregistry — reportArtifact descriptor + validation:');
{
  assert(reportArtifactFor('claude')?.card?.length > 0, 'claude has a reportArtifact with a card selector');
  assert(reportArtifactFor('chatgpt') === null && reportArtifactFor('gemini') === null, 'chatgpt/gemini have no reportArtifact');
  const ra = getProvider('claude').reportArtifact;
  assert(ra.panel.some((s) => s.includes('Artifact panel')), 'panel targets the artifact-panel region');
  assert(ra.trigger.some((s) => s.includes('View ')), 'trigger targets the View button');

  // Override GEMINI (no default reportArtifact → the override IS the whole
  // descriptor; claude would deep-merge its default keys back in).
  const rejects = (override, label) => {
    try { _rebuildForTest({ gemini: { reportArtifact: override } }); assert(false, label); }
    catch { assert(true, label); }
    finally { _rebuildForTest(null); }
  };
  rejects({ panel: ['x'] }, 'reportArtifact without card rejected');
  rejects({ card: ['x'] }, 'reportArtifact without panel rejected');
  rejects({ card: [], panel: ['x'] }, 'reportArtifact empty card rejected');
  rejects({ card: ['x'], panel: [] }, 'reportArtifact empty panel rejected');
  rejects({ card: ['x'], panel: ['y'], trigger: [] }, 'reportArtifact empty trigger rejected');
  rejects({ card: ['x'], panel: ['y'], content: 'c' }, 'reportArtifact non-array content rejected');
  try { _rebuildForTest({ gemini: { reportArtifact: { card: ['a'], panel: ['b'], trigger: ['c'], content: ['d'] } } }); assert(true, 'valid reportArtifact override accepted'); }
  catch (e) { assert(false, `valid reportArtifact override accepted (${e.message})`); }
  finally { _rebuildForTest(null); }
}

// ---------------------------------------------------------------------------
// Full completion-loop integration against the REAL claude descriptor. The
// inline SUMMARY (message DOM) drives completion; the artifact panel body then
// UPGRADES the returned text — but only when it is longer (monotonic), and
// falls back to the summary when there is no artifact or the panel won't open.
console.log('\nwaitForResearchComplete — artifact upgrade (real claude descriptor):');

// Pre-trimmed: the runner reads message text with .trim(), so the fallback
// cases compare res.text === SUMMARY exactly.
const SUMMARY = ('Your research report is ready. ' + 'It covers the timeline and the key figures in brief. '.repeat(11)).trim(); // ~600 chars ≥ min
const FULL = 'The Eiffel Tower was built 1887-1889 by Gustave Eiffel. ' + 'Detailed report paragraph. '.repeat(70); // >> summary

function el(text) {
  return { innerText: async () => text, isVisible: async () => true, evaluate: async () => Math.random().toString(36) };
}

function claudePage(opts) {
  const body = opts.full ?? FULL; // per-case panel body (short bodies pin the monotonic guard)
  const panelHandle = {
    evaluate: async (fn, arg) => fn({
      innerText: 'Copy\nPublish\n' + body,
      querySelectorAll: (s) => (s === '.standard-markdown' ? [{ innerText: body }] : []),
    }, arg),
  };
  const triggerHandle = { click: async () => { opts.clicked = (opts.clicked || 0) + 1; if (opts.opensOnClick) opts.panelOpen = true; } };
  return {
    url: () => 'https://claude.ai/chat/test',
    waitForTimeout: async () => {},
    reload: async () => {},
    evaluate: async () => ({ bodyText: '', content: '' }), // detectInterrupt chrome scan → no banner
    $: async (sel) => {
      if (/data-is-streaming/.test(sel)) return opts.streaming ? el('stop') : null;
      if (/Artifact panel/.test(sel)) return opts.panelOpen ? panelHandle : null;
      if (/View /.test(sel)) return opts.card ? triggerHandle : null;
      if (/artifact-block/.test(sel)) return opts.card ? {} : null;
      return null;
    },
    $$: async (sel) => {
      if (/font-claude-response/.test(sel)) return opts.summary ? [el(opts.summary)] : [];
      return []; // quotaBanner (role=status) etc.
    },
  };
}

const fast = { pollMs: 3, stableMs: 15, timeoutMs: 3000 };

{
  // (a) artifact panel already open → completion text upgraded to the full body.
  const opts = { summary: SUMMARY, card: true, panelOpen: true, streaming: false };
  const res = await waitForResearchComplete(claudePage(opts), 'claude', fast);
  assert(res.outcome === 'complete', 'summary drives completion (claude)');
  assert(res.text.length > SUMMARY.length && res.text.includes('Detailed report paragraph.'), 'returned text UPGRADED to the fuller artifact body');
  assert(!res.text.includes('Copy\nPublish'), 'upgraded text is the toolbar-free report body');
}
{
  // (b) panel closed, opens on click → still upgraded (one click).
  const opts = { summary: SUMMARY, card: true, panelOpen: false, opensOnClick: true, streaming: false };
  const res = await waitForResearchComplete(claudePage(opts), 'claude', fast);
  assert(res.outcome === 'complete' && res.text.includes('Detailed report paragraph.'), 'closed panel opened at completion and upgraded');
  assert(opts.clicked === 1, 'the panel was opened with exactly one click');
}
{
  // (c) NO artifact card → keeps the inline summary (fallback).
  const opts = { summary: SUMMARY, card: false, streaming: false };
  const res = await waitForResearchComplete(claudePage(opts), 'claude', fast);
  assert(res.outcome === 'complete' && res.text === SUMMARY, 'no artifact → inline summary kept (fallback)');
}
{
  // (d) card present but panel never opens → keeps the summary (monotonic: the
  //     empty artifact text is NOT shorter-swapped over the real summary).
  const opts = { summary: SUMMARY, card: true, panelOpen: false, opensOnClick: false, streaming: false };
  const res = await waitForResearchComplete(claudePage(opts), 'claude', fast);
  assert(res.outcome === 'complete' && res.text === SUMMARY, 'artifact present but panel unreadable → summary kept (never shortened)');
}
{
  // (e) NON-EMPTY but strictly SHORTER artifact body → summary kept. This pins
  //     the `>` guard (upgradeWithArtifact): a mere presence/non-empty check
  //     would wrongly swap in the shorter body and SHORTEN the report. The one
  //     case that distinguishes "strictly longer" from "artifactPresent && text".
  const shortBody = 'A terse partial capture.'; // non-empty, << SUMMARY
  const opts = { summary: SUMMARY, card: true, panelOpen: true, full: shortBody, streaming: false };
  const res = await waitForResearchComplete(claudePage(opts), 'claude', fast);
  assert(res.outcome === 'complete' && res.text === SUMMARY, 'non-empty but shorter artifact body → summary kept (guard is strictly-longer, never a bare presence check)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
