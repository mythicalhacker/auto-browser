"""
Simple Task Watcher for Claude Terminal
Polls the pending tasks folder and processes them.

Usage: Run this in Claude Terminal:
  python watchdog.py

Or ask Claude Terminal to:
  "Run the watchdog script at <path-to>/watchdog.py"
"""

import json
import os
import time
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent
TASKS_PENDING = BASE_DIR / "tasks" / "pending"
TASKS_IN_PROGRESS = BASE_DIR / "tasks" / "in_progress"
TASKS_COMPLETED = BASE_DIR / "tasks" / "completed"
SIGNALS_DIR = BASE_DIR / "signals"
POLL_INTERVAL = 5  # seconds

def setup_dirs():
    """Create required directories if they don't exist."""
    for d in [TASKS_PENDING, TASKS_IN_PROGRESS, TASKS_COMPLETED, SIGNALS_DIR]:
        d.mkdir(parents=True, exist_ok=True)

def update_status(status: str, current_task: str = None):
    """Update watchdog status file."""
    status_file = SIGNALS_DIR / "watchdog_status.json"
    status_file.write_text(json.dumps({
        "status": status,
        "current_task": current_task,
        "last_update": datetime.now().isoformat(),
        "pid": os.getpid()
    }, indent=2))

def check_abort():
    """Check if abort flag exists."""
    return (SIGNALS_DIR / "abort.flag").exists()

def get_pending_tasks():
    """Get list of pending task files sorted by priority."""
    if not TASKS_PENDING.exists():
        return []
    
    tasks = []
    for f in TASKS_PENDING.glob("*.json"):
        try:
            task = json.loads(f.read_text())
            task["_file"] = f
            tasks.append(task)
        except:
            pass
    
    # Sort by priority (lower = higher priority)
    return sorted(tasks, key=lambda t: t.get("priority", 5))

def process_task(task: dict):
    """
    Process a single task.
    
    This is where Claude Terminal would actually execute the task.
    For now, this just moves the file and writes a placeholder result.
    
    In practice, this script would be run BY Claude Terminal,
    and Claude would handle the actual task execution.
    """
    task_file = task["_file"]
    task_id = task.get("task_id", task_file.stem)
    
    # Move to in_progress
    in_progress_file = TASKS_IN_PROGRESS / task_file.name
    task_file.rename(in_progress_file)
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Processing: {task_id}")
    print(f"  Type: {task.get('type', 'unknown')}")
    print(f"  Instruction: {task.get('instruction', 'N/A')[:100]}...")
    
    # This is where actual processing would happen
    # Claude Terminal would interpret the instruction and execute it
    
    # For demo: just mark as needing Claude Terminal attention
    result = {
        "task_id": task_id,
        "status": "requires_claude_terminal",
        "message": "Watchdog detected task. Claude Terminal should process this.",
        "original_task": task,
        "detected_at": datetime.now().isoformat()
    }
    
    # Write result
    result_file = TASKS_COMPLETED / f"{task_id}_result.json"
    result_file.write_text(json.dumps(result, indent=2, default=str))
    
    # Clean up in_progress
    if in_progress_file.exists():
        in_progress_file.unlink()
    
    print(f"  -> Marked for Claude Terminal processing")
    return result

def main():
    """Main watchdog loop."""
    print("=" * 50)
    print("Claude Orchestrator - Task Watchdog")
    print("=" * 50)
    print(f"Watching: {TASKS_PENDING}")
    print(f"Poll interval: {POLL_INTERVAL}s")
    print("Press Ctrl+C to stop")
    print("-" * 50)
    
    setup_dirs()
    update_status("running")
    
    try:
        while True:
            if check_abort():
                print("\n[!] Abort flag detected. Shutting down.")
                update_status("aborted")
                break
            
            tasks = get_pending_tasks()
            
            if tasks:
                for task in tasks:
                    update_status("processing", task.get("task_id"))
                    process_task(task)
                    
                    if check_abort():
                        break
            else:
                update_status("idle")
            
            time.sleep(POLL_INTERVAL)
            
    except KeyboardInterrupt:
        print("\n[!] Interrupted by user")
        update_status("stopped")
    except Exception as e:
        print(f"\n[!] Error: {e}")
        update_status("error", str(e))

if __name__ == "__main__":
    main()
