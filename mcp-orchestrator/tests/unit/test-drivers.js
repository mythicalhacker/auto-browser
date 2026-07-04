import './_hermetic-env.js'; // pins REGISTRY_FILE before product imports
/**
 * Driver Tests — PR-9 ensureChat contract.
 * Every step verifies UI state after acting: project chats verify the
 * in-project header, model selection verifies the picker label, research
 * verifies the active indicator. project_not_found is a TYPED WARNING with a
 * normal-chat fallback (ok stays true); failed verification is ok:false with
 * evidence — never an unverified success, never a throw for feature failures.
 */
import { join } from 'path';
import { tmpdir } from 'os';

process.env.STATE_FILE = join(tmpdir(), `drivers-test-state-${process.pid}.json`);

const registry = await import('../../models/registry.js');
const { getDriver } = await import('../../models/drivers/index.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

// Test selectors installed into the registry for the fake site below.
const TEST_SELECTORS = {
  input: ['#composer'],
  submit: ['#send'],
  output: ['.answer'],
  streaming: ['.streaming'],
  modelPicker: ['#picker'],
  modelPickerItem: ['[role="option"]'],
  modelPickerLabel: ['#picker-label'],
  researchToggle: [],
  researchMenu: { opener: ['#tools-open'], item: ['.tool-item'], matchText: 'Deep research', closeBy: 'escape' },
  researchActiveIndicator: ['#research-on'],
  projectNav: {
    listUrl: 'https://claude.ai/projects',
    projectCard: ['.project-card'],
    newChatInProject: ['#project-new-chat'],
    projectHeader: ['#project-header'],
  },
};

registry._rebuildForTest({
  claude: { selectors: TEST_SELECTORS },
  gemini: { selectors: TEST_SELECTORS, capabilities: { projects: false } },
});

/** Stateful fake provider site addressed by the TEST_SELECTORS above. */
function fakeSite({
  projects = [],
  models = ['Fable 5 Max', 'Opus 4.8'],
  current = 'Opus 4.8',
  labelMap = {},
  pickWorks = true,
  researchWorks = true,
  draft = '',
  escapeImmuneTools = false,
} = {}) {
  const state = {
    view: 'chat', url: 'https://claude.ai/new', pickerOpen: false, toolsOpen: false,
    effortOpen: false, effort: null, research: false, project: null, current, draft,
    selectAll: false,
  };
  const el = (text, { onClick } = {}) => ({
    innerText: async () => (typeof text === 'function' ? text() : text),
    click: async () => onClick?.(),
    getAttribute: async () => null,
    evaluate: async () => Math.random().toString(36),
    isVisible: async () => true,
  });
  const label = () => {
    const base = labelMap[state.current] ?? state.current;
    return state.effort ? `${base} ${state.effort}` : base;
  };
  const page = {
    url: () => state.url,
    goto: async (u) => {
      state.url = u;
      state.view = u.includes('/projects') ? 'projects' : 'chat';
      state.pickerOpen = false;
    },
    waitForTimeout: async () => {},
    keyboard: {
      // Key-aware: ONLY Escape closes menus (a broken driver pressing the
      // wrong key must not pass); select-all + Backspace clears the composer
      // draft and any pill, like real editors.
      press: async (k) => {
        if (k === 'Escape') {
          state.pickerOpen = false;
          state.effortOpen = false;
          if (!escapeImmuneTools) state.toolsOpen = false;
        }
        if (k === 'ControlOrMeta+a') state.selectAll = true;
        if (k === 'Backspace' && state.selectAll) {
          state.draft = '';
          state.research = false;
          state.selectAll = false;
        }
      },
      insertText: async (t) => { state.draft += t; },
    },
    $$: async (s) => {
      switch (s) {
        case '#composer':
          return state.view === 'projects' ? [] : [el(() => state.draft)];
        case '#picker':
          return [el(label, { onClick: () => { state.pickerOpen = true; } })];
        case '#picker-label':
          return [el(label)];
        case '[role="option"]':
          return state.pickerOpen
            ? models.map((m) => el(m, { onClick: () => { if (pickWorks) state.current = m; state.pickerOpen = false; } }))
            : [];
        case '[data-testid="effort-menu-trigger"]':
          return state.pickerOpen ? [el('Effort', { onClick: () => { state.effortOpen = true; } })] : [];
        case '[data-testid^="effort-option-"]':
          return state.effortOpen
            ? ['Low', 'Medium', 'High', 'Max'].map((lvl) => el(lvl, {
              onClick: () => { state.effort = lvl; state.effortOpen = false; },
            }))
            : [];
        case '#tools-open':
          return state.view === 'projects'
            ? []
            : [el('Tools', { onClick: () => { state.toolsOpen = !state.toolsOpen; } })];
        case '.tool-item':
          return state.toolsOpen
            ? [
              el('Web search', { onClick: () => {} }),
              el('Deep research', { onClick: () => { if (researchWorks) state.research = true; } }),
            ]
            : [];
        case '#research':
          return state.view === 'projects' ? [] : [el('Research', { onClick: () => { if (researchWorks) state.research = true; } })];
        case '#research-on':
          return state.research ? [el('Research active')] : [];
        case '.project-card':
          return state.view === 'projects'
            ? projects.map((p) => el(p, {
              onClick: () => {
                state.view = 'projectChat';
                state.project = p;
                state.url = `https://claude.ai/project/${p.toLowerCase().replace(/\s+/g, '-')}`;
              },
            }))
            : [];
        case '#project-new-chat':
          return state.view === 'projectChat' ? [el('New chat', { onClick: () => {} })] : [];
        case '#project-header':
          return state.view === 'projectChat' ? [el(() => state.project)] : [];
        default:
          return [];
      }
    },
    $: async (s) => (await page.$$(s))[0] ?? null,
  };
  return { page, state };
}

console.log('Driver Tests (PR-9)\n');

console.log('project chat (found):');
{
  const site = fakeSite({ projects: ['Code Mastery', 'Other Things'] });
  const r = await getDriver('claude').ensureChat(site.page, { project: 'code mastery' });
  assert(r.ok === true, 'result ok');
  assert(r.warnings.length === 0, 'no warnings');
  assert(r.verified.project?.ok === true, 'in-project state verified (header match)');
  assert(site.state.project === 'Code Mastery', 'the right project was opened (case-insensitive)');
  assert(r.steps.some((s) => s.action.includes('verify chat is inside the project') && s.ok),
    'verification step recorded with evidence');
}

console.log('\nproject chat (missing → typed warning + normal chat):');
{
  const site = fakeSite({ projects: ['Other Things'] });
  const r = await getDriver('claude').ensureChat(site.page, { project: 'code mastery' });
  assert(r.ok === true, 'fallback is NOT a failure');
  assert(r.warnings.some((w) => w.code === 'project_not_found'), 'typed project_not_found warning');
  assert(r.verified.project?.ok === false, 'project verification reports the fallback');
  assert(site.state.view === 'chat' && site.state.url === 'https://claude.ai/new',
    'normal fresh chat opened instead');
  assert(r.steps.some((s) => s.action.includes('find project') && s.evidence.toLowerCase().includes('other things')),
    'evidence lists what WAS on the projects page');
}

console.log('\nproject chat (provider without projects):');
{
  const site = fakeSite({});
  const r = await getDriver('gemini').ensureChat(site.page, { project: 'code mastery' });
  assert(r.warnings.some((w) => w.code === 'project_not_found' && w.detail.includes('no project support')),
    'gemini: typed warning names the capability gap');
  assert(r.ok === true && site.state.view === 'chat', 'normal chat fallback');
}

console.log('\nmodel selection (verified):');
{
  const site = fakeSite({});
  const r = await getDriver('claude').ensureChat(site.page, { model: 'Fable 5' });
  assert(r.ok === true, 'result ok');
  assert(r.verified.model?.ok === true, 'model verified via picker label');
  assert(site.state.current === 'Fable 5 Max', 'model actually switched');
  assert(r.verified.model.evidence.toLowerCase().includes('fable 5'), 'evidence carries the label text');
}

console.log('\nmodel selection (click does not stick → verification fails):');
{
  const site = fakeSite({ pickWorks: false });
  const r = await getDriver('claude').ensureChat(site.page, { model: 'Fable 5' });
  assert(r.ok === false, 'unverified model selection FAILS the result');
  assert(r.verified.model?.ok === false, 'model verification reports failure');
  assert(r.steps.some((s) => s.action.includes('verify model label') && !s.ok),
    'failing verify step recorded');
}

console.log('\nmodel selection (model not offered):');
{
  const site = fakeSite({ models: ['Opus 4.8'] });
  const r = await getDriver('claude').ensureChat(site.page, { model: 'Fable 5' });
  assert(r.ok === false && r.verified.model?.ok === false, 'missing menu item fails loudly');
  assert(r.steps.some((s) => s.action.includes('pick model') && s.evidence.toLowerCase().includes('opus 4.8')),
    'evidence lists the models that WERE offered');
}

console.log('\nresearch mode (menu flow):');
{
  const site = fakeSite({});
  const r = await getDriver('claude').ensureChat(site.page, { research: true });
  assert(r.ok === true && r.verified.research?.ok === true, 'research enabled and verified via indicator');
  assert(site.state.research === true, 'menu item actually fired');
  assert(r.steps.some((s) => s.action === 'open tools menu' && s.ok)
    && r.steps.some((s) => s.action.includes('Deep research') && s.ok),
    'menu flow recorded: opener then item-by-text');

  const dead = fakeSite({ researchWorks: false });
  const r2 = await getDriver('claude').ensureChat(dead.page, { research: true });
  assert(r2.ok === false && r2.verified.research?.ok === false,
    'research click without the active indicator fails verification');

  // Idempotence: indicator present → no second activation attempt (ChatGPT's
  // pill inserter would otherwise double-insert).
  const again = fakeSite({});
  again.state.research = true;
  const r3 = await getDriver('claude').ensureChat(again.page, { research: true });
  assert(r3.verified.research?.ok === true
    && !r3.steps.some((s) => s.action === 'open tools menu'),
    'already-active research short-circuits before any click');
}

console.log('\nresearch mode (direct toggle, no menu):');
{
  registry._rebuildForTest({
    claude: { selectors: TEST_SELECTORS },
    plainai: {
      displayName: 'PlainAI', urlPattern: 'plainai.example', entryUrl: 'https://plainai.example',
      selectors: {
        input: ['#composer'], submit: ['#send'], output: ['.answer'], streaming: ['.streaming'],
        researchToggle: ['#research'], researchActiveIndicator: ['#research-on'],
      },
      quotas: { sends: { maxPerWindow: 5, windowMs: 60000, name: '1 min' } },
    },
  });
  const site = fakeSite({});
  const r = await getDriver('plainai').ensureChat(site.page, { research: true });
  assert(r.verified.research?.ok === true && site.state.research === true,
    'providers without a researchMenu fall back to the direct toggle');
  registry._rebuildForTest({
    claude: { selectors: TEST_SELECTORS },
    gemini: { selectors: TEST_SELECTORS, capabilities: { projects: false } },
  });
}

console.log('\nmode toggles:');
{
  const site = fakeSite({});
  const r = await getDriver('claude').ensureChat(site.page, { modes: { extendedThinking: true } });
  assert(r.ok === false && r.verified['mode:extendedThinking']?.ok === false
    && r.steps.some((s) => s.action.includes('extendedThinking') && s.evidence.includes('no toggle selectors')),
    'unknown/unpopulated mode toggle fails with typed evidence (not silently skipped)');
}

console.log('\ndriver lookup:');
{
  registry._rebuildForTest({
    claude: { selectors: TEST_SELECTORS },
    fakeai: {
      displayName: 'FakeAI', urlPattern: 'fakeai.example', entryUrl: 'https://fakeai.example',
      selectors: { input: ['#composer'], submit: ['#send'], output: ['.answer'], streaming: ['.streaming'] },
      quotas: { sends: { maxPerWindow: 5, windowMs: 60000, name: '1 min' } },
    },
  });
  assert(getDriver('claude') && getDriver('claude').name === 'claude', 'built-in driver resolves');
  const fake = getDriver('fakeai');
  assert(fake && fake.name === 'fakeai', 'registry-only provider gets the generic driver');
  assert(getDriver('nonexistent') === null, 'unknown provider yields null');
  const site = fakeSite({});
  site.state.url = 'https://fakeai.example';
  const r = await fake.ensureChat(site.page, {});
  assert(r.ok === true && r.steps.some((s) => s.action === 'verify composer present' && s.ok),
    'generic driver opens and verifies a fresh chat from descriptor data alone');
}

console.log('\nlabel matching is boundary-anchored (review finding):');
{
  // Current label 'Flash' must NOT verify a request for '3.1 Flash-Lite'
  // (raw bidirectional containment did) — the click doesn't stick here.
  const site = fakeSite({ models: ['3.1 Flash-Lite'], current: 'Flash', pickWorks: false });
  const r = await getDriver('claude').ensureChat(site.page, { model: '3.1 Flash-Lite' });
  assert(r.verified.model?.ok === false,
    'short label "Flash" does NOT satisfy "3.1 Flash-Lite"');

  // The legitimate short-label shape still verifies: picking '3.1 Pro'
  // updates a label that displays only 'Pro'.
  const site2 = fakeSite({ models: ['3.1 Pro'], current: 'Flash', labelMap: { '3.1 Pro': 'Pro' } });
  const r2 = await getDriver('claude').ensureChat(site2.page, { model: '3.1 Pro' });
  assert(r2.verified.model?.ok === true && site2.state.current === '3.1 Pro',
    'trailing short label "Pro" verifies "3.1 Pro"');
}

console.log('\nambiguous project names are refused:');
{
  const site = fakeSite({ projects: ['Auto Code', 'Auto Engineer'] });
  const r = await getDriver('claude').ensureChat(site.page, { project: 'Auto' });
  assert(r.warnings.some((w) => w.code === 'project_not_found')
    && r.steps.some((s) => s.evidence.includes('ambiguous')),
    '"Auto" matching two projects is refused with ambiguous evidence');
  assert(site.state.project === null, 'neither similar project was opened');

  const site2 = fakeSite({ projects: ['Auto Code', 'Auto Engineer'] });
  const r2 = await getDriver('claude').ensureChat(site2.page, { project: 'Auto Code' });
  assert(r2.verified.project?.ok === true && site2.state.project === 'Auto Code',
    'exact name among similar projects opens the right one');
}

console.log('\npersisted drafts are cleared (fresh means EMPTY):');
{
  const site = fakeSite({ draft: 'stale draft text from last session' });
  const r = await getDriver('claude').ensureChat(site.page, {});
  assert(r.ok === true && site.state.draft === '',
    'stale composer text cleared before declaring the chat fresh');
  assert(r.steps.some((s) => s.action.includes('clear persisted draft') && s.ok),
    'clear step recorded with evidence');

  // A stale research pill without a research request is also stale state.
  const site2 = fakeSite({});
  site2.state.research = true;
  const r2 = await getDriver('claude').ensureChat(site2.page, {});
  assert(r2.ok === true && site2.state.research === false,
    'stale research pill cleared when research was NOT requested');

  // But with research requested, the pill is kept and reused idempotently.
  const site3 = fakeSite({});
  site3.state.research = true;
  const r3 = await getDriver('claude').ensureChat(site3.page, { research: true });
  assert(r3.verified.research?.ok === true && site3.state.research === true
    && !r3.steps.some((s) => s.action === 'open tools menu'),
    'requested research reuses the existing pill without re-activating');
}

console.log('\ncloseBy "reopen" (Escape-immune panel):');
{
  registry._rebuildForTest({
    claude: {
      selectors: {
        ...TEST_SELECTORS,
        researchMenu: { opener: ['#tools-open'], item: ['.tool-item'], matchText: 'Deep research', closeBy: 'reopen' },
      },
    },
  });
  const site = fakeSite({ escapeImmuneTools: true });
  const r = await getDriver('claude').ensureChat(site.page, { research: true });
  assert(r.verified.research?.ok === true && site.state.research === true, 'research enabled through the panel');
  assert(site.state.toolsOpen === false, 'Escape-immune panel closed by re-clicking the opener');
  registry._rebuildForTest({
    claude: { selectors: TEST_SELECTORS },
    gemini: { selectors: TEST_SELECTORS, capabilities: { projects: false } },
  });
}

console.log('\nclaude effort quirk (level inside the model picker):');
{
  const site = fakeSite({});
  const r = await getDriver('claude').ensureChat(site.page, { modes: { effort: 'max' } });
  assert(r.verified['mode:effort']?.ok === true && site.state.effort === 'Max',
    'effort level picked through picker → trigger → option and verified via the label badge');
  assert(r.steps.some((s) => s.action.includes('verify effort badge') && s.ok
    && s.evidence.includes('max')), 'verification evidence carries the badge text');

  const dead = fakeSite({});
  dead.state.current = 'Opus 4.8';
  const r2 = await getDriver('claude').ensureChat(dead.page, { modes: { effort: 'ultra' } });
  assert(r2.ok === false && r2.verified['mode:effort']?.ok === false,
    'unknown effort level fails loudly with the offered options in evidence');
}

console.log('\ngemini extendedThinking quirk (two-level picker menu):');
{
  registry._rebuildForTest({ claude: { selectors: TEST_SELECTORS } }); // gemini = real defaults
  const state = { pickerOpen: false, thinkingOpen: false, level: 'Standard', url: 'https://gemini.google.com/app' };
  const el = (text, { onClick } = {}) => ({
    innerText: async () => (typeof text === 'function' ? text() : text),
    click: async () => onClick?.(),
    getAttribute: async () => null,
    evaluate: async () => Math.random().toString(36),
    isVisible: async () => true,
  });
  const page = {
    url: () => state.url,
    goto: async (u) => { state.url = u; state.pickerOpen = false; },
    waitForTimeout: async () => {},
    keyboard: {
      press: async (k) => { if (k === 'Escape') { state.pickerOpen = false; state.thinkingOpen = false; } },
      insertText: async () => {},
    },
    $$: async (s) => {
      switch (s) {
        case 'div[contenteditable="true"].ql-editor':
          return [el('')];
        case 'button[data-test-id="bard-mode-menu-button"]':
          return [el('Pro', { onClick: () => { state.pickerOpen = true; } })];
        case 'gem-menu-item[value="thinking_level"]':
          return state.pickerOpen ? [el('Thinking level', { onClick: () => { state.thinkingOpen = true; } })] : [];
        case 'gem-menu-item[value="thinking_level"] .sublabel':
          return state.pickerOpen ? [el(() => state.level)] : [];
        case 'gem-menu[id^="ng-menu"] gem-menu-item[role="menuitem"]':
          return state.thinkingOpen
            ? [
              el('Standard Best for most questions', { onClick: () => { state.level = 'Standard'; } }),
              el('Extended Complex problem solving', { onClick: () => { state.level = 'Extended'; state.thinkingOpen = false; } }),
            ]
            : [];
        default:
          return [];
      }
    },
    $: async (s) => (await page.$$(s))[0] ?? null,
  };
  const r = await getDriver('gemini').ensureChat(page, { modes: { extendedThinking: true } });
  assert(r.verified['mode:extendedThinking']?.ok === true && state.level === 'Extended',
    'thinking level set to Extended through the two-level menu and verified via sublabel');
  assert(state.pickerOpen === false && state.thinkingOpen === false, 'both menus closed afterwards');
}

registry._rebuildForTest(null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
