import shutil
import subprocess
import sys
import os

outfile = r"test_resolution_output.txt"
with open(outfile, 'w') as f:
    def log(msg):
        f.write(msg + '\n')
        f.flush()
    
    log("=== Claude Executable Resolution Test ===")
    log(f"Python: {sys.executable}")
    log(f"PATH entries with claude/anthropic/.local:")
    for p in os.environ.get('PATH', '').split(';'):
        if 'claude' in p.lower() or 'anthropic' in p.lower() or '.local' in p.lower():
            log(f"  {p}")
    
    log(f"\nshutil.which('claude'): {shutil.which('claude')}")
    log(f"shutil.which('claude.exe'): {shutil.which('claude.exe')}")
    
    log("\n=== Subprocess 'claude --version' Test ===")
    try:
        r = subprocess.run(
            ["claude", "--version"],
            capture_output=True, text=True, timeout=15
        )
        log(f"rc={r.returncode}")
        log(f"  stdout: {r.stdout[:300]}")
        log(f"  stderr: {r.stderr[:300]}")
    except subprocess.TimeoutExpired:
        log("  TIMEOUT after 15s")
    except Exception as e:
        log(f"  ERROR: {e}")
    
    CLAUDE_CODE = r"C:\Users\<you>\.local\bin\claude.exe"
    log(f"\n=== Explicit Path '{CLAUDE_CODE}' --version ===")
    try:
        r = subprocess.run(
            [CLAUDE_CODE, "--version"],
            capture_output=True, text=True, timeout=15
        )
        log(f"rc={r.returncode}")
        log(f"  stdout: {r.stdout[:300]}")
        log(f"  stderr: {r.stderr[:300]}")
    except subprocess.TimeoutExpired:
        log("  TIMEOUT")
    except Exception as e:
        log(f"  ERROR: {e}")
    
    log(f"\n=== Stdin Prompt Test (correct way) ===")
    try:
        r = subprocess.run(
            [CLAUDE_CODE, "-p", "--output-format", "json"],
            input="Say just the word hello",
            capture_output=True, text=True, timeout=45
        )
        log(f"rc={r.returncode}")
        log(f"  stdout[:300]: {r.stdout[:300]}")
        if r.stderr:
            log(f"  stderr[:200]: {r.stderr[:200]}")
    except subprocess.TimeoutExpired:
        log("  TIMEOUT after 45s")
    except Exception as e:
        log(f"  ERROR: {e}")
    
    log(f"\n=== CLI Arg Prompt Test (dispatcher's broken pattern) ===")
    try:
        r = subprocess.run(
            [CLAUDE_CODE, "-p", "Say just the word hello", "--output-format", "json"],
            capture_output=True, text=True, timeout=15
        )
        log(f"rc={r.returncode}")
        log(f"  stdout[:300]: {r.stdout[:300]}")
    except subprocess.TimeoutExpired:
        log("  TIMEOUT after 15s (CONFIRMS BUG: -p + positional arg = hang)")
    except Exception as e:
        log(f"  ERROR: {e}")
    
    log("\n=== Done ===")
