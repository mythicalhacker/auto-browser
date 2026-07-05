import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * Model Selection Tests — PR-14 contract.
 * THE $400 LESSON: every product send resolves an EXPLICIT model
 * (per-call → per-task → configured default; model_policy swaps the final
 * tier). An unavailable model yields a typed model_unavailable WARNING and
 * falls back to the default — mirroring project_not_found — never a hard
 * failure, never a guess, never silently inheriting the tab's last-used model.
 */
import { join } from 'path';
import { tmpdir } from 'os';

process.env.STATE_FILE = join(tmpdir(), `model-sel-test-${process.pid}.json`);

const registry = await import('../../models/registry.js');
const resolve = await import('../../models/resolve.js');
const { getDriver } = await import('../../models/drivers/index.js');
const { calibrateModels } = await import('../../models/drivers/common.js');
const { selectModelsForRun, perProviderSends } = await import('../../tools/consensus.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}
function throws(fn, mustInclude, name) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert(e && (!mustInclude || e.message.includes(mustInclude)), name);
}

const SEL = {
  input: ['#composer'], submit: ['#send'], output: ['.answer'], streaming: ['.streaming'],
  modelPicker: ['#picker'], modelPickerItem: ['[role="option"]'], modelPickerLabel: ['#picker-label'],
};

/** Fake provider site with a working model picker (like test-drivers.js). */
function fakeSite({ models = ['Haiku 4.5', 'Sonnet 5', 'Opus 4.8'], current = 'Opus 4.8', pickWorks = true } = {}) {
  const state = { url: 'https://claude.ai/new', pickerOpen: false, current, draft: '', selectAll: false };
  const el = (text, { onClick } = {}) => ({
    innerText: async () => (typeof text === 'function' ? text() : text),
    click: async () => onClick?.(),
    getAttribute: async () => null,
    evaluate: async () => Math.random().toString(36),
    isVisible: async () => true,
  });
  const label = () => state.current;
  const page = {
    url: () => state.url,
    goto: async (u) => { state.url = u; state.pickerOpen = false; },
    waitForTimeout: async () => {},
    keyboard: {
      press: async (k) => {
        if (k === 'Escape') state.pickerOpen = false;
        if (k === 'ControlOrMeta+a') state.selectAll = true;
        if (k === 'Backspace' && state.selectAll) { state.draft = ''; state.selectAll = false; }
      },
      insertText: async (t) => { state.draft += t; },
    },
    $$: async (s) => {
      switch (s) {
        case '#composer': return [el(() => state.draft)];
        case '#picker': return [el(label, { onClick: () => { state.pickerOpen = true; } })];
        case '#picker-label': return [el(label)];
        case '[role="option"]':
          return state.pickerOpen ? models.map((m) => el(m, { onClick: () => { if (pickWorks) state.current = m; state.pickerOpen = false; } })) : [];
        default: return [];
      }
    },
    $: async (s) => (await page.$$(s))[0] ?? null,
  };
  return { page, state };
}

const CLAUDE_MODELS = { choices: ['Haiku 4.5', 'Sonnet 5', 'Opus 4.8'], default: 'Sonnet 5', cheapest: 'Haiku 4.5' };
const installClaude = () => registry._rebuildForTest({ claude: { selectors: SEL, models: CLAUDE_MODELS } });

console.log('Model Selection Tests (PR-14)\n');

// --- resolve.js pure resolution + validation --------------------------------
console.log('resolution order (per-call → per-task → policy default):');
registry._rebuildForTest(null); // real defaults: claude cheapest Haiku 4.5, default Sonnet 5
{
  assert(resolve.resolveModelName('claude', { explicit: 'Opus 4.8' }) === 'Opus 4.8', 'explicit wins over everything');
  assert(resolve.resolveModelName('claude', { explicit: 'Opus 4.8', policy: 'cheapest' }) === 'Opus 4.8', 'explicit beats policy');
  assert(resolve.resolveModelName('claude', { policy: 'cheapest' }) === 'Haiku 4.5', 'policy cheapest → cheapest');
  assert(resolve.resolveModelName('claude', { policy: 'default' }) === 'Sonnet 5', 'policy default → default');
  assert(resolve.resolveModelName('claude', {}) === 'Sonnet 5', 'no policy → configured default');
  assert(resolve.resolveModelName('claude', { explicit: '   ' }) === 'Sonnet 5', 'blank explicit is ignored (falls through to default)');
  const map = resolve.resolveModelsForProviders(['claude', 'chatgpt'], { policy: 'cheapest' });
  assert(map.claude.name === 'Haiku 4.5' && map.claude.source === 'cheapest', 'resolveModelsForProviders maps cheapest + source');
  assert(map.chatgpt.name === 'Instant', 'chatgpt cheapest resolved');
}

