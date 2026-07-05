import './_hermetic-env.js'; // pins REGISTRY_FILE (defaults) + QUOTA_FILE + RESEARCH_HOME
/**
 * DR report-frame harvest tests — PR-15.
 * ChatGPT deep-research reports render in a sandboxed cross-origin iframe
 * (OOPIF), NOT in the assistant-message DOM. The harvester must:
 *   - read the report from the frame (via a contentDocument walker),
 *   - treat the report iframe ELEMENT as the completion HOST signal so
 *     assistantTurns:0 never yields a false "no output" (the PR-14 bug),
 *   - fall back to the plain message DOM when no report host is present,
 *   - clean animated citation/search digit-reels without eating real numbers.
 */
import { cleanDrReportText, reportWalker, harvestReportFrame } from '../../research/dr-frame.js';
import { reportFrameFor, _rebuildForTest, getProvider } from '../../models/registry.js';
import { waitForResearchComplete } from '../../research/runner.js';

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

// ---------------------------------------------------------------------------
console.log('cleanDrReportText — animated digit-reel removal:');
{
  // Real odometer reels are FULL ascending 0-9 columns (per live probe), one
  // per digit — here two columns (a two-digit count like "12"/"55").
  const reel = '\n0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n0\n1\n2\n3\n4\n5\n6\n7\n8\n9';
  const raw = `Research completed in 2m · ${reel} citations · ${reel} searches\n`
    + 'Node.js LTS Release History\nExecutive summary\n\n'
    + 'Node.js 24.11.0 shipped in 2026; v16 EOL was 2023. LTS lines: 4, 6, 8, 10, 12.\nSee footnote 1 and 2.';
  const out = cleanDrReportText(raw);
  assert(!/\n0\n1\n2\n3/.test(out), 'ascending 0-9 odometer reels collapsed');
  assert(out.includes('2026') && out.includes('24.11.0') && out.includes('2023'), 'contiguous numbers (years/versions) preserved');
  assert(out.includes('4, 6, 8, 10, 12'), 'inline number list preserved');
  assert(/footnote 1 and 2/.test(out), 'inline footnote markers preserved');
  assert(out.includes('Executive summary'), 'report body preserved');
  // The reel matcher is ascending-0-9-specific: a genuine single-digit DATA
  // column (descending, or repeated, or partial-ascending) must NOT be eaten.
  assert(cleanDrReportText('Scores:\n5\n4\n3\n2\n1\nAvg: 3').includes('5\n4\n3\n2\n1'), 'descending single-digit data column preserved');
  assert(cleanDrReportText('Ratings\n5\n5\n5\n5\n5\nend').includes('5\n5\n5\n5\n5'), 'repeated single-digit data column preserved');
  assert(cleanDrReportText('a\n0\n1\n2\nb') === 'a\n0\n1\n2\nb', 'partial ascending (0-2, not a full reel) preserved');
  assert(cleanDrReportText('') === '' && cleanDrReportText(null) === '' && cleanDrReportText(undefined) === '', 'empty/null/undefined → ""');
  assert(cleanDrReportText('a\r\nb\r\nc').includes('a\nb\nc'), 'CRLF normalized');
  assert(!/\n{3,}/.test(cleanDrReportText('a\n\n\n\n\nb')), 'excess blank lines collapsed');
}

