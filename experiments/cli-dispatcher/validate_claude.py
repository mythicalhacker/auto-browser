"""Quick validation: confirm stdin vs CLI arg behavior"""
import subprocess, time, json

CLAUDE = r"C:\Users\<you>\.local\bin\claude.exe"
OUTPUT = []

def test(name, cmd, stdin_data=None, timeout=30):
    start = time.time()
    try:
        r = subprocess.run(cmd, input=stdin_data, capture_output=True, text=True, timeout=timeout)
        elapsed = time.time() - start
        has_output = len(r.stdout.strip()) > 0
        OUTPUT.append(f"{name}: {'PASS' if has_output else 'FAIL (empty)'} | {elapsed:.1f}s | rc={r.returncode} | stdout={len(r.stdout)}b")
        if has_output:
            OUTPUT.append(f"  Preview: {r.stdout[:120]}")
    except subprocess.TimeoutExpired:
        OUTPUT.append(f"{name}: TIMEOUT after {time.time()-start:.1f}s")
    except Exception as e:
        OUTPUT.append(f"{name}: ERROR: {e}")

# Test 1: bare 'claude' --version (which exe gets called?)
test("bare_claude_version", ["claude", "--version"], timeout=10)

# Test 2: explicit path --version
test("explicit_path_version", [CLAUDE, "--version"], timeout=10)

# Test 3: Dispatcher's pattern - CLI arg (explicit path)
test("cli_arg_explicit", [CLAUDE, "-p", "Say hello", "--output-format", "json"])

# Test 4: stdin method (explicit path) 
test("stdin_explicit", [CLAUDE, "-p", "--output-format", "json"], stdin_data="Say hello")

# Test 5: bare 'claude' with stdin
test("stdin_bare", ["claude", "-p", "--output-format", "json"], stdin_data="Say hello")

# Write results
with open(r"validation_results.txt", "w") as f:
    f.write("\n".join(OUTPUT))
    
print("\n".join(OUTPUT))
