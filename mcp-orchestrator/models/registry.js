// models/registry.js — single source of truth for provider descriptors.
//
// Every provider-specific fact (URL pattern, entry URL, selector chains,
// login markers, capabilities, timeouts, quotas) lives here. Adding a
// provider = adding one descriptor (in code, or via the override file).
//
// Overrides: ~/.auto-browser/registry.json (or REGISTRY_FILE env) is
// deep-merged over the defaults at load time. Objects merge recursively,
// arrays and scalars REPLACE (a selector-chain override is the whole chain).
// New providers may be added via override if their descriptor is complete.
// Invalid overrides are rejected loudly: loading throws with every problem
// listed — a server running on silently-broken selectors is worse than one
// that refuses to boot.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const OVERRIDE_FILE =
  process.env.REGISTRY_FILE || join(homedir(), '.auto-browser', 'registry.json');

// URL fragments that indicate a login/auth page (shared default; a provider
// override can replace its own list).
const COMMON_LOGIN_URL_PATTERNS = Object.freeze([
  '/login', '/signin', '/sign-in', '/auth', '/oauth',
  'accounts.google.com',
]);

const DEFAULTS = {
  claude: {
    name: 'claude',
    displayName: 'Claude',
    urlPattern: 'claude.ai',
    entryUrl: 'https://claude.ai',
    newChatUrl: 'https://claude.ai/new',
    // Tab-discovery policy: prefer real chat tabs; excluded paths (the
    // claude.ai/chrome/* extension pages) are never model tabs.
    preferPathPatterns: ['/chat/'],
    excludePathPatterns: ['/chrome/'],
    selectors: {
      input: ['.ProseMirror', 'div[contenteditable="true"]'],
      submit: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label="Send"]'],
      output: ['.font-claude-response .standard-markdown'],
      streaming: ['[data-is-streaming="true"]'],
      // Live-discovered 2026-07-04 (Base-UI 'cds' components; generated ids
      // like base-ui-_r_* are unstable — attribute selectors only).
      modelPicker: ['[data-testid="model-selector-dropdown"]', 'button[aria-label^="Model:"]'],
      modelPickerItem: ['[role="menu"] [role="menuitemradio"]', '[data-cds="Menu"] [role="menuitemradio"]'],
      modelPickerLabel: ['[data-testid="model-selector-dropdown"]', 'button[aria-label^="Model:"]'],
      modeToggles: {
        effort: ['[data-testid="effort-menu-trigger"]'],
        effortActiveHint: 'Inside the model picker; options [data-testid^="effort-option-"] '
          + '(low/medium/high/xhigh/max), current has aria-checked=true; also shows as the '
          + 'trailing badge in the model-selector button text.',
        // webSearch is documented as a HINT only: its checkbox lives inside
        // the plus menu and the row selector alone is text-blind (it would
        // click whatever checkbox comes first) — no direct-toggle array.
        webSearchHint: 'Row in the plus menu (button[aria-label="Add files, connectors, and more"]), '
          + 'match innerText "Web search"; ON = aria-checked=true. No always-visible indicator outside the menu.',
        extendedThinkingActiveHint: 'NOT PRESENT in the July 2026 UI — thinking is built in; '
          + 'the Effort submenu is the closest user control.',
      },
      researchToggle: ['button[aria-label="Research mode"]'],
      researchMenu: {
        opener: ['button[aria-label="Add files, connectors, and more"]'],
        item: ['[role="menu"] [role="menuitemcheckbox"]'],
        matchText: 'Research',
        closeBy: 'escape',
      },
      researchActiveIndicator: ['button[aria-label="Research mode"][aria-pressed="true"]'],
      projectNav: {
        listUrl: 'https://claude.ai/projects',
        projectCard: ['a[href^="/project/"]', 'a[href*="/project/"]'],
        newChatInProject: ['[data-testid="chat-input"]', 'div[aria-label="Write your prompt to Claude"]'],
        projectHeader: ['[data-testid="page-header"] a[href*="/project/"]'],
        inProjectUrlFragment: '/project/',
      },
      quotaBanner: ['div[role="status"] span.text-body', 'div[role="status"]'],
      userMessage: ['[data-testid="user-message"]'],
    },
    loginUrlPatterns: [...COMMON_LOGIN_URL_PATTERNS],
    capabilities: {
      deepResearch: true,
      projects: true,
      modelChoices: ['Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5'],
    },
    timeouts: { response: 300000 },
    quotas: {
      sends: { maxPerWindow: 900, windowMs: 5 * 60 * 60 * 1000, name: '5 hours' },
    },
  },
  chatgpt: {
    name: 'chatgpt',
    displayName: 'ChatGPT',
    urlPattern: 'chatgpt.com',
    entryUrl: 'https://chatgpt.com',
    newChatUrl: 'https://chatgpt.com/',
    preferPathPatterns: [],
    excludePathPatterns: [],
    selectors: {
      input: ['#prompt-textarea', 'textarea[name="prompt-textarea"]', 'div[contenteditable="true"]'],
      submit: ['button[aria-label="Send prompt"]', 'button[data-testid="send-button"]', 'button[data-testid="composer-send-button"]'],
      output: ['[data-message-author-role="assistant"] .markdown', '[data-message-author-role="assistant"]'],
      streaming: ['button[aria-label="Stop streaming"]', 'button[data-testid="stop-button"]'],
      // Live-discovered 2026-07-04. The picker is the composer pill (no
      // header switcher); menu items render with newlines ('Pro\nExtended')
      // so matching must whitespace-normalize.
      modelPicker: ['form[data-type="unified-composer"] button.__composer-pill[aria-haspopup="menu"]', 'button.__composer-pill[aria-haspopup="menu"]'],
      modelPickerItem: ['[data-testid="composer-intelligence-picker-content"] [role="menuitemradio"]', '[role="menu"][data-state="open"] [role="menuitemradio"]'],
      modelPickerLabel: ['form[data-type="unified-composer"] button.__composer-pill[aria-haspopup="menu"]', 'button.__composer-pill[aria-haspopup="menu"]'],
      modeToggles: {
        proEffort: ['[data-testid="composer-intelligence-pro-thinking-effort-trigger"]'],
        proEffortActiveHint: 'Hover the checked Pro row inside the intelligence picker, then CLICK '
          + 'the trigger; submenu is a second [role="menu"][data-state="open"] with Pro Standard / '
          + 'Pro Extended menuitemradio (aria-checked marks current).',
        temporaryChat: ['#page-header button[aria-label="Turn on temporary chat"]'],
      },
      // Deep research is a PILL INSERTER, not a toggle: clicking the row again
      // adds a second pill — always check researchActiveIndicator first. The
      // plus panel ignores Escape; close by re-clicking the opener.
      researchToggle: [],
      researchMenu: {
        opener: ['[data-testid="composer-plus-btn"]'],
        item: ['div.popover div.__menu-item'],
        matchText: 'Deep research',
        closeBy: 'reopen',
      },
      researchActiveIndicator: [
        '#prompt-textarea [data-inline-selection-pill][data-id="connector:connector_openai_deep_research"]',
        '#prompt-textarea [data-inline-selection-pill][data-keyword="Deep research"]',
      ],
      projectNav: {
        listUrl: 'https://chatgpt.com/projects',
        projectCard: ['main div[role="row"][data-page-table-selectable-row="true"]', '[class*="project-unfurl-row"] div[data-sidebar-item="true"][role="button"]'],
        newChatInProject: ['#prompt-textarea', 'form[data-type="unified-composer"] div[contenteditable="true"]'],
        projectHeader: ['#page-header a[href$="/project"]', '[data-testid="project-modal-trigger"]'],
        inProjectUrlFragment: '/g/g-p-',
      },
      quotaBanner: ['[data-testid*="limit"]', '[data-testid*="banner"]'],
      userMessage: ['[data-message-author-role="user"]'],
    },
    loginUrlPatterns: [...COMMON_LOGIN_URL_PATTERNS],
    capabilities: {
      deepResearch: true,
      projects: true,
      modelChoices: ['Instant', 'Medium', 'High', 'Extra High', 'Pro Standard', 'Pro Extended', 'GPT-5.5', 'GPT-5.4', 'GPT-5.3', 'o3'],
      // Thinking-mode workaround: response DOM empties after streaming; a
      // reload forces React to re-render from server state.
      reloadOnEmptyOutput: true,
    },
    timeouts: { response: 600000 },
    quotas: {
      // maxPerWindow Infinity (null in JSON) = never warn/throttle, but keep
      // a real window so health_check reports actual send counts.
      sends: { maxPerWindow: Infinity, windowMs: 24 * 60 * 60 * 1000, name: '24 hours' },
    },
  },
  gemini: {
    name: 'gemini',
    displayName: 'Gemini',
    urlPattern: 'gemini.google.com',
    entryUrl: 'https://gemini.google.com',
    newChatUrl: null,
    preferPathPatterns: [],
    excludePathPatterns: [],
    selectors: {
      input: ['div[contenteditable="true"].ql-editor', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
      submit: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label="Submit"]'],
      output: ['.model-response-text .markdown-main-panel', 'message-content .markdown', '.response-content'],
      streaming: ['button[aria-label="Stop response"]', 'button[aria-label="Stop"]'],
      // Live-discovered 2026-07-04 ('luminous' UI). Picker is the mode pill
      // on the RIGHT inside the composer; menu ids are per-session
      // (ng-menu-*), bard-mode-option testid hashes are opaque — match model
      // names by innerText. The label pill shows the SHORT name ('Pro').
      modelPicker: ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label^="Open mode picker"]'],
      modelPickerItem: ['gem-menu-item[data-test-id^="bard-mode-option-"]', 'gem-menu[id^="ng-menu"] gem-menu-item[role="menuitem"]'],
      modelPickerLabel: ['bard-mode-switcher .picker-primary-text', 'button[data-test-id="bard-mode-menu-button"] .picker-primary-text'],
      modeToggles: {
        // Thinking level lives INSIDE the model picker; the gemini driver
        // carries the two-level flow as a quirk.
        extendedThinking: ['gem-menu-item[value="thinking_level"]'],
        extendedThinkingActiveHint: 'Open the model picker first; current level readable from '
          + 'gem-menu-item[value="thinking_level"] .sublabel (Standard/Extended); clicking opens a '
          + 'second gem-menu — match items by innerText, active carries class "selected". Escape twice.',
      },
      researchToggle: [],
      researchMenu: {
        opener: ['button[aria-label="Upload and tools"]'],
        item: ['button.toolbox-drawer-item-list-button[role="menuitemcheckbox"]', '.cdk-overlay-container button[role="menuitemcheckbox"]'],
        matchText: 'Deep Research',
        closeBy: 'escape',
      },
      researchActiveIndicator: [
        '[data-test-id="deselect-drawer-item-gem-button"]',
        'button[aria-label="Deselect Deep Research"]',
      ],
      // "Projects" on Gemini = Notebooks (sidebar entries on /app).
      projectNav: {
        listUrl: 'https://gemini.google.com/app',
        projectCard: ['[data-test-id="project-item-button-gem"]', 'a[href^="/notebook/"]'],
        newChatInProject: ['rich-textarea .ql-editor', '.ql-editor'],
        projectHeader: ['h1[data-test-id="edu-notebook-project-name"]'],
        inProjectUrlFragment: '/notebook/',
      },
      quotaBanner: ['gemini-quota-banner', '.upgrade-to-continue', '[data-test-id="announcement-banner-container"]'],
      userMessage: ['user-query', '.query-text'],
    },
    loginUrlPatterns: [...COMMON_LOGIN_URL_PATTERNS],
    capabilities: {
      deepResearch: true,
      projects: true, // notebooks
      modelChoices: ['3.1 Flash-Lite', '3.5 Flash', '3.1 Pro'],
    },
    timeouts: { response: 300000 },
    quotas: {
      sends: { maxPerWindow: 100, windowMs: 24 * 60 * 60 * 1000, name: '24 hours' },
    },
  },
};

