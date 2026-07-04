#!/usr/bin/env node
// One-off partial-evidence run: sentinel prompt through the PRODUCTION round
// machinery against the single logged-in model. Proves insertText registers
// in the live editor, submit fires, waitForComplete/getOutput work. The
// cross-paste half of the race gate needs >=2 models and stays BLOCKED.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, '.state'), { recursive: true });
if (!process.env.STATE_FILE) process.env.STATE_FILE = join(__dirname, '.state', 'sentinel-single.json');
// Same invariant as run-e2e.js: the harness measures registry DEFAULTS, never
// a developer's ~/.auto-browser/registry.json (path intentionally absent).
if (!process.env.REGISTRY_FILE) {
  process.env.REGISTRY_FILE = join(__dirname, '.state', 'no-registry-override.json');
}

const MODEL = process.argv[2] || 'gemini';

const { reduceModelTabsTo, weSpawnedChrome } = await import('./chrome.js');
const { charge } = await import('./gates.js');
const { runConsensusRound } = await import('../../tools/consensus.js');
const { browserService } = await import('../../services/browser-service.js');

if (!(await weSpawnedChrome())) {
  console.error('refusing: current Chrome not spawned by this harness');
  process.exit(2);
}

// Close logged-out model tabs so the round machinery only sees MODEL and the
// generic contenteditable fallback can never touch a login page.
await reduceModelTabsTo(MODEL);

charge([MODEL], 1);

const token = `SENTINEL_${MODEL.toUpperCase()}_${randomBytes(4).toString('hex')}`;
await browserService.connect();
const active = browserService.getActiveModels();
console.log(`active models: ${active.join(',')}`);
if (active.length !== 1 || active[0] !== MODEL) {
  console.error(`FAIL: expected exactly [${MODEL}], got [${active.join(',')}]`);
  process.exit(1);
}

const round = await runConsensusRound(browserService, { [MODEL]: `Reply with exactly ${token} and nothing else.` }, 1);
const out = round.outputs[MODEL] || '';
const page = browserService.getPage(MODEL);
const body = await page.innerText('body').catch(() => '');

const checks = [
  [body.includes(token), `page body contains sentinel (user message registered via insertText)`],
  [out.includes(token), `response echoes sentinel (got: ${JSON.stringify(out.slice(0, 80))})`],
  [!(MODEL in (round.errors || {})), `no send/wait/extract failure (${JSON.stringify(round.errors?.[MODEL] || null)})`],
  [(round.timing?.[MODEL] ?? 0) > 0, `timing recorded (${round.timing?.[MODEL]}ms)`],
];
let failed = 0;
for (const [ok, label] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failed++;
}
await browserService.disconnect();
process.exit(failed ? 1 : 0);
