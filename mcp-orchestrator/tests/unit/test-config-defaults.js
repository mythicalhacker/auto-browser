/**
 * Config Defaults Tests — PR-3 cross-platform contract.
 * Platform-aware Chrome path, ~/.auto-browser defaults, env-override
 * precedence. Each probe is a fresh node process so config.js evaluates with
 * exactly the env we set (config caches env at import).
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// file:// URL, not a raw path: dynamic import() of a win32 backslash path
// fails in the ESM resolver.
const CONFIG_URL = pathToFileURL(join(__dirname, '..', '..', 'config.js')).href;

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

const OUR_VARS = [
  'CDP_URL', 'STATE_FILE', 'CHROME_PATH', 'CHROME_USER_DATA', 'AUTO_LAUNCH_CHROME',
  'TIMEOUT_RESPONSE', 'TIMEOUT_RESPONSE_CLAUDE', 'TIMEOUT_RESPONSE_CHATGPT', 'TIMEOUT_RESPONSE_GEMINI',
  'REGISTRY_FILE',
];

function probe(env = {}) {
  const clean = { ...process.env };
  for (const k of OUR_VARS) delete clean[k];
  // Registry DEFAULTS only — never a developer's ~/.auto-browser/registry.json.
  clean.REGISTRY_FILE = join(__dirname, '.no-registry-override.json');
  const r = spawnSync(process.execPath, ['-e', `
    import(${JSON.stringify(CONFIG_URL)}).then(({ CONFIG, ENTRY_URLS }) => {
      console.log(JSON.stringify({
        chromePath: CONFIG.chromePath,
        chromeUserData: CONFIG.chromeUserData,
        stateFile: CONFIG.stateFile,
        autoLaunchChrome: CONFIG.autoLaunchChrome,
        chatgptTimeout: CONFIG.timeouts.responseByModel.chatgpt,
        entryUrls: Object.keys(ENTRY_URLS).sort().join(','),
      }));
    });
  `], { env: { ...clean, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`config probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const PLATFORM_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
const expectedChrome = PLATFORM_CHROME[process.platform] || '/usr/bin/google-chrome';

console.log('Config Defaults Tests\n');

console.log('defaults (no env):');
const d = probe();
assert(d.chromePath === expectedChrome, `chromePath is the ${process.platform} default`);
assert(d.chromeUserData === join(homedir(), '.auto-browser', 'chrome-profile'), 'profile default is ~/.auto-browser/chrome-profile (outside the repo)');
assert(d.stateFile === join(homedir(), '.auto-browser', 'consensus_state.json'), 'state default is ~/.auto-browser/consensus_state.json');
assert(d.autoLaunchChrome === true, 'auto-launch enabled by default');
assert(d.chatgptTimeout === 600000, 'chatgpt per-model timeout default 600s');
assert(d.entryUrls === 'chatgpt,claude,gemini', 'ENTRY_URLS covers the three models');

console.log('\nenv overrides win:');
const o = probe({
  CHROME_PATH: '/custom/chrome',
  CHROME_USER_DATA: '/custom/profile',
  STATE_FILE: '/custom/state.json',
  AUTO_LAUNCH_CHROME: '0',
  TIMEOUT_RESPONSE: '8000',
});
assert(o.chromePath === '/custom/chrome', 'CHROME_PATH override wins');
assert(o.chromeUserData === '/custom/profile', 'CHROME_USER_DATA override wins');
assert(o.stateFile === '/custom/state.json', 'STATE_FILE override wins');
assert(o.autoLaunchChrome === false, 'AUTO_LAUNCH_CHROME=0 disables auto-launch');
assert(o.chatgptTimeout === 8000, 'global TIMEOUT_RESPONSE flows into per-model when no per-model env');

console.log('\nper-model precedence:');
const p = probe({ TIMEOUT_RESPONSE: '8000', TIMEOUT_RESPONSE_CHATGPT: '900000' });
assert(p.chatgptTimeout === 900000, 'TIMEOUT_RESPONSE_CHATGPT outranks TIMEOUT_RESPONSE');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