console.log('\nargument validation:');
{
  assert(resolve.validateModelPolicy('cheapest') === 'cheapest', 'valid policy passes');
  assert(resolve.validateModelPolicy(null) === null, 'null policy → null');
  throws(() => resolve.validateModelPolicy('fast'), 'model_policy', 'unknown policy throws');
  assert(JSON.stringify(resolve.validateModelsArg({ claude: 'Haiku 4.5' })) === JSON.stringify({ claude: 'Haiku 4.5' }), 'valid models map passes through trimmed');
  assert(resolve.validateModelsArg(null) === null, 'null models → null');
  throws(() => resolve.validateModelsArg({ nope: 'x' }), 'unknown provider', 'unknown provider in models throws');
  throws(() => resolve.validateModelsArg({ claude: '' }), 'non-empty', 'empty model name throws');
  throws(() => resolve.validateModelsArg([]), 'object mapping', 'array models arg throws');
  const parsed = resolve.parseModelSelection({ model_policy: 'cheapest', models: { claude: 'Opus 4.8' } });
  assert(parsed.policy === 'cheapest' && parsed.models.claude === 'Opus 4.8', 'parseModelSelection returns validated pair');
}

// --- registry model-config schema + drift -----------------------------------
console.log('\nregistry model-config schema:');
{
  registry._rebuildForTest(null);
  const m = registry.modelConfigFor('claude');
  assert(m && m.default === 'Sonnet 5' && m.cheapest === 'Haiku 4.5', 'claude model config present');
  assert(registry.testModelFor('claude') === 'Haiku 4.5', 'testModelFor defaults to cheapest');
  assert(registry.testModelFor('gemini') === '3.1 Flash-Lite', 'gemini testModel = cheapest');

  const rejects = (models, mustInclude, label) => {
    let e = null;
    try { registry._rebuildForTest({ claude: { models } }); } catch (x) { e = x; }
    registry._rebuildForTest(null);
    assert(e && e.message.includes('Invalid provider registry') && e.message.includes(mustInclude), label);
  };
  rejects({ choices: ['A', 'B'], default: 'C', cheapest: 'A' }, 'models.default', 'default outside choices rejected loudly');
  rejects({ choices: ['A', 'B'], default: 'A', cheapest: 'Z' }, 'models.cheapest', 'cheapest outside choices rejected');
  rejects({ choices: [], default: 'A', cheapest: 'A' }, 'models.choices', 'empty choices rejected');
  rejects({ choices: ['A'], default: 'A', cheapest: 'A', testModel: 'Q' }, 'models.testModel', 'testModel outside choices rejected');
  // testModel IN choices is accepted and used by testModelFor
  registry._rebuildForTest({ claude: { models: { choices: ['A', 'B'], default: 'B', cheapest: 'A', testModel: 'B' } } });
  assert(registry.testModelFor('claude') === 'B', 'explicit testModel overrides cheapest');
  registry._rebuildForTest(null);
}

console.log('\nmodel drift report (picker is the source of truth):');
{
  registry._rebuildForTest(null);
  const noDrift = registry.modelDriftReport('claude', ['Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5']);
  assert(noDrift.drifted === false && noDrift.cheapestPresent && noDrift.defaultPresent, 'identical live snapshot → no drift, resolvable names present');
  const added = registry.modelDriftReport('claude', ['Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5', 'Fable 6']);
  assert(added.drifted === true && added.added.includes('Fable 6') && added.missing.length === 0, 'a new live model is reported as added drift');
  const missingCheap = registry.modelDriftReport('claude', ['Fable 5', 'Opus 4.8', 'Sonnet 5']);
  assert(missingCheap.missing.includes('Haiku 4.5') && missingCheap.cheapestPresent === false,
    'cheapest absent from the live picker is flagged (would break cost pinning)');
}

