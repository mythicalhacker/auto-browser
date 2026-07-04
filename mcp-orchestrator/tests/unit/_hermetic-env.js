// tests/unit/_hermetic-env.js — import this FIRST in every unit test that
// (transitively) loads product modules: it pins REGISTRY_FILE before
// models/registry.js can read it, so a developer's real
// ~/.auto-browser/registry.json never changes test results — whether the
// test runs under tests/run-all.js (which also pins) or directly via
// `node tests/unit/test-*.js`. The pinned path intentionally does not exist.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const dir = dirname(fileURLToPath(import.meta.url));
if (!process.env.REGISTRY_FILE) {
  process.env.REGISTRY_FILE = join(dir, '..', '.no-registry-override.json');
}
// Research-train state files must NEVER touch the real ~/.auto-browser from
// a unit test (same stance as STATE_FILE).
if (!process.env.QUOTA_FILE) {
  process.env.QUOTA_FILE = join(tmpdir(), `ab-test-quotas-${process.pid}.json`);
}
if (!process.env.RESEARCH_HOME) {
  process.env.RESEARCH_HOME = join(tmpdir(), `ab-test-research-${process.pid}`);
}
