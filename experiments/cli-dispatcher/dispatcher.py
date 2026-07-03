"""
Claude Worker Dispatcher
Run this in Claude Terminal to enable parallel Claude execution.

Usage:
  python dispatcher.py                    # Process pending tasks
  python dispatcher.py --watch            # Watch mode (continuous)
  python dispatcher.py --task <file.json> # Single task file
"""

import subprocess
import json
import sys
import time
import argparse
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

# Configuration
BASE_DIR = Path(__file__).resolve().parent
TASKS_PENDING = BASE_DIR / "tasks" / "pending"
TASKS_COMPLETED = BASE_DIR / "tasks" / "completed"
RESULTS_DIR = BASE_DIR / "results"
SIGNALS_DIR = BASE_DIR / "signals"

MAX_WORKERS = 3
DEFAULT_BUDGET = 0.50  # USD per task
POLL_INTERVAL = 5  # seconds for watch mode

# Claude Code CLI path - MUST use explicit path on Windows because bare 'claude'
# resolves to the Claude Desktop App (Electron) which silently ignores -p flag.
# The Desktop App returns exit code 0 with empty stdout, causing silent failures.
CLAUDE_CODE_CLI = r"C:\Users\<you>\.local\bin\claude.exe"


def setup_dirs():
    """Ensure all directories exist."""
    for d in [TASKS_PENDING, TASKS_COMPLETED, RESULTS_DIR, SIGNALS_DIR]:
        d.mkdir(parents=True, exist_ok=True)


def validate_claude_cli():
    """Verify CLAUDE_CODE_CLI points to Claude Code, not the Desktop App."""
    import shutil
    cli_path = Path(CLAUDE_CODE_CLI)
    
    if not cli_path.exists():
        log(f"ERROR: Claude Code CLI not found at: {CLAUDE_CODE_CLI}")
        log(f"  Install Claude Code or update CLAUDE_CODE_CLI path in dispatcher.py")
        sys.exit(1)
    
    try:
        r = subprocess.run(
            [CLAUDE_CODE_CLI, "--version"],
            capture_output=True, text=True, timeout=10
        )
        version = r.stdout.strip()
        if "Claude Code" in version:
            log(f"  Claude Code CLI verified: {version}")
        elif not version:
            log(f"WARNING: '{CLAUDE_CODE_CLI}' returned empty --version output.")
            log(f"  This may be the Claude Desktop App (Electron), not Claude Code CLI.")
            log(f"  Expected path: C:\\Users\\<user>\\.local\\bin\\claude.exe")
            sys.exit(1)
        else:
            log(f"  Claude CLI version: {version}")
    except Exception as e:
        log(f"WARNING: Could not verify Claude CLI: {e}")


def log(msg: str):
    """Print timestamped log message."""
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def run_claude_worker(task: dict) -> dict:
    """
    Spawn a Claude Code worker for a single task.
    
    Task format:
    {
        "task_id": "unique_id",
        "prompt": "The instruction for Claude",
        "model": "sonnet" | "opus" (optional),
        "system_prompt": "Custom system prompt" (optional),
        "max_budget_usd": 0.50 (optional),
        "allowed_tools": ["Read", "Write"] (optional)
    }
    """
    task_id = task.get("task_id", "unknown")
    prompt = task.get("prompt", "")
    
    if not prompt:
        return {
            "task_id": task_id,
            "status": "error",
            "error": "No prompt provided"
        }
    
    # Build command - use explicit CLAUDE_CODE_CLI path to avoid resolving
    # to Claude Desktop App. Prompt is passed via stdin (not CLI arg) because:
    #   1. stdin is ~30% faster than CLI arg (2.6s vs 3.9s in benchmarks)
    #   2. CLI args have OS length limits (~8191 chars on Windows cmd)
    #   3. stdin handles arbitrarily large prompts reliably
    cmd = [CLAUDE_CODE_CLI, "-p", "--output-format", "json"]
    
    if task.get("model"):
        cmd.extend(["--model", task["model"]])
    
    if task.get("system_prompt"):
        cmd.extend(["--system-prompt", task["system_prompt"]])
    
    if task.get("max_budget_usd"):
        cmd.extend(["--max-budget-usd", str(task["max_budget_usd"])])
    elif DEFAULT_BUDGET:
        cmd.extend(["--max-budget-usd", str(DEFAULT_BUDGET)])
    
    if task.get("allowed_tools"):
        cmd.extend(["--allowedTools", ",".join(task["allowed_tools"])])
    
    if task.get("resume_session"):
        cmd.extend(["--resume", task["resume_session"]])
    
    log(f"  Spawning worker for: {task_id}")
    log(f"    Model: {task.get('model', 'default')}")
    log(f"    Prompt: {prompt[:80]}...")
    log(f"    CLI: {CLAUDE_CODE_CLI}")
    
    start_time = time.time()
    
    try:
        result = subprocess.run(
            cmd,
            input=prompt,  # Pass prompt via stdin, NOT as CLI argument
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout per task
        )
        
        duration = time.time() - start_time
        
        if result.returncode != 0:
            return {
                "task_id": task_id,
                "status": "error",
                "error": result.stderr,
                "duration_seconds": duration
            }
        
        # Detect empty output - this is the telltale sign of invoking the
        # Claude Desktop App instead of Claude Code CLI
        if not result.stdout.strip():
            return {
                "task_id": task_id,
                "status": "error",
                "error": (
                    "Empty stdout from Claude process (exit code 0). "
                    "This typically means the Claude Desktop App was invoked "
                    "instead of Claude Code CLI. Verify CLAUDE_CODE_CLI path."
                ),
                "stderr": result.stderr[:500] if result.stderr else "",
                "duration_seconds": duration
            }
        
        # Parse JSON output
        try:
            output = json.loads(result.stdout)
            return {
                "task_id": task_id,
                "status": "success",
                "result": output.get("result", result.stdout),
                "session_id": output.get("session_id"),
                "cost_usd": output.get("total_cost_usd"),
                "duration_seconds": duration,
                "raw_output": output
            }
        except json.JSONDecodeError:
            return {
                "task_id": task_id,
                "status": "success",
                "result": result.stdout,
                "duration_seconds": duration
            }
            
    except subprocess.TimeoutExpired:
        return {
            "task_id": task_id,
            "status": "timeout",
            "error": "Task exceeded 5 minute timeout"
        }
    except Exception as e:
        return {
            "task_id": task_id,
            "status": "error",
            "error": str(e)
        }