// --- driver model_unavailable fallback (mirrors project_not_found) ----------
console.log('\ndriver: available model selected, no warning:');
{
  installClaude();
  const s = fakeSite();
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Haiku 4.5', modelFallback: 'Sonnet 5' });
  assert(r.verified.model?.ok === true && s.state.current === 'Haiku 4.5', 'requested available model selected + verified');
  assert(!r.warnings.some((w) => w.code === 'model_unavailable'), 'no model_unavailable warning when the model exists');
}

console.log('\ndriver: unavailable model + fallback → warning + default (result stays ok):');
{
  installClaude();
  const s = fakeSite();
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Bogus 9', modelFallback: 'Sonnet 5' });
  assert(r.warnings.some((w) => w.code === 'model_unavailable'), 'typed model_unavailable warning emitted');
  assert(r.ok === true, 'fallback keeps result ok (mirrors project_not_found)');
  assert(r.verified.model?.ok === true && s.state.current === 'Sonnet 5', 'the configured default was actually selected');
  assert(r.verified.model.requested === 'Bogus 9' && r.verified.model.fallbackTo === 'Sonnet 5', 'fallback trail recorded for status surfaces');
}

console.log('\ndriver: unavailable model + NO fallback → hard fail:');
{
  installClaude();
  const s = fakeSite();
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Bogus 9' });
  assert(r.ok === false && r.verified.model?.ok === false, 'unavailable model without fallback fails the result');
  assert(r.verified.model?.code === 'model_unavailable', 'typed model_unavailable code (menu opened, name absent)');
  assert(!r.warnings.some((w) => w.code === 'model_unavailable'), 'no fallback warning when there is no fallback');
}

console.log('\ndriver: empty picker is picker_not_found, NOT a silent fallback:');
{
  installClaude();
  const s = fakeSite({ models: [] }); // picker opens but offers nothing
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Haiku 4.5', modelFallback: 'Sonnet 5' });
  assert(r.ok === false && r.verified.model?.code === 'picker_not_found',
    'a picker that renders no items is a UI failure, not model_unavailable — must not fall back to a pricier default silently');
}

console.log('\ndriver: fallback equal to the requested model does not loop:');
{
  installClaude();
  const s = fakeSite();
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Bogus 9', modelFallback: 'Bogus 9' });
  assert(r.ok === false, 'identical fallback is not attempted twice; result hard-fails');
}

console.log('\ndriver: click that does not stick fails (never claims an unverified model):');
{
  installClaude();
  const s = fakeSite({ pickWorks: false });
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Haiku 4.5', modelFallback: 'Sonnet 5' });
  assert(r.ok === false && r.verified.model?.ok === false, 'a non-sticking pick is unverified, and unverified is NOT model_unavailable (no fallback)');
  assert(r.verified.model?.code === 'unverified', 'typed unverified code, not model_unavailable');
}

// --- substring-collision guard (review finding [1]) -------------------------
console.log('\ndriver: exact match wins over a superstring label (High vs Extra High):');
{
  installClaude();
  // 'Extra High' appears FIRST in DOM order; an unanchored includes() would
  // grab it for a request of 'High'. Exact match must win.
  const s = fakeSite({ models: ['Extra High', 'High'], current: 'Medium' });
  const r = await getDriver('claude').ensureChat(s.page, { model: 'High' });
  assert(s.state.current === 'High', 'requesting "High" selects "High", NOT the superstring "Extra High"');
  assert(r.verified.model?.ok === true, 'the exact model verified');
}

console.log('\ndriver: an ambiguous name (matches multiple) is refused, not silently picked:');
{
  installClaude();
  // 'Pro' anchored-matches both 'Pro Standard' and 'Pro Extended' — a raw
  // includes()+startsWith would silently click the first and mis-verify it.
  const s = fakeSite({ models: ['Pro Standard', 'Pro Extended', 'Medium'], current: 'Medium' });
  const r = await getDriver('claude').ensureChat(s.page, { model: 'Pro', modelFallback: 'Medium' });
  assert(r.warnings.some((w) => w.code === 'model_unavailable'), 'ambiguous "Pro" → model_unavailable (refused, not guessed)');
  assert(s.state.current === 'Medium', 'fell back to the unambiguous default "Medium"');

  const s2 = fakeSite({ models: ['Pro Standard', 'Pro Extended'], current: 'keep' });
  const r2 = await getDriver('claude').ensureChat(s2.page, { model: 'Pro' });
  assert(r2.ok === false && r2.verified.model?.code === 'model_unavailable', 'ambiguous name without fallback hard-fails');
  assert(s2.state.current === 'keep', 'no model was silently selected for the ambiguous request');
}