// ---------------------------------------------------------------------------
console.log('\nreportWalker — descends same-origin nested iframes, picks report:');
{
  // Build a fake document tree: sandbox shell (#root, empty) → about:blank
  // grandchild with <main> = report. A cross-origin iframe throws on
  // contentDocument and must be skipped, not crash.
  const mkDoc = (byTag, bySel) => ({
    querySelectorAll: (s) => (s === 'iframe' ? (byTag.iframe || []) : []),
    querySelector: (s) => (bySel[s] ?? null),
  });
  const grandchild = mkDoc({}, { main: { innerText: 'REPORT BODY '.repeat(50) }, body: { innerText: 'noise' } });
  const crossOriginIframe = { get contentDocument() { throw new Error('cross-origin'); } };
  const grandchildIframe = { contentDocument: grandchild };
  const sandboxShell = mkDoc({ iframe: [grandchildIframe, crossOriginIframe] }, { '#root': { innerText: '' } });

  const prevDoc = globalThis.document;
  globalThis.document = sandboxShell;
  try {
    const out = reportWalker(['main', 'body']);
    assert(out === ('REPORT BODY '.repeat(50)).trim(), 'walker returns the nested <main> report text (longest match)');
    // No report anywhere → '' (and cross-origin throw handled)
    globalThis.document = mkDoc({ iframe: [crossOriginIframe] }, {});
    assert(reportWalker(['main', 'body']) === '', 'no report + cross-origin child → "" (no crash)');
    // Depth cap: a self-referential iframe must not loop forever.
    const loopDoc = {};
    Object.assign(loopDoc, mkDoc({ iframe: [{ contentDocument: loopDoc }] }, { body: { innerText: 'x' } }));
    globalThis.document = loopDoc;
    assert(reportWalker(['main', 'body']) === 'x', 'self-referential frame tree terminates (depth cap)');
  } finally {
    globalThis.document = prevDoc;
  }
}

// ---------------------------------------------------------------------------
console.log('\nharvestReportFrame — {hostPresent, text} contract:');
{
  const RAW = 'Research completed in 2m · \n0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n citations\nNode.js LTS Release History\n' + 'Body. '.repeat(100);
  const iframeEl = (frame) => ({ element: { contentFrame: async () => frame } });
  const framePage = (opts) => ({
    $: async (sel) => {
      if (/web-sandbox|internal:\/\/deep-research/.test(sel)) return opts.iframe ? { contentFrame: async () => opts.frame } : null;
      return null;
    },
  });
  const cfg = { frameElement: ['iframe[src*="web-sandbox.oaiusercontent.com"]'], bodySelector: ['main', 'body'] };

  // no frameElement config
  let r = await harvestReportFrame(framePage({ iframe: false }), { frameElement: [] });
  assert(r.hostPresent === false && r.text === '', 'empty frameElement config → {false, ""}');

  // host absent
  r = await harvestReportFrame(framePage({ iframe: false }), cfg);
  assert(r.hostPresent === false && r.text === '', 'no iframe element → {false, ""}');

  // host present, frame null (contentFrame → null)
  r = await harvestReportFrame(framePage({ iframe: true, frame: null }), cfg);
  assert(r.hostPresent === true && r.text === '', 'host present but frame not ready → {true, ""}');

  // host present, frame returns report (canned) — cleaning applied
  r = await harvestReportFrame(framePage({ iframe: true, frame: { evaluate: async () => RAW } }), cfg);
  assert(r.hostPresent === true && r.text.includes('Node.js LTS Release History'), 'host present + frame text → {true, report}');
  assert(!/\n0\n1\n2\n3/.test(r.text), 'harvested text is cleaned (reels removed)');

  // FIDELITY: a frame whose evaluate ACTUALLY runs the passed (fn, arg) against
  // a stubbed document — proves harvestReportFrame threads reportWalker AND the
  // bodySelector arg (if the arg were dropped, reportWalker(undefined) throws →
  // caught → ''). The report is reachable ONLY via 'main', so passing a
  // bodySelector of ['main'] and getting text back proves the arg is used.
  const realWalkerFrame = {
    evaluate: async (fn, arg) => {
      const prev = globalThis.document;
      globalThis.document = {
        querySelectorAll: (s) => (s === 'iframe' ? [] : []),
        querySelector: (s) => (s === 'main' ? { innerText: 'THREADED REPORT ' + 'x'.repeat(600) } : null),
      };
      try { return fn(arg); } finally { globalThis.document = prev; }
    },
  };
  r = await harvestReportFrame(framePage({ iframe: true, frame: realWalkerFrame }), { frameElement: cfg.frameElement, bodySelector: ['main'] });
  assert(r.hostPresent === true && r.text.startsWith('THREADED REPORT'), 'harvestReportFrame threads the real walker + bodySelector arg (found report only reachable via the passed selector)');

  // empty bodySelector must fall back to the default (not read nothing)
  r = await harvestReportFrame(framePage({ iframe: true, frame: realWalkerFrame }), { frameElement: cfg.frameElement, bodySelector: [] });
  assert(r.hostPresent === true && r.text.startsWith('THREADED REPORT'), 'empty bodySelector falls back to [main,body] (never reads nothing)');

  // host present, frame.evaluate throws → {true, ""}
  r = await harvestReportFrame(framePage({ iframe: true, frame: { evaluate: async () => { throw new Error('detached'); } } }), cfg);
  assert(r.hostPresent === true && r.text === '', 'frame.evaluate throws (detached) → {true, ""}');
}