def dispatch_parallel(tasks: list[dict], max_workers: int = MAX_WORKERS) -> list[dict]:
    """Run multiple Claude tasks in parallel."""
    results = []
    total = len(tasks)
    
    log(f"Dispatching {total} tasks with {max_workers} workers...")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_task = {
            executor.submit(run_claude_worker, task): task 
            for task in tasks
        }
        
        for i, future in enumerate(as_completed(future_to_task), 1):
            task = future_to_task[future]
            task_id = task.get("task_id", "unknown")
            
            try:
                result = future.result()
                results.append(result)
                status = result.get("status", "unknown")
                log(f"  [{i}/{total}] {task_id}: {status}")
            except Exception as e:
                results.append({
                    "task_id": task_id,
                    "status": "error",
                    "error": str(e)
                })
                log(f"  [{i}/{total}] {task_id}: error - {e}")
    
    return results


def process_task_file(task_file: Path) -> dict:
    """Process a single task file."""
    task = json.loads(task_file.read_text())
    
    # Check if it's a batch of tasks or single task
    if "tasks" in task:
        # Batch mode
        results = dispatch_parallel(task["tasks"])
        
        output = {
            "batch_id": task.get("batch_id", task_file.stem),
            "status": "completed",
            "results": results,
            "completed_at": datetime.now().isoformat()
        }
    else:
        # Single task
        result = run_claude_worker(task)
        output = result
    
    # Save result
    result_file = RESULTS_DIR / f"{task_file.stem}_result.json"
    result_file.write_text(json.dumps(output, indent=2))
    
    # Move task to completed
    completed_file = TASKS_COMPLETED / task_file.name
    task_file.rename(completed_file)
    
    return output


def process_pending_tasks():
    """Process all pending task files."""
    setup_dirs()
    
    pending_files = list(TASKS_PENDING.glob("*.json"))
    
    if not pending_files:
        log("No pending tasks found.")
        return
    
    log(f"Found {len(pending_files)} pending task(s)")
    
    for task_file in pending_files:
        log(f"Processing: {task_file.name}")
        try:
            result = process_task_file(task_file)
            log(f"  Completed. Result saved.")
        except Exception as e:
            log(f"  Error: {e}")


def watch_mode():
    """Continuously watch for and process new tasks."""
    setup_dirs()
    log("Starting watch mode...")
    log(f"Watching: {TASKS_PENDING}")
    log("Press Ctrl+C to stop")
    print("-" * 50)
    
    try:
        while True:
            # Check for abort signal
            if (SIGNALS_DIR / "abort.flag").exists():
                log("Abort signal received. Stopping.")
                break
            
            pending_files = list(TASKS_PENDING.glob("*.json"))
            
            if pending_files:
                for task_file in pending_files:
                    log(f"Processing: {task_file.name}")
                    try:
                        process_task_file(task_file)
                        log(f"  Completed.")
                    except Exception as e:
                        log(f"  Error: {e}")
            
            time.sleep(POLL_INTERVAL)
            
    except KeyboardInterrupt:
        log("Stopped by user.")


def main():
    global MAX_WORKERS

    parser = argparse.ArgumentParser(description="Claude Worker Dispatcher")
    parser.add_argument("--watch", action="store_true", help="Watch mode (continuous)")
    parser.add_argument("--task", type=str, help="Process a specific task file")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS, help="Max parallel workers")

    args = parser.parse_args()
    MAX_WORKERS = args.workers
    
    print("=" * 50)
    print("Claude Worker Dispatcher")
    print("=" * 50)
    
    validate_claude_cli()
    
    if args.task:
        task_file = Path(args.task)
        if not task_file.exists():
            print(f"Error: Task file not found: {args.task}")
            sys.exit(1)
        log(f"Processing single task: {task_file}")
        result = process_task_file(task_file)
        print(json.dumps(result, indent=2))
    elif args.watch:
        watch_mode()
    else:
        process_pending_tasks()


if __name__ == "__main__":
    main()
