"""Confirm: positional arg vs stdin for Claude Code"""
import subprocess
import time

CLAUDE = r"C:\Users\<you>\.local\bin\claude.exe"

def test(name, cmd, stdin_data=None, timeout=30):
    print(f"\nTEST: {name}")
    start = time.time()
    try:
        r = subprocess.run(cmd, input=stdin_data, capture_output=True, text=True, timeout=timeout)
        elapsed = time.time() - start
        ok = len(r.stdout.strip()) > 0
        print(f"  {'PASS' if ok else 'FAIL'} | {elapsed:.1f}s | stdout={len(r.stdout)}b | rc={r.returncode}")
        if ok: print(f"  Output: {r.stdout[:100]}")
    except subprocess.TimeoutExpired:
        print(f"  TIMEOUT | {time.time()-start:.1f}s")

# The dispatcher's EXACT pattern (broken)
test("Dispatcher pattern: claude -p PROMPT --output-format json",
     [CLAUDE, "-p", "Say hello", "--output-format", "json"])

# Prompt at end
test("Prompt at end: claude -p --output-format json PROMPT",
     [CLAUDE, "-p", "--output-format", "json", "Say hello"])

# stdin method (works)
test("Stdin: echo | claude -p --output-format json",
     [CLAUDE, "-p", "--output-format", "json"],
     stdin_data="Say hello")

# What if we pass prompt AND stdin?
test("Both: arg + stdin",
     [CLAUDE, "-p", "Say hello", "--output-format", "json"],
     stdin_data="also hello")

# Large prompt via stdin
big_prompt = "Respond with just the word OK. " * 50
test("Large stdin (~1500 chars)",
     [CLAUDE, "-p", "--output-format", "json"],
     stdin_data=big_prompt, timeout=60)

# Very large prompt via stdin
huge_prompt = "You are analyzing a codebase. " * 500
test(f"Huge stdin (~15000 chars, {len(huge_prompt)} bytes)",
     [CLAUDE, "-p", "--output-format", "json"],
     stdin_data=huge_prompt, timeout=90)

# stream-json format
test("stream-json format via stdin",
     [CLAUDE, "-p", "--output-format", "stream-json"],
     stdin_data="Say hello")

# With model flag
test("With --model sonnet via stdin",
     [CLAUDE, "-p", "--output-format", "json", "--model", "sonnet"],
     stdin_data="Say hello")

# Test --continue and --resume availability  
test("--help grep for continue/resume",
     [CLAUDE, "--help"],
     timeout=5)

print("\nALL TESTS COMPLETE")