// ---------------------------------------------------------------------------
console.log('\nregistry — reportFrame descriptor + validation:');
{
  assert(reportFrameFor('chatgpt')?.frameElement?.length > 0, 'chatgpt has a reportFrame with frameElement');
  assert(reportFrameFor('gemini') === null && reportFrameFor('claude') === null, 'gemini/claude have no reportFrame');
  const chatgptRf = getProvider('chatgpt').reportFrame;
  assert(chatgptRf.frameElement.some((s) => s.includes('web-sandbox.oaiusercontent.com')), 'frameElement targets the web-sandbox OOPIF');
  assert(chatgptRf.completeText === 'Research completed', 'completeText marker configured');

  // Override GEMINI (no default reportFrame → the override IS the whole
  // descriptor; chatgpt would deep-merge its default frameElement back in).
  const rejects = (override, label) => {
    try { _rebuildForTest({ gemini: { reportFrame: override } }); assert(false, label); }
    catch { assert(true, label); }
    finally { _rebuildForTest(null); }
  };
  rejects({ bodySelector: ['main'] }, 'reportFrame without frameElement rejected');
  rejects({ frameElement: [] }, 'reportFrame with empty frameElement rejected');
  rejects({ frameElement: 'iframe' }, 'reportFrame.frameElement non-array rejected');
  rejects({ frameElement: ['iframe'], completeText: '' }, 'reportFrame.completeText empty string rejected');
  rejects({ frameElement: ['iframe'], bodySelector: 'main' }, 'reportFrame.bodySelector non-array rejected');
  rejects({ frameElement: ['iframe'], bodySelector: [] }, 'reportFrame.bodySelector empty array rejected (would strand a report as timeout)');
  // valid override accepted
  try { _rebuildForTest({ chatgpt: { reportFrame: { frameElement: ['iframe.x'], bodySelector: ['main'], completeText: 'done', urlPattern: 'x' } } }); assert(true, 'valid reportFrame override accepted'); }
  catch (e) { assert(false, `valid reportFrame override accepted (${e.message})`); }
  finally { _rebuildForTest(null); }
}

// ---------------------------------------------------------------------------
// Full completion-loop integration against the REAL chatgpt descriptor (its
// config.js SELECTORS shim + reportFrame). A fake page answers the real
// selectors. This proves the assistantTurns:0 false-negative is fixed.
console.log('\nwaitForResearchComplete — frame-aware completion (real chatgpt descriptor):');

const REPORT = 'Research completed in 2m · citations · searches\nNode.js LTS Release History\nExecutive summary\n' + 'The modern LTS lines are the even majors. '.repeat(40);
const isStreamSel = (s) => /Stop streaming|stop-button/.test(s);
const isFrameSel = (s) => /web-sandbox|internal:\/\/deep-research/.test(s);

function el(text) {
  return {
    innerText: async () => text,
    isVisible: async () => true,
    evaluate: async () => Math.random().toString(36),
  };
}

/**
 * Fake chatgpt page. opts:
 *   host: report iframe present?  streaming: stop-button visible?
 *   frameTexts: array of successive frame reads (last value sticks) — models
 *     hydration.  plain: text for the plain message-DOM fallback.
 */