// --- selectModelsForRun wiring ----------------------------------------------
console.log('\nselectModelsForRun: pins the resolved model per provider:');
{
  registry._rebuildForTest({
    claude: { selectors: SEL, models: CLAUDE_MODELS },
    chatgpt: { selectors: SEL, models: { choices: ['Instant', 'Medium', 'High'], default: 'Medium', cheapest: 'Instant' } },
  });
  const cSite = fakeSite({ models: ['Haiku 4.5', 'Sonnet 5', 'Opus 4.8'], current: 'Opus 4.8' });
  const gSite = fakeSite({ models: ['Instant', 'Medium', 'High'], current: 'High' });
  const bs = { getPage: (m) => ({ claude: cSite.page, chatgpt: gSite.page }[m]), getActiveModels: () => ['claude', 'chatgpt'], isConnected: () => true };
  const sel = await selectModelsForRun(bs, ['claude', 'chatgpt'], { policy: 'cheapest' });
  assert(sel.claude.ok && cSite.state.current === 'Haiku 4.5', 'claude pinned to cheapest');
  assert(sel.chatgpt.ok && gSite.state.current === 'Instant', 'chatgpt pinned to cheapest');
  assert(sel.claude.requested === 'Haiku 4.5' && sel.chatgpt.requested === 'Instant', 'requested reflects the resolved cheapest names');
}

console.log('\nselectModelsForRun: explicit per-provider model + model_unavailable surface:');
{
  installClaude();
  const okSite = fakeSite({ current: 'Opus 4.8' });
  const bs = { getPage: () => okSite.page, getActiveModels: () => ['claude'], isConnected: () => true };
  const sel = await selectModelsForRun(bs, ['claude'], { models: { claude: 'Opus 4.8' } });
  assert(sel.claude.ok && okSite.state.current === 'Opus 4.8', 'explicit models map is honored');

  const bogusSite = fakeSite({ current: 'Opus 4.8' });
  const bs2 = { getPage: () => bogusSite.page, getActiveModels: () => ['claude'], isConnected: () => true };
  const sel2 = await selectModelsForRun(bs2, ['claude'], { models: { claude: 'Nonexistent' } });
  assert(sel2.claude.ok === true && sel2.claude.warning && bogusSite.state.current === 'Sonnet 5',
    'selectModelsForRun surfaces model_unavailable and lands on the default');
}

console.log('\nselectModelsForRun: a missing tab is recorded, never throws:');
{
  installClaude();
  const bs = { getPage: () => null, getActiveModels: () => ['claude'], isConnected: () => true };
  const sel = await selectModelsForRun(bs, ['claude'], { policy: 'cheapest' });
  assert(sel.claude.ok === false && /tab not found/.test(sel.claude.evidence), 'missing tab is non-fatal evidence, not a throw');
}

// --- per-provider message counts --------------------------------------------
console.log('\nper-provider message counts (cost visibility):');
{
  const counts = perProviderSends([
    { outputs: { claude: 'a', chatgpt: 'b' }, errors: {} },
    { outputs: { claude: 'a' }, errors: { chatgpt: { message: 'x', phase: 'wait' } } },
  ]);
  assert(counts.claude === 2 && counts.chatgpt === 2, 'counts a model in every round it was attempted (outputs OR errors)');
  assert(Object.keys(perProviderSends([])).length === 0, 'no rounds → empty count');
}

// --- calibration reads the live picker --------------------------------------
console.log('\ncalibrateModels reads every offered label + feeds drift:');
{
  installClaude();
  const s = fakeSite({ models: ['Haiku 4.5', 'Sonnet 5', 'Opus 4.8', 'Fable 7'] });
  const cal = await calibrateModels(s.page, registry.getProvider('claude'));
  assert(cal.ok && cal.choices.length === 4 && cal.choices.includes('Fable 7'), 'calibrate enumerates the live picker items');
  assert(s.state.pickerOpen === false, 'calibrate closes the picker afterward (Escape)');
  const drift = registry.modelDriftReport('claude', cal.choices);
  assert(drift.drifted === true && drift.added.includes('Fable 7') && drift.cheapestPresent, 'calibration snapshot drives the drift report');
}

registry._rebuildForTest(null);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
