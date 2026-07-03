# Experiment: CLI worker dispatcher (superseded)

Before the MCP browser orchestrator, we tested a different mechanism for the same goal: **fan work out to headless Claude Code CLI worker sessions** instead of driving chat web UIs.

## What's here

| File | Role |
|------|------|
| `dispatcher.py` | File-based task dispatcher: reads task JSON from `tasks/pending/`, spawns parallel Claude Code CLI workers (`ThreadPoolExecutor`), writes results to `results/` |
| `watchdog.py` | Polls the task directories and nudges stalled tasks |
| `test_claude_*.py`, `test_resolution*.py`, `validate_claude.py`, `test_dispatcher_fix.py` | The diagnostic scripts that pinned down how to invoke the CLI correctly |

## What we learned

1. **Prompts must go in via stdin, not as a CLI argument.** `claude -p "<prompt>" --output-format json` hangs; `echo "<prompt>" | claude -p --output-format json` works. The dispatcher was fixed accordingly (`dispatcher.py` passes `input=prompt` to `subprocess.run`).
2. **Invoke the CLI by explicit path.** Bare `claude` can resolve to a different executable on PATH and silently produce empty output (set `CLAUDE_CODE_CLI` to your install, e.g. `~/.local/bin/claude`).
3. **Parallel dispatch works.** Two concurrent CLI workers completed independent tasks with no interference and near-perfect overlap.

## Why it was superseded

The CLI-worker approach costs API tokens per worker and can't leverage existing chat subscriptions, and the file-based task protocol added coordination overhead. The project moved to the [MCP browser orchestrator](../../mcp-orchestrator/) (drive already-authenticated chat UIs over CDP). The CLI-worker idea itself matured into a separate project (a parallel dev pipeline with planner/critic/executor roles).

## Status

Archived experiment — kept for reference, not maintained. Paths are placeholders; it was developed and run on Windows.
