// tests/unit/_hermetic-env.js — import this FIRST in every unit test that
// (transitively) loads product modules: it pins REGISTRY_FILE before
// models/registry.js can read it, so a developer's real
// ~/.auto-browser/registry.json never changes test results — whether the
// test runs under tests/run-all.js (which also pins) or directly via
// `node tests/unit/test-*.js`. The pinned path intentionally does not exist.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
if (!process.env.REGISTRY_FILE) {
  process.env.REGISTRY_FILE = join(dir, '..', '.no-registry-override.json');
}
