#!/usr/bin/env node
// One-off probe: retry login detection on claude/chatgpt tabs without ever
// entering credentials. Attempt A: reload + 12s settle. Attempt B: navigate
// to the app entry URL again + 12s settle. Reports final status.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, '.state'), { recursive: true });
if (!process.env.STATE_FILE) process.env.STATE_FILE = join(__dirname, '.state', 'probe.json');
// Same invariant as run-e2e.js: the harness measures registry DEFAULTS, never
// a developer's ~/.auto-browser/registry.json (path intentionally absent).
if (!process.env.REGISTRY_FILE) {
  process.env.REGISTRY_FILE = join(__dirname, '.state', 'no-registry-override.json');
}

const { chromium } = await import('playwright');
const { getRegistry } = await import('../../models/registry.js');
const { checkLogin } = await import('../../utils/login-check.js');

// Attempt-B re-entry target per provider (registry newChatUrl; null = no
// re-entry attempt, e.g. gemini).
const ENTRY = Object.fromEntries(
  Object.entries(getRegistry()).map(([m, d]) => [m, d.newChatUrl]).filter(([, u]) => u)
);

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const final = {};

for (const [model, desc] of Object.entries(getRegistry())) {
  const page = ctx.pages().find((p) => p.url().includes(desc.urlPattern));
  if (!page) {
    final[model] = { loggedIn: false, reason: 'no tab' };
    continue;
  }
  let status = await checkLogin(page, model);
  if (!status.loggedIn && ENTRY[model]) {
    console.log(`[${model}] attempt A: reload (${page.url()})`);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(12000);
    status = await checkLogin(page, model);
    if (!status.loggedIn) {
      console.log(`[${model}] attempt B: direct nav to ${ENTRY[model]} (was ${page.url()})`);
      await page.goto(ENTRY[model], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(12000);
      status = await checkLogin(page, model);
    }
  }
  final[model] = { ...status, url: page.url() };
  console.log(`[${model}] final: loggedIn=${status.loggedIn} (${status.reason}) url=${page.url()}`);
}

const usable = Object.entries(final).filter(([, r]) => r.loggedIn).map(([m]) => m);
writeFileSync(join(__dirname, '.state', 'logins.json'),
  JSON.stringify({ usable, results: final, at: new Date().toISOString(), probe: true }, null, 2));
console.log(`usable: ${usable.join(',') || '(none)'}`);
await browser.close();
process.exit(usable.length >= 2 ? 0 : 1);
