"""End-to-end test of the fixed dispatcher"""
import subprocess
import json
import time
import sys

CLAUDE_CODE_CLI = r"C:\Users\<you>\.local\bin\claude.exe"
OUTPUT = []

def log(msg):
    OUTPUT.append(msg)
    print(msg)

log("=" * 60)
log("END-TO-END DISPATCHER FIX VALIDATION")
log("=" * 60)

# Test 1: Verify correct executable
log("\n--- Test 1: Executable verification ---")
r = subprocess.run([CLAUDE_CODE_CLI, "--version"], capture_output=True, text=True, timeout=10)
log(f"Version: {r.stdout.strip()}")
log(f"PASS: {'Claude Code' in r.stdout}")

# Test 2: Fixed pattern - stdin prompt, explicit path, JSON output
log("\n--- Test 2: Fixed dispatcher pattern (stdin + explicit path) ---")
cmd = [CLAUDE_CODE_CLI, "-p", "--output-format", "json"]
start = time.time()
r = subprocess.run(cmd, input="Say hello in exactly 3 words", capture_output=True, text=True, timeout=30)
elapsed = time.time() - start
log(f"Time: {elapsed:.1f}s | rc={r.returncode} | stdout={len(r.stdout)}b")

if r.stdout.strip():
    try:
        parsed = json.loads(r.stdout)
        log(f"Result: {parsed.get('result', 'N/A')[:100]}")
        log(f"Session ID: {parsed.get('session_id', 'N/A')}")
        log(f"Cost: ${parsed.get('total_cost_usd', 'N/A')}")
        log("PASS: JSON output parsed successfully")
    except json.JSONDecodeError:
        log(f"PARTIAL: Got output but not valid JSON: {r.stdout[:100]}")
else:
    log("FAIL: Empty stdout")

# Test 3: Large prompt via stdin (simulating real pipeline prompts)
log("\n--- Test 3: Large prompt via stdin (~5KB) ---")
large_prompt = """You are a code reviewer. Analyze the following code and provide exactly 3 bullet points of feedback.

```python
def process_data(items):
    results = []
    for item in items:
        if item.get('status') == 'active':
            processed = {
                'id': item['id'],
                'name': item['name'].strip().lower(),
                'score': item.get('score', 0) * 1.5,
                'tags': [t.strip() for t in item.get('tags', '').split(',') if t.strip()]
            }
            results.append(processed)
    return sorted(results, key=lambda x: x['score'], reverse=True)
```

Respond with ONLY the 3 bullet points, nothing else."""

cmd = [CLAUDE_CODE_CLI, "-p", "--output-format", "json"]
start = time.time()
r = subprocess.run(cmd, input=large_prompt, capture_output=True, text=True, timeout=60)
elapsed = time.time() - start
log(f"Time: {elapsed:.1f}s | rc={r.returncode} | stdout={len(r.stdout)}b")

if r.stdout.strip():
    try:
        parsed = json.loads(r.stdout)
        log(f"Result preview: {parsed.get('result', 'N/A')[:200]}")
        log("PASS: Large prompt handled via stdin")
    except json.JSONDecodeError:
        log(f"PARTIAL: Output not JSON: {r.stdout[:100]}")
else:
    log("FAIL: Empty stdout on large prompt")

# Test 4: Simulate batch dispatch (2 parallel workers)
log("\n--- Test 4: Parallel dispatch (2 tasks) ---")
from concurrent.futures import ThreadPoolExecutor, as_completed

def run_task(task_prompt, task_id):
    cmd = [CLAUDE_CODE_CLI, "-p", "--output-format", "json"]
    start = time.time()
    r = subprocess.run(cmd, input=task_prompt, capture_output=True, text=True, timeout=30)
    elapsed = time.time() - start
    return {
        "task_id": task_id,
        "elapsed": elapsed,
        "has_output": bool(r.stdout.strip()),
        "rc": r.returncode,
        "result_preview": r.stdout[:100] if r.stdout else ""
    }

tasks = [
    ("What is 2 + 2? Reply with just the number.", "math_task"),
    ("Name one color of the rainbow. Reply with just the color.", "color_task"),
]

start = time.time()
with ThreadPoolExecutor(max_workers=2) as executor:
    futures = {executor.submit(run_task, prompt, tid): tid for prompt, tid in tasks}
    for future in as_completed(futures):
        result = future.result()
        log(f"  {result['task_id']}: {'PASS' if result['has_output'] else 'FAIL'} | {result['elapsed']:.1f}s | rc={result['rc']}")
        if result['has_output']:
            try:
                parsed = json.loads(result['result_preview'] + '...')  # Won't work but shows output
            except:
                pass
total_parallel = time.time() - start
log(f"Total parallel time: {total_parallel:.1f}s")
log("PASS: Parallel dispatch completed" if total_parallel < 30 else "SLOW: Parallel took >30s")

log("\n" + "=" * 60)
log("ALL TESTS COMPLETE")
log("=" * 60)

# Write results to file
with open(r"e2e_test_results.txt", "w") as f:
    f.write("\n".join(OUTPUT))
