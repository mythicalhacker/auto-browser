# Auto_Browser

Multi-model AI orchestrator: drives **Claude, ChatGPT, and Gemini in parallel** through a real Chrome session (via the Chrome DevTools Protocol) and runs autonomous consensus workflows across them, exposed as MCP tools for Claude Desktop.

## How it works

Instead of paying for three APIs, Auto_Browser attaches to a Chrome instance you're already logged into (`--remote-debugging-port=9222`), sends the same prompt to all three chat UIs simultaneously, collects the responses, and iterates rounds until the models converge on a consensus answer.

## Components

| Path | What it is |
|------|------------|
| `mcp-orchestrator/` | **The main component.** Node.js MCP server exposing consensus tools (`start_consensus`, `send_single_round`, …), 18 general browser-automation tools, and a task queue. See its [README](mcp-orchestrator/README.md). |
| `experiments/cli-dispatcher/` | The earlier approach we tested: fan work out to parallel Claude Code CLI worker sessions instead of browser automation. Archived with its findings — see its [README](experiments/cli-dispatcher/README.md). |

## Quick start

Developed and run on **Windows** (paths in configs assume it); the approach works anywhere Chrome runs.

1. **Start Chrome with remote debugging** (or run `mcp-orchestrator/start-chrome-debug.bat`):
   ```powershell
   chrome.exe --remote-debugging-port=9222 --user-data-dir=<dedicated-profile-dir>
   ```
   Use a dedicated profile directory and keep it out of version control — it holds real browser credentials.

2. **Log in** to claude.ai, chatgpt.com, and gemini.google.com in that Chrome instance.

3. **Register the MCP server** in `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "orchestrator": {
         "command": "node",
         "args": ["<path-to>/Auto_Browser/mcp-orchestrator/server.js"]
       }
     }
   }
   ```

4. From Claude Desktop: `connect_browser` → `start_consensus("your question")` → `get_consensus_results`.

## Performance

Send latency was optimized 20× (15s → 0.75s per model) via parallel dispatch (`Promise.all`), clipboard-paste input, and pre-captured message counts with verified streaming indicators; a full consensus round runs in under 20s.

## Status

Functional prototype, last actively developed February 2026.

## License

MIT — see [LICENSE](LICENSE).
