"""Test different ways to pass prompts to Claude Code"""
import subprocess
import time
import os

CLAUDE = r"C:\Users\<you>\.local\bin\claude.exe"

def test(name, cmd, stdin_data=None, timeout=45):
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"CMD: {cmd}")
    if stdin_data:
        print(f"STDIN: {stdin_data[:100]}")
    print("-"*60)
    
    start = time.time()
    try:
        r = subprocess.run(
            cmd,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        elapsed = time.time() - start
        print(f"  Time: {elapsed:.1f}s")
        print(f"  Return code: {r.returncode}")
        print(f"  Stdout ({len(r.stdout)} chars): [{r.stdout[:300]}]")
        print(f"  Stderr ({len(r.stderr)} chars): [{r.stderr[:200]}]")
    except subprocess.TimeoutExpired:
        elapsed = time.time() - start
        print(f"  TIMEOUT after {elapsed:.1f}s")
    except Exception as e:
        print(f"  ERROR: {e}")

# Test A: Prompt as positional arg (how dispatcher does it)
test("Prompt as CLI arg", 
     [CLAUDE, "-p", "Say hello", "--output-format", "json"])

# Test B: Prompt via stdin with input=
test("Prompt via stdin (input=)", 
     [CLAUDE, "-p", "--output-format", "json"],
     stdin_data="Say hello")

# Test C: Prompt via stdin, text output
test("Prompt via stdin, text format", 
     [CLAUDE, "-p", "--output-format", "text"],
     stdin_data="Say hello")

# Test D: Prompt as arg, text output
test("Prompt as arg, text format", 
     [CLAUDE, "-p", "Say hello", "--output-format", "text"])

# Test E: Just --help to see if it responds at all
test("--help (does it even run?)", 
     [CLAUDE, "--help"],
     timeout=10)

# Test F: Version check
test("--version", 
     [CLAUDE, "--version"],
     timeout=10)

print("\n" + "="*60)
print("ALL TESTS COMPLETE")