function chatgptPage(opts) {
  let evalCalls = 0;
  const frame = {
    evaluate: async () => {
      const arr = opts.frameTexts ?? [];
      const v = arr[Math.min(evalCalls, arr.length - 1)] ?? '';
      evalCalls += 1;
      return v;
    },
  };
  return {
    url: () => 'https://chatgpt.com/c/test',
    waitForTimeout: async () => {},
    reload: async () => { opts.reloaded = (opts.reloaded || 0) + 1; },
    evaluate: async () => ({ bodyText: '', content: '' }), // detectInterrupt chrome scan → no banner
    $: async (sel) => {
      if (isFrameSel(sel)) return opts.host ? { contentFrame: async () => frame } : null;
      if (isStreamSel(sel)) return opts.streaming ? el('stop') : null;
      return null;
    },
    $$: async (sel) => {
      if (/assistant|markdown/.test(sel)) return opts.plain ? [el(opts.plain)] : [];
      return []; // quotaBanner etc.
    },
  };
}

const fast = { pollMs: 3, stableMs: 15, timeoutMs: 3000 };

{
  // (a) report host present, full stable report, not streaming → complete via frame.
  const opts = { host: true, streaming: false, frameTexts: [REPORT] };
  const res = await waitForResearchComplete(chatgptPage(opts), 'chatgpt', fast);
  assert(res.outcome === 'complete', 'host + stable frame report → complete (NOT timeout, despite assistantTurns:0)');
  assert(res.text.includes('Executive summary') && !/\n[0-9]\n[0-9]\n[0-9]\n[0-9]/.test(res.text), 'harvested cleaned report text returned');
  assert((opts.reloaded || 0) === 0, 'never reloaded when the report host is present');
}
{
  // (b) hydration: host present, frame empty for the first polls, then fills → complete.
  const opts = { host: true, streaming: false, frameTexts: ['', '', REPORT] };
  const res = await waitForResearchComplete(chatgptPage(opts), 'chatgpt', fast);
  assert(res.outcome === 'complete', 'present host + initially-empty frame does NOT declare no-output; completes once hydrated');
  assert((opts.reloaded || 0) === 0, 'present-but-empty host never triggers a reload');
}
{
  // (c) fallback: NO report host, but a plain message-DOM report → complete via plain path.
  const opts = { host: false, streaming: false, plain: REPORT };
  const res = await waitForResearchComplete(chatgptPage(opts), 'chatgpt', fast);
  assert(res.outcome === 'complete' && res.text.includes('Executive summary'), 'no report host → plain message DOM used as fallback');
}
{
  // (d) frameDone relaxation: full report WITH "Research completed" marker but a
  //     lingering stop-button → still completes (marker overrides stale stream).
  const opts = { host: true, streaming: true, frameTexts: [REPORT] };
  const res = await waitForResearchComplete(chatgptPage(opts), 'chatgpt', fast);
  assert(res.outcome === 'complete', 'in-frame "Research completed" marker completes despite a lingering streaming control');
}
{
  // (e) short/interim frame text (< min chars) with a lingering stream → NOT complete (times out).
  const opts = { host: true, streaming: true, frameTexts: ['Researching…'] };
  const res = await waitForResearchComplete(chatgptPage(opts), 'chatgpt', { pollMs: 3, stableMs: 15, timeoutMs: 200 });
  assert(res.outcome === 'timeout', 'interim short frame text does not complete (streaming still up)');
}
{
  // (f) STUB GUARD (isolated): short frame text (< DR_MIN_REPORT_CHARS) with NO
  // streaming control and stable → must STILL time out, proving the min-chars
  // length gate (NOT the streaming gate) blocks harvesting a stub as the final
  // paid report. If the length guard regressed, this stub would false-complete.
  const opts = { host: true, streaming: false, frameTexts: ['Researching…'] };
  const res = await waitForResearchComplete(chatgptPage(opts), 'chatgpt', { pollMs: 3, stableMs: 15, timeoutMs: 200 });
  assert(res.outcome === 'timeout', 'short stable NON-streaming frame text does not complete (DR_MIN_REPORT_CHARS guard isolated)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
