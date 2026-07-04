/**
 * Test Runner
 * Runs all tests in sequence with clear reporting
 *
 * Usage:
 *   node tests/run-all.js           # Run all tests
 *   node tests/run-all.js --quick   # Skip e2e tests
 *   node tests/run-all.js --unit    # Unit tests only
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_URL = "http://localhost:9222";

// Hermetic suite: tests must see registry DEFAULTS, never a developer's
// ~/.auto-browser/registry.json (spawned test processes inherit this env).
// The pinned path intentionally does not exist.
if (!process.env.REGISTRY_FILE) {
  process.env.REGISTRY_FILE = join(__dirname, ".no-registry-override.json");
}

const TESTS = [
  {
    name: "Login Check",
    file: "unit/test-login-check.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Health Check",
    file: "unit/test-health-check.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Browser Tools",
    file: "unit/test-browser-tools.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Task Queue",
    file: "unit/test-task-queue.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Dispatcher",
    file: "unit/test-dispatcher.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Context Enricher",
    file: "unit/test-context-enricher.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Task Decomposer",
    file: "unit/test-task-decomposer.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Consensus Verdict",
    file: "unit/test-consensus-verdict.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Error Quarantine",
    file: "unit/test-error-quarantine.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "State Guard",
    file: "unit/test-state-guard.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Config Defaults",
    file: "unit/test-config-defaults.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Registry",
    file: "unit/test-registry.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Send Verification",
    file: "unit/test-send-verification.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Drivers",
    file: "unit/test-drivers.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Research Queue",
    file: "unit/test-research-queue.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Research Synthesis",
    file: "unit/test-research-synthesis.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Research Gates",
    file: "unit/test-research-gates.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Dead-Module Wiring",
    file: "unit/test-dead-module-wiring.js",
    critical: false,
    category: "unit",
    requiresChrome: false
  },
  {
    name: "Chrome Connection",
    file: "integration/test-chrome.js",
    critical: true,
    category: "integration",
    requiresChrome: true
  },
  {
    name: "Tab Detection",
    file: "integration/test-tabs.js",
    critical: true,
    category: "integration",
    requiresChrome: true
  },
  {
    name: "Selectors",
    file: "integration/test-selectors.js",
    critical: true,
    category: "integration",
    requiresChrome: true
  },
  {
    name: "2+2 Consensus",
    file: "e2e/test-2plus2.js",
    critical: false,
    category: "e2e",
    requiresChrome: true
  }
];

async function isPlaywrightAvailable() {
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}

async function isChromeAvailable() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function runTest(testFile) {
  return new Promise((resolve, reject) => {
    const testPath = join(__dirname, testFile);
    const proc = spawn("node", [testPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        reject({ success: false, stdout, stderr, code });
      }
    });
    
    proc.on("error", (err) => {
      reject({ success: false, error: err.message });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const quickMode = args.includes("--quick");
  const unitOnly = args.includes("--unit");
  const integrationOnly = args.includes("--integration");
  
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   🧪 MCP Orchestrator Test Suite           ║");
  console.log("╚════════════════════════════════════════════╝\n");
  
  // Check Chrome AND Playwright availability for tests that need it
  const playwrightOk = await isPlaywrightAvailable();
  const chromeAvailable = playwrightOk && await isChromeAvailable();
  if (!chromeAvailable) {
    const reason = !playwrightOk 
      ? "Playwright not installed" 
      : "Chrome CDP not available";
    console.log(`  ${reason} — skipping browser tests\n`);
  }

  // Filter tests based on args
  let testsToRun = TESTS;
  if (quickMode) {
    testsToRun = TESTS.filter(t => t.category !== "e2e");
    console.log("Mode: Quick (skipping e2e)\n");
  } else if (unitOnly) {
    testsToRun = TESTS.filter(t => t.category === "unit");
    console.log("Mode: Unit tests only\n");
  } else if (integrationOnly) {
    testsToRun = TESTS.filter(t => t.category === "integration");
    console.log("Mode: Integration tests only\n");
  }
  
  const results = [];
  let criticalFailed = false;
  
  for (const test of testsToRun) {
    if (criticalFailed) {
      results.push({ name: test.name, status: "SKIPPED", reason: "Critical test failed" });
      continue;
    }

    if (test.requiresChrome && !chromeAvailable) {
      results.push({ name: test.name, status: "SKIPPED", reason: "Chrome not available" });
      continue;
    }
    
    process.stdout.write(`  ${test.name.padEnd(25)} `);
    
    const startTime = Date.now();
    try {
      const result = await runTest(test.file);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✓ (${duration}s)`);
      results.push({ name: test.name, status: "PASSED", duration });
    } catch (e) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✗ (${duration}s)`);
      results.push({ 
        name: test.name, 
        status: "FAILED", 
        duration,
        stdout: e.stdout,
        stderr: e.stderr 
      });
      
      if (test.critical) {
        criticalFailed = true;
        console.log(`\n  ⚠️  Critical test failed, stopping.\n`);
      }
    }
  }
  
  // Summary
  console.log("\n" + "─".repeat(50));
  console.log("SUMMARY\n");
  
  const passed = results.filter(r => r.status === "PASSED").length;
  const failed = results.filter(r => r.status === "FAILED").length;
  const skipped = results.filter(r => r.status === "SKIPPED").length;
  
  results.forEach(r => {
    const icon = r.status === "PASSED" ? "✓" : r.status === "FAILED" ? "✗" : "○";
    console.log(`  ${icon} ${r.name}`);
  });
  
  console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  
  // Show failure details
  const failures = results.filter(r => r.status === "FAILED");
  if (failures.length > 0) {
    console.log("─".repeat(50));
    console.log("FAILURE DETAILS\n");
    
    for (const f of failures) {
      console.log(`  ${f.name}:`);
      if (f.stdout) {
        // Show last few lines of output
        const lines = f.stdout.trim().split("\n").slice(-10);
        lines.forEach(l => console.log(`    ${l}`));
      }
      console.log("");
    }
  }
  
  // Final status
  if (failed === 0) {
    console.log("✅ All tests passed!");
    process.exit(0);
  } else {
    console.log("❌ Some tests failed");
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Test runner error:", e);
  process.exit(1);
});
