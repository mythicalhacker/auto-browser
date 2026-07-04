/**
 * Registry Tests — PR-8 contract.
 * models/registry.js is the single source of provider facts; config.js
 * re-exports the legacy views (PATTERNS/ENTRY_URLS/SELECTORS/responseByModel).
 * Covers: shim equivalence with the pre-refactor literals, override
 * merge/validation semantics, deep-freeze, and the fake-4th-provider
 * flow-through (in-process via _rebuildForTest, import-time via REGISTRY_FILE
 * child probes).
 */
import { spawnSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hermetic: defaults only, and no inherited timeout env can skew responseByModel.
process.env.REGISTRY_FILE = join(__dirname, '..', '.no-registry-override.json');
process.env.STATE_FILE = join(tmpdir(), `registry-test-state-${process.pid}.json`);
for (const k of Object.keys(process.env)) {
  if (k === 'TIMEOUT_RESPONSE' || k.startsWith('TIMEOUT_RESPONSE_')) delete process.env[k];
}

const registry = await import('../../models/registry.js');
const { CONFIG, PATTERNS, ENTRY_URLS, SELECTORS } = await import('../../config.js');
const { checkLogin } = await import('../../utils/login-check.js');
const { pickProviderPages } = await import('../../services/browser-service.js');
const { generateConsensusPrompt } = await import('../../tools/consensus.js');

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

const mockPage = ({ url = 'https://example.com', matchSelectors = [] } = {}) => ({
  url: () => url,
  $: async (sel) => (matchSelectors.includes(sel) ? {} : null),
});

console.log('Registry Tests\n');

// --- shim equivalence: the legacy exports must be byte-identical -----------
console.log('shim equivalence (pre-refactor literals):');

assert(registry.providerNames().join(',') === 'claude,chatgpt,gemini',
  'provider set and order unchanged');

const LEGACY_PATTERNS = { claude: 'claude.ai', chatgpt: 'chatgpt.com', gemini: 'gemini.google.com' };
const LEGACY_ENTRY_URLS = { claude: 'https://claude.ai', chatgpt: 'https://chatgpt.com', gemini: 'https://gemini.google.com' };
const LEGACY_SELECTORS = {
  claude: {
    input: ['.ProseMirror', 'div[contenteditable="true"]'],
    submit: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label="Send"]'],
    output: ['.font-claude-response .standard-markdown'],
    streaming: ['[data-is-streaming="true"]'],
  },
  chatgpt: {
    input: ['#prompt-textarea', 'textarea[name="prompt-textarea"]', 'div[contenteditable="true"]'],
    submit: ['button[aria-label="Send prompt"]', 'button[data-testid="send-button"]', 'button[data-testid="composer-send-button"]'],
    output: ['[data-message-author-role="assistant"] .markdown', '[data-message-author-role="assistant"]'],
    streaming: ['button[aria-label="Stop streaming"]', 'button[data-testid="stop-button"]'],
  },
  gemini: {
    input: ['div[contenteditable="true"].ql-editor', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
    submit: ['button[aria-label="Send message"]', 'button.send-button', 'button[aria-label="Submit"]'],
    output: ['.model-response-text .markdown-main-panel', 'message-content .markdown', '.response-content'],
    streaming: ['button[aria-label="Stop response"]', 'button[aria-label="Stop"]'],
  },
};
assert(JSON.stringify(PATTERNS) === JSON.stringify(LEGACY_PATTERNS), 'PATTERNS deep-equals the legacy literal');
assert(JSON.stringify(ENTRY_URLS) === JSON.stringify(LEGACY_ENTRY_URLS), 'ENTRY_URLS deep-equals the legacy literal');
assert(JSON.stringify(SELECTORS) === JSON.stringify(LEGACY_SELECTORS), 'SELECTORS deep-equals the legacy literal');
assert(SELECTORS.unknown === undefined, 'unknown model still yields undefined on bracket lookup');

assert(CONFIG.timeouts.responseByModel.claude === 300000
  && CONFIG.timeouts.responseByModel.chatgpt === 600000
  && CONFIG.timeouts.responseByModel.gemini === 300000,
  'responseByModel defaults 300/600/300s from registry descriptors');

// --- descriptor facts -------------------------------------------------------
console.log('\ndescriptor facts:');
assert(registry.getProvider('chatgpt').displayName === 'ChatGPT', 'chatgpt displayName is ChatGPT');
assert(registry.getProvider('chatgpt').capabilities.reloadOnEmptyOutput === true,
  'chatgpt carries reloadOnEmptyOutput (thinking-mode DOM workaround)');
assert(!registry.getProvider('claude').capabilities.reloadOnEmptyOutput
  && !registry.getProvider('gemini').capabilities.reloadOnEmptyOutput,
  'claude/gemini do not reload on empty output');
assert(registry.getProvider('claude').newChatUrl === 'https://claude.ai/new'
  && registry.getProvider('gemini').newChatUrl === null,
  'newChatUrl: claude /new, gemini none (probe-logins re-entry contract)');

const limits = registry.sendLimitsView();
assert(limits.claude.maxPerWindow === 900 && limits.claude.name === '5 hours', 'claude send limit 900/5h');
assert(limits.chatgpt.maxPerWindow === Infinity && limits.chatgpt.windowMs === 24 * 60 * 60 * 1000,
  'chatgpt unlimited with a real 24h tracking window');
assert(limits.gemini.maxPerWindow === 100, 'gemini send limit 100/24h');

assert(registry.loginUrlPatternsFor('claude').includes('/login')
  && registry.loginUrlPatternsFor('gemini').includes('accounts.google.com'),
  'login URL patterns preserved per provider');

let mutated = true;
try { registry.getRegistry().claude.urlPattern = 'hacked'; } catch { mutated = false; }
assert(!mutated && registry.getRegistry().claude.urlPattern === 'claude.ai', 'registry is deep-frozen');
assert(Object.isFrozen(registry.getRegistry().claude.selectors)
  && Object.isFrozen(registry.getRegistry().claude.selectors.input)
  && Object.isFrozen(SELECTORS.claude.input),
  'frozen at every level: descriptor, selector bundle, selector arrays (registry + config view)');
let pushed = true;
try { registry.getRegistry().claude.selectors.input.push('x'); } catch { pushed = false; }
assert(!pushed && registry.getRegistry().claude.selectors.input.length === 2,
  'frozen selector chain rejects mutation (legacy config guarantee preserved)');

// --- URL classification -----------------------------------------------------
console.log('\nURL classification (matchModelForUrl / pickProviderPages):');
assert(registry.matchModelForUrl('https://claude.ai/chat/abc') === 'claude', 'claude chat URL → claude');
assert(registry.matchModelForUrl('https://claude.ai/chrome/settings') === null,
  'claude.ai/chrome/* extension page is NOT a model tab');
assert(registry.matchModelForUrl('https://chatgpt.com/') === 'chatgpt', 'chatgpt URL → chatgpt');
assert(registry.matchModelForUrl('https://example.com') === null, 'unrelated URL → null');

const pages = [
  mockPage({ url: 'https://claude.ai/chrome/ext' }),
  mockPage({ url: 'https://claude.ai/settings' }),
  mockPage({ url: 'https://claude.ai/chat/abc' }),
  mockPage({ url: 'https://chatgpt.com/' }),
];
const picked = pickProviderPages(pages);
assert(picked.claude && picked.claude.url() === 'https://claude.ai/chat/abc',
  'claude discovery prefers /chat/ pages');
assert(picked.chatgpt && picked.chatgpt.url() === 'https://chatgpt.com/', 'chatgpt discovery unchanged');
assert(picked.gemini === null, 'no gemini tab → null slot');
const pickedNoChat = pickProviderPages([mockPage({ url: 'https://claude.ai/chrome/ext' })]);
assert(pickedNoChat.claude === null, 'a lone claude.ai/chrome/* page is never adopted');

// --- login-check through the registry ---------------------------------------
console.log('\nlogin-check through the registry:');
const liClaude = await checkLogin(mockPage({ url: 'https://claude.ai/chat/abc', matchSelectors: ['.ProseMirror'] }), 'claude');
assert(liClaude.loggedIn && liClaude.reason.includes('.ProseMirror'), 'claude logged-in via registry input selector');
const liAuth = await checkLogin(mockPage({ url: 'https://chatgpt.com/auth/login' }), 'chatgpt');
assert(!liAuth.loggedIn && liAuth.reason.startsWith('URL contains login pattern'),
  'login-URL reason prefix preserved (consensus/dispatcher fast-fail contract)');
const liUnknown = await checkLogin(mockPage(), 'nonexistent');
assert(!liUnknown.loggedIn && liUnknown.reason.includes('Unknown model'), 'unknown model contract preserved');

// --- override merge & validation (in-process) --------------------------------
console.log('\noverride merge & validation:');
const FAKEAI = {
  displayName: 'FakeAI',
  urlPattern: 'fakeai.example',
  entryUrl: 'https://fakeai.example',
  selectors: {
    input: ['#fake-input'],
    submit: ['#fake-send'],
    output: ['.fake-output'],
    streaming: ['.fake-streaming'],
  },
  timeouts: { response: 111000 },
  quotas: { sends: { maxPerWindow: 7, windowMs: 3600000, name: '1 hour' } },
};

registry._rebuildForTest({
  fakeai: FAKEAI,
  claude: { selectors: { input: ['#custom-only'] }, timeouts: { response: 42000 } },
});
assert(registry.providerNames().join(',') === 'claude,chatgpt,gemini,fakeai',
  'override adds a 4th provider to the set');
assert(registry.matchModelForUrl('https://fakeai.example/chat') === 'fakeai',
  'fake provider URL classifies via registry');
const fakePicked = pickProviderPages([mockPage({ url: 'https://fakeai.example/chat' })]);
assert(fakePicked.fakeai && fakePicked.fakeai.url() === 'https://fakeai.example/chat',
  'page discovery (getActiveModels feed) picks the fake provider tab');
const liFake = await checkLogin(mockPage({ url: 'https://fakeai.example/chat', matchSelectors: ['#fake-input'] }), 'fakeai');
assert(liFake.loggedIn, 'login-check probes the fake provider selectors');
const prompt = generateConsensusPrompt('Q?', [{
  round: 1,
  outputs: { fakeai: 'fake answer', chatgpt: 'gpt answer', gemini: 'gem answer' },
  errors: {},
}], 'claude');
assert(prompt.includes('=== FAKEAI ===') && prompt.includes('fake answer'),
  'consensus cross-pollination prompt embeds the fake provider');
assert(registry.getProvider('claude').selectors.input.join(',') === '#custom-only',
  'array override REPLACES the selector chain wholesale');
assert(registry.getProvider('claude').selectors.submit.length === 3
  && registry.getProvider('claude').timeouts.response === 42000
  && registry.getProvider('claude').urlPattern === 'claude.ai',
  'object override merges: untouched keys keep defaults');

registry._rebuildForTest(null);
assert(registry.providerNames().length === 3 && !registry.getProvider('fakeai'),
  'rebuild(null) restores defaults');

let invalidError = null;
try {
  registry._rebuildForTest({ broken: { urlPattern: '' } });
} catch (e) {
  invalidError = e;
}
registry._rebuildForTest(null);
assert(invalidError && invalidError.message.includes('Invalid provider registry')
  && invalidError.message.includes('selectors')
  && invalidError.message.includes('entryUrl'),
  'incomplete new provider rejected loudly, every problem listed');

// Every rejection path must produce the AGGREGATED report — never a raw
// TypeError, never a silent no-op (review findings, 2026-07-04).
const rejects = (overrides, mustInclude, label) => {
  let err = null;
  try { registry._rebuildForTest(overrides); } catch (e) { err = e; }
  registry._rebuildForTest(null);
  assert(err && err.message.includes('Invalid provider registry')
    && mustInclude.every((s) => err.message.includes(s)), label);
};
rejects({ claude: { capabilities: null } }, ['"capabilities" must be an object'],
  'null capabilities → aggregated report, not raw TypeError');
rejects({ claude: { timeouts: null } }, ['"timeouts" must be an object'],
  'null timeouts → aggregated report');
rejects({ claude: { quotas: null } }, ['"quotas" must be an object'],
  'null quotas → aggregated report');
rejects({ gemini: null }, ['disabling via null is not supported'],
  'provider:null rejected loudly (never a silent revert to defaults)');
rejects({ '': FAKEAI }, ['provider key ""'],
  'empty-string provider key rejected');
rejects({ 'gpt-4o': FAKEAI }, ['provider key "gpt-4o"'],
  'provider key must be env-name-safe (lowercase alnum, no hyphens)');
rejects({ claude: { name: 'chatgpt' } }, ['must match its key'],
  'contradictory name override rejected, not silently normalized');
rejects(JSON.parse('{"__proto__":{"urlPattern":"evil.example"}}'), ['prototype-pollution guard'],
  'top-level __proto__ key rejected loudly');
rejects(JSON.parse('{"claude":{"__proto__":{"polluted":true}}}'), ['prototype-pollution guard'],
  'nested __proto__ key rejected loudly');
rejects({ searchai: { ...FAKEAI, urlPattern: 'google.com' } }, ['overlapping urlPatterns'],
  'urlPattern overlap (one tab matching two providers) rejected');
rejects({ noquota: { displayName: 'NQ', urlPattern: 'noquota.example', entryUrl: 'https://noquota.example', selectors: FAKEAI.selectors, quotas: {} } },
  ['"quotas.sends" is required'],
  'quotas.sends is part of the provider contract (rate observability)');
assert(Object.getPrototypeOf(registry.getRegistry()) !== Object.prototype
  || registry.getProvider('toString') === undefined,
  'registry lookups never leak Object.prototype members as providers');

registry._rebuildForTest({
  fakeai: { ...FAKEAI, quotas: { sends: { maxPerWindow: null, windowMs: 3600000, name: '1 hour' } } },
});
assert(registry.sendLimitsView().fakeai.maxPerWindow === Infinity,
  'JSON null maxPerWindow converts to Infinity (unlimited)');
registry._rebuildForTest(null);

// --- REGISTRY_FILE override flow-through (child processes) -------------------
console.log('\nREGISTRY_FILE child probes (import-time override):');
const tmp = mkdtempSync(join(tmpdir(), 'registry-test-'));
const overridePath = join(tmp, 'registry.json');
writeFileSync(overridePath, JSON.stringify({ fakeai: FAKEAI }));

const CONFIG_URL = pathToFileURL(join(__dirname, '..', '..', 'config.js')).href;
const RATE_URL = pathToFileURL(join(__dirname, '..', '..', 'utils', 'rate-limiter.js')).href;
const LOGIN_URL = pathToFileURL(join(__dirname, '..', '..', 'utils', 'login-check.js')).href;

function probe(env = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (k === 'TIMEOUT_RESPONSE' || k.startsWith('TIMEOUT_RESPONSE_')) delete clean[k];
  }
  const script = `
    Promise.all([
      import(${JSON.stringify(CONFIG_URL)}),
      import(${JSON.stringify(RATE_URL)}),
      import(${JSON.stringify(LOGIN_URL)}),
    ]).then(async ([cfg, rate, login]) => {
      const page = { url: () => 'https://fakeai.example/chat', $: async (s) => (s === '#fake-input' ? {} : null) };
      const lc = await login.checkLogin(page, 'fakeai');
      console.log(JSON.stringify({
        patterns: Object.keys(cfg.PATTERNS).sort().join(','),
        fakeaiPattern: cfg.PATTERNS.fakeai,
        fakeaiEntry: cfg.ENTRY_URLS.fakeai,
        fakeaiInput: cfg.SELECTORS.fakeai.input.join('|'),
        fakeaiTimeout: cfg.CONFIG.timeouts.responseByModel.fakeai,
        usageModels: rate.getAllUsageStats().map((s) => s.model).sort().join(','),
        fakeaiLimit: rate.getUsageStats('fakeai').limit,
        fakeaiLoggedIn: lc.loggedIn,
      }));
    });
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...clean, REGISTRY_FILE: overridePath, ...env },
    encoding: 'utf8',
  });
}

const r1 = probe();
assert(r1.status === 0, `override probe runs (${(r1.stderr || '').split('\n')[0] || 'ok'})`);
const d1 = r1.status === 0 ? JSON.parse(r1.stdout.trim().split('\n').pop()) : {};
assert(d1.patterns === 'chatgpt,claude,fakeai,gemini', 'PATTERNS shim includes the override-added provider');
assert(d1.fakeaiPattern === 'fakeai.example' && d1.fakeaiEntry === 'https://fakeai.example',
  'PATTERNS/ENTRY_URLS values flow from the override file');
assert(d1.fakeaiInput === '#fake-input', 'SELECTORS shim exposes the override selectors');
assert(d1.fakeaiTimeout === 111000, 'responseByModel picks up the override timeout default');
assert(d1.usageModels === 'chatgpt,claude,fakeai,gemini', 'rate-limiter enumerates the override provider');
assert(d1.fakeaiLimit === 7, 'rate-limiter uses the override quota');
assert(d1.fakeaiLoggedIn === true, 'login-check works for the override provider');

const r2 = probe({ TIMEOUT_RESPONSE_FAKEAI: '1234' });
const d2 = r2.status === 0 ? JSON.parse(r2.stdout.trim().split('\n').pop()) : {};
assert(d2.fakeaiTimeout === 1234, 'TIMEOUT_RESPONSE_<ID> env outranks the override default');

const badPath = join(tmp, 'bad-registry.json');
writeFileSync(badPath, JSON.stringify({ broken: { urlPattern: '' } }));
const r3 = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(CONFIG_URL)});`], {
  env: { ...process.env, REGISTRY_FILE: badPath },
  encoding: 'utf8',
});
assert(r3.status !== 0, 'invalid override refuses to boot (import fails)');
assert((r3.stderr || '').includes('Invalid provider registry'), 'boot failure names the registry problems');

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