// ---------------------------------------------------------------------------
// Validation

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Provider keys feed TIMEOUT_RESPONSE_<KEY.toUpperCase()> env names and the
// '=== KEY ===' consensus section headers: lowercase alphanumeric only, so
// every derived env var is shell-settable and no two keys collide case-wise.
const PROVIDER_KEY_RE = /^[a-z][a-z0-9_]*$/;

// Keys that would hit Object.prototype setters when copied with computed
// assignment — an override containing them anywhere is rejected loudly.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function findDangerousKeys(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findDangerousKeys(v, `${path}[${i}]`, problems));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      problems.push(`override key "${path}.${key}" is not allowed (prototype-pollution guard)`);
      continue;
    }
    findDangerousKeys(value[key], `${path}.${key}`, problems);
  }
}

/** Collect every problem with a (merged) provider descriptor. */
function validateProvider(name, d, problems) {
  const p = (msg) => problems.push(`provider "${name}": ${msg}`);
  if (!d || typeof d !== 'object' || Array.isArray(d)) { p('descriptor must be an object'); return; }
  if (d.name !== name) p(`"name" (${JSON.stringify(d.name)}) must match its key`);
  if (typeof d.displayName !== 'string' || !d.displayName) p('"displayName" must be a non-empty string');
  if (typeof d.urlPattern !== 'string' || !d.urlPattern) p('"urlPattern" must be a non-empty string');
  if (!isHttpUrl(d.entryUrl)) p('"entryUrl" must be an http(s) URL');
  if (!(d.newChatUrl === null || d.newChatUrl === undefined || isHttpUrl(d.newChatUrl))) {
    p('"newChatUrl" must be an http(s) URL or null');
  }
  for (const key of ['preferPathPatterns', 'excludePathPatterns', 'loginUrlPatterns']) {
    if (d[key] !== undefined && !isStringArray(d[key])) p(`"${key}" must be an array of strings`);
  }
  const sel = d.selectors;
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
    p('"selectors" must be an object');
  } else {
    for (const key of ['input', 'submit', 'output', 'streaming']) {
      if (!isStringArray(sel[key]) || sel[key].length === 0) p(`"selectors.${key}" must be a non-empty array of strings`);
    }
    for (const key of ['modelPicker', 'modelPickerItem', 'modelPickerLabel', 'researchToggle',
      'researchActiveIndicator', 'quotaBanner', 'userMessage']) {
      if (sel[key] !== undefined && !isStringArray(sel[key])) p(`"selectors.${key}" must be an array of strings`);
    }
    if (sel.modeToggles !== undefined) {
      if (!isPlainObject(sel.modeToggles)) p('"selectors.modeToggles" must be an object');
      else {
        for (const [k, v] of Object.entries(sel.modeToggles)) {
          if (!isStringArray(v) && typeof v !== 'string') {
            p(`"selectors.modeToggles.${k}" must be a selector array (or a hint string)`);
          }
        }
      }
    }
    if (sel.projectNav !== undefined) {
      if (!isPlainObject(sel.projectNav)) p('"selectors.projectNav" must be an object');
      else {
        if (sel.projectNav.listUrl !== undefined && !isHttpUrl(sel.projectNav.listUrl)) {
          p('"selectors.projectNav.listUrl" must be an http(s) URL');
        }
        if (sel.projectNav.inProjectUrlFragment !== undefined
          && (typeof sel.projectNav.inProjectUrlFragment !== 'string' || !sel.projectNav.inProjectUrlFragment)) {
          p('"selectors.projectNav.inProjectUrlFragment" must be a non-empty string');
        }
        for (const key of ['projectCard', 'newChatInProject', 'projectHeader']) {
          if (sel.projectNav[key] !== undefined && !isStringArray(sel.projectNav[key])) {
            p(`"selectors.projectNav.${key}" must be an array of strings`);
          }
        }
      }
    }
    if (sel.researchMenu !== undefined) {
      const rm = sel.researchMenu;
      if (!isPlainObject(rm)) p('"selectors.researchMenu" must be an object');
      else {
        for (const key of ['opener', 'item']) {
          if (!isStringArray(rm[key]) || rm[key].length === 0) {
            p(`"selectors.researchMenu.${key}" must be a non-empty array of strings`);
          }
        }
        if (typeof rm.matchText !== 'string' || !rm.matchText) p('"selectors.researchMenu.matchText" must be a non-empty string');
        if (rm.closeBy !== undefined && !['escape', 'reopen'].includes(rm.closeBy)) {
          p('"selectors.researchMenu.closeBy" must be "escape" or "reopen"');
        }
      }
    }
  }
  const cap = d.capabilities;
  if (cap !== undefined) {
    if (!isPlainObject(cap)) p('"capabilities" must be an object');
    else {
      for (const key of ['deepResearch', 'projects', 'reloadOnEmptyOutput']) {
        if (cap[key] !== undefined && typeof cap[key] !== 'boolean') p(`"capabilities.${key}" must be a boolean`);
      }
      if (cap.modelChoices !== undefined && !isStringArray(cap.modelChoices)) p('"capabilities.modelChoices" must be an array of strings');
    }
  }
  if (d.timeouts !== undefined) {
    if (!isPlainObject(d.timeouts)) p('"timeouts" must be an object');
    else if (d.timeouts.response !== undefined && !(Number.isFinite(d.timeouts.response) && d.timeouts.response > 0)) {
      p('"timeouts.response" must be a positive number (ms)');
    }
  }
  const q = d.quotas;
  if (!isPlainObject(q)) {
    p('"quotas" must be an object with a "sends" limit');
  } else {
    const s = q.sends;
    if (!isPlainObject(s)) {
      // Required: rate-limiter/health_check observability covers every
      // provider, so each descriptor must declare its send window.
      p('"quotas.sends" is required: {maxPerWindow, windowMs, name}');
    } else {
      if (!(s.maxPerWindow === Infinity || (Number.isFinite(s.maxPerWindow) && s.maxPerWindow > 0))) {
        p('"quotas.sends.maxPerWindow" must be a positive number or null (unlimited)');
      }
      if (!(Number.isFinite(s.windowMs) && s.windowMs > 0)) p('"quotas.sends.windowMs" must be a positive number (ms)');
      if (typeof s.name !== 'string' || !s.name) p('"quotas.sends.name" must be a non-empty string');
    }
    if (q.deepResearchPerDay !== undefined
      && !(Number.isFinite(q.deepResearchPerDay) && q.deepResearchPerDay >= 0)) {
      p('"quotas.deepResearchPerDay" must be a non-negative number');
    }
  }
}

