import shutil
import subprocess
import sys
import os

print("=== Claude Executable Resolution Test ===")
print(f"Python: {sys.executable}")
print(f"PATH entries with claude/anthropic:")
for p in os.environ.get('PATH', '').split(';'):
    if 'claude' in p.lower() or 'anthropic' in p.lower() or '.local' in p.lower():
        print(f"  {p}")

print(f"\nshutil.which('claude'): {shutil.which('claude')}")
print(f"shutil.which('claude.exe'): {shutil.which('claude.exe')}")

# Test what subprocess would actually invoke
print("\n=== Subprocess Test ===")
try:
    r = subprocess.run(
        ["claude", "--version"],
        capture_output=True, text=True, timeout=15
    )
    print(f"'claude --version' rc={r.returncode}")
    print(f"  stdout: {r.stdout[:200]}")
    print(f"  stderr: {r.stderr[:200]}")
except subprocess.TimeoutExpired:
    print("  TIMEOUT after 15s")
except Exception as e:
    print(f"  ERROR: {e}")

# Test the correct path
CLAUDE_CODE = r"C:\Users\<you>\.local\bin\claude.exe"
print(f"\n=== Explicit Path Test ({CLAUDE_CODE}) ===")
try:
    r = subprocess.run(
        [CLAUDE_CODE, "--version"],
        capture_output=True, text=True, timeout=15
    )
    print(f"rc={r.returncode}")
    print(f"  stdout: {r.stdout[:200]}")
    print(f"  stderr: {r.stderr[:200]}")
except subprocess.TimeoutExpired:
    print("  TIMEOUT")
except Exception as e:
    print(f"  ERROR: {e}")

# Test stdin-based prompt
print(f"\n=== Stdin Prompt Test ===")
try:
    r = subprocess.run(
        [CLAUDE_CODE, "-p", "--output-format", "json"],
        input="Say just the word hello",
        capture_output=True, text=True, timeout=30
    )
    print(f"rc={r.returncode}")
    print(f"  stdout[:200]: {r.stdout[:200]}")
    if r.stderr:
        print(f"  stderr[:200]: {r.stderr[:200]}")
except subprocess.TimeoutExpired:
    print("  TIMEOUT after 30s")
except Exception as e:
    print(f"  ERROR: {e}")

# Test the BROKEN pattern (prompt as CLI arg) 
print(f"\n=== CLI Arg Prompt Test (dispatcher pattern - expected to hang) ===")
try:
    r = subprocess.run(
        [CLAUDE_CODE, "-p", "Say just the word hello", "--output-format", "json"],
        capture_output=True, text=True, timeout=15
    )
    print(f"rc={r.returncode}")
    print(f"  stdout[:200]: {r.stdout[:200]}")
except subprocess.TimeoutExpired:
    print("  TIMEOUT after 15s (CONFIRMS THE BUG)")
except Exception as e:
    print(f"  ERROR: {e}")

print("\n=== Done ===")
