#!/usr/bin/env node
// scripts/e2e/run-e2e.js — E2E gate orchestrator.
// Usage: node scripts/e2e/run-e2e.js --gates=handshake,validation[,insufficient,logins,race,agreeable,verdictstrip,timeout] [--live]
//
// STATE_FILE is pinned BEFORE any product import so no test can ever touch a
// real consensus_state.json. --live spawns caffeinate for the run.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '.state');
mkdirSync(STATE_DIR, { recursive: true });
if (!process.env.STATE_FILE) {
  process.env.STATE_FILE = join(STATE_DIR, 'orchestrator-default.json');
}
// Servers spawned by gates inherit this env: a Chrome dying mid-gate must be
// a LOUD connect failure, never a silent relaunch from a fresh profile with
// auto-opened tabs (only gateColdStart overrides this with '1').
if (!process.env.AUTO_LAUNCH_CHROME) {
  process.env.AUTO_LAUNCH_CHROME = '0';
}
// Gates assert against registry DEFAULTS: a developer's ~/.auto-browser/
// registry.json must never change what the harness measures. The pinned path
// intentionally does not exist (spawned servers inherit this env).
if (!process.env.REGISTRY_FILE) {
  process.env.REGISTRY_FILE = join(STATE_DIR, 'no-registry-override.json');
}

const { GATES, startCaffeinate, ledgerSnapshot } = await import('./gates.js');

const args = process.argv.slice(2);
const gatesArg = args.find((a) => a.startsWith('--gates='));
const live = args.includes('--live');
const requested = gatesArg ? gatesArg.slice('--gates='.length).split(',').filter(Boolean) : ['handshake'];

for (const g of requested) {
  if (!GATES[g]) {
    console.error(`unknown gate: ${g}. known: ${Object.keys(GATES).join(', ')}`);
    process.exit(2);
  }
}

if (live) startCaffeinate();

const log = (m) => console.log(`  [${new Date().toISOString().slice(11, 19)}] ${m}`);
const results = [];

for (const name of requested) {
  console.log(`\n=== GATE: ${name} ===`);
  const started = Date.now();
  let details;
  let status;
  try {
    details = await GATES[name](log);
    const failed = details.some((d) => d.startsWith('FAIL'));
    const blocked = details.some((d) => d.startsWith('BLOCKED') || d.startsWith('SKIP'));
    status = failed ? 'FAIL' : blocked ? 'BLOCKED' : 'PASS';
  } catch (e) {
    details = [`ERROR: ${e.message}`];
    status = 'FAIL';
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  for (const d of details) console.log(`  ${d}`);
  console.log(`  => ${status} (${secs}s)`);
  results.push({ gate: name, status, seconds: Number(secs), details });
}

// merge into the persistent gates file (later runs update earlier entries)
const GATES_FILE = join(STATE_DIR, 'gates.json');
const previous = existsSync(GATES_FILE) ? JSON.parse(readFileSync(GATES_FILE, 'utf8')) : {};
for (const r of results) previous[r.gate] = { ...r, at: new Date().toISOString() };
writeFileSync(GATES_FILE, JSON.stringify(previous, null, 2));

console.log('\n┌─────────────── GATES ───────────────');
for (const r of results) console.log(`│ ${r.status.padEnd(8)} ${r.gate.padEnd(14)} ${r.seconds}s`);
console.log('└─────────────────────────────────────');
console.log(`ledger: ${JSON.stringify(ledgerSnapshot())}`);

process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