// ---------------------------------------------------------------------------
// Merge + freeze

/** Recursive merge: objects merge, arrays/scalars replace. Returns a copy.
 * Null-prototype output + dangerous-key skip: computed assignment of a
 * "__proto__" key must never reach an Object.prototype setter (the loud
 * rejection happens in findDangerousKeys; this is defense in depth). */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? structuredClone(base) : structuredClone(override);
  }
  const out = Object.create(null);
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = key in override ? deepMerge(base[key], override[key]) : structuredClone(base[key]);
  }
  return out;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

/** Merge overrides over DEFAULTS, validate every descriptor, deep-freeze. */
function mergeAndValidate(overrides, sourceLabel) {
  const problems = [];
  findDangerousKeys(overrides, 'registry', problems);

  const merged = Object.create(null);
  for (const name of new Set([...Object.keys(DEFAULTS), ...Object.keys(overrides)])) {
    if (DANGEROUS_KEYS.has(name)) continue; // already reported above
    if (!PROVIDER_KEY_RE.test(name)) {
      problems.push(`provider key ${JSON.stringify(name)} must match ${PROVIDER_KEY_RE} `
        + '(it feeds TIMEOUT_RESPONSE_<KEY> env names and consensus section headers)');
      continue;
    }
    if (name in overrides && !isPlainObject(overrides[name])) {
      // A null/scalar override must not silently no-op back to defaults:
      // removing the entry keeps defaults; null does NOT disable a provider.
      problems.push(`provider "${name}" override must be a JSON object `
        + '(remove the entry to keep defaults; disabling via null is not supported)');
      continue;
    }
    const m = deepMerge(DEFAULTS[name] ?? {}, overrides[name] ?? {});
    if (isPlainObject(m)) {
      // Default name/displayName from the key, but do NOT overwrite an
      // explicit contradictory name — validateProvider rejects it loudly.
      if (m.name === undefined) m.name = name;
      if (m.displayName === undefined) m.displayName = name;
      // JSON cannot express Infinity: null means "unlimited".
      if (m.quotas?.sends?.maxPerWindow === null) m.quotas.sends.maxPerWindow = Infinity;
    }
    merged[name] = m;
  }

  for (const [name, desc] of Object.entries(merged)) validateProvider(name, desc, problems);

  // Overlapping urlPatterns would let two providers claim the SAME live tab
  // (double-send, fake consensus) — reject the ambiguity outright.
  const names = Object.keys(merged);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = merged[names[i]]?.urlPattern;
      const b = merged[names[j]]?.urlPattern;
      if (typeof a === 'string' && typeof b === 'string' && a && b
        && (a.includes(b) || b.includes(a))) {
        problems.push(`providers "${names[i]}" and "${names[j]}" have overlapping urlPatterns `
          + `(${JSON.stringify(a)} vs ${JSON.stringify(b)}) — one tab would match both`);
      }
    }
  }

  if (problems.length > 0) {
    const detail = problems.map((m) => `  - ${m}`).join('\n');
    console.error(`[registry] REJECTED ${sourceLabel}:\n${detail}`);
    throw new Error(`Invalid provider registry (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${detail}`);
  }
  return deepFreeze(merged);
}

