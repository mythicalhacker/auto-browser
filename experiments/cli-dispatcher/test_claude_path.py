"""Test which claude.exe gets invoked by subprocess"""
import subprocess
import shutil
import os

print("=" * 60)
print("CLAUDE PATH RESOLUTION TEST")
print("=" * 60)

# Test 1: Which claude does shutil find?
claude_path = shutil.which("claude")
print(f"\n1. shutil.which('claude'): {claude_path}")

# Test 2: Check PATH order
path_dirs = os.environ.get("PATH", "").split(os.pathsep)
print(f"\n2. PATH entries containing 'claude' or 'Anthropic':")
for p in path_dirs:
    if "claude" in p.lower() or "anthropic" in p.lower():
        print(f"   {p}")

# Test 3: Run bare 'claude' and see what happens
print(f"\n3. Running: subprocess.run(['claude', '-p', 'Say hello'], ...)")
try:
    r = subprocess.run(
        ["claude", "-p", "Say hello", "--output-format", "json"],
        capture_output=True,
        text=True,
        timeout=30
    )
    print(f"   Return code: {r.returncode}")
    print(f"   Stdout length: {len(r.stdout)} chars")
    print(f"   Stdout: [{r.stdout[:300]}]")
    print(f"   Stderr length: {len(r.stderr)} chars")
    print(f"   Stderr first 300: [{r.stderr[:300]}]")
except subprocess.TimeoutExpired:
    print("   TIMEOUT after 30s")
except Exception as e:
    print(f"   ERROR: {e}")

# Test 4: Run the CORRECT claude code CLI
CLAUDE_CODE = r"C:\Users\<you>\.local\bin\claude.exe"
print(f"\n4. Running CORRECT path: {CLAUDE_CODE}")
try:
    r = subprocess.run(
        [CLAUDE_CODE, "-p", "Say hello", "--output-format", "json"],
        capture_output=True,
        text=True,
        timeout=60
    )
    print(f"   Return code: {r.returncode}")
    print(f"   Stdout length: {len(r.stdout)} chars")
    print(f"   Stdout first 500: [{r.stdout[:500]}]")
    print(f"   Stderr length: {len(r.stderr)} chars")
    print(f"   Stderr first 300: [{r.stderr[:300]}]")
except subprocess.TimeoutExpired:
    print("   TIMEOUT after 60s")
except Exception as e:
    print(f"   ERROR: {e}")

print("\n" + "=" * 60)
print("DONE")