function build() {
  let overrides = {};
  if (existsSync(OVERRIDE_FILE)) {
    let raw;
    try {
      raw = readFileSync(OVERRIDE_FILE, 'utf8');
    } catch (e) {
      throw new Error(`Registry override ${OVERRIDE_FILE} exists but is unreadable: ${e.message}`);
    }
    try {
      overrides = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Registry override ${OVERRIDE_FILE} is not valid JSON: ${e.message}`);
    }
    if (!isPlainObject(overrides)) {
      throw new Error(`Registry override ${OVERRIDE_FILE} must be a JSON object keyed by provider name`);
    }
  }
  return mergeAndValidate(overrides, `override ${OVERRIDE_FILE}`);
}

let registry = build();

// ---------------------------------------------------------------------------
// API

export function getRegistry() { return registry; }

export function getProvider(name) { return registry[name]; }

export function providerNames() { return Object.keys(registry); }

/** { name: urlPattern } — backs the legacy PATTERNS export. */
export function patternsView() {
  return Object.fromEntries(Object.entries(registry).map(([n, d]) => [n, d.urlPattern]));
}

/** { name: entryUrl } — backs the legacy ENTRY_URLS export. */
export function entryUrlsView() {
  return Object.fromEntries(Object.entries(registry).map(([n, d]) => [n, d.entryUrl]));
}

/** { name: {input, submit, output, streaming} } — backs the legacy SELECTORS export. */
export function selectorsView() {
  return Object.fromEntries(Object.entries(registry).map(([n, d]) => [n, {
    input: d.selectors.input,
    submit: d.selectors.submit,
    output: d.selectors.output,
    streaming: d.selectors.streaming,
  }]));
}

/** { name: defaultResponseTimeoutMs } — config.js layers env precedence on top. */
export function responseTimeoutDefaults() {
  return Object.fromEntries(Object.entries(registry).map(([n, d]) => [n, d.timeouts?.response]));
}

/** { name: {maxPerWindow, windowMs, name} } — backs the rate-limiter table. */
export function sendLimitsView() {
  return Object.fromEntries(
    Object.entries(registry)
      .filter(([, d]) => d.quotas?.sends)
      .map(([n, d]) => [n, d.quotas.sends])
  );
}

/** Login-page URL fragments for a provider (lowercase match expected). */
export function loginUrlPatternsFor(name) {
  return registry[name]?.loginUrlPatterns ?? COMMON_LOGIN_URL_PATTERNS;
}

/**
 * Classify a page URL as a provider, or null. A URL matching a provider's
 * urlPattern but also one of its excludePathPatterns does not count (e.g.
 * claude.ai/chrome/* extension pages are not model tabs).
 */
export function matchModelForUrl(url) {
  if (typeof url !== 'string') return null;
  for (const [name, d] of Object.entries(registry)) {
    if (!url.includes(d.urlPattern)) continue;
    if ((d.excludePathPatterns ?? []).some((frag) => url.includes(frag))) continue;
    return name;
  }
  return null;
}

/**
 * TEST-ONLY: rebuild the registry with an explicit overrides object (or
 * null to restore file/defaults). Legacy shims in config.js capture views at
 * import time and will NOT see this — tests that need shim behavior use a
 * child process with REGISTRY_FILE instead.
 */
export function _rebuildForTest(overridesObject = null) {
  registry = overridesObject === null
    ? build()
    : mergeAndValidate(overridesObject, 'test rebuild');
  return registry;
}
