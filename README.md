# Auto_Browser

Multi-model AI orchestrator: drives **Claude, ChatGPT, and Gemini in parallel** through a real Chrome session (via the Chrome DevTools Protocol) and runs autonomous consensus workflows across them, exposed as MCP tools for Claude Desktop.

## How it works

Instead of paying for three APIs, Auto_Browser attaches to a Chrome instance you're already logged into (`--remote-debugging-port=9222`), sends the same prompt to all three chat UIs simultaneously, collects the responses, and iterates rounds until the models converge. From round 2 on, each model sees the *other* models' answers (cross-pollination) and must end its reply with a machine-readable `VERDICT: AGREE` or `VERDICT: DISAGREE` line; consensus is declared when at least two models cast an unhedged AGREE and none dissent.

## Components

| Path | What it is |
|------|------------|
| `mcp-orchestrator/` | **The main component.** Node.js MCP server exposing 31 tools: the consensus workflow (`start_consensus`, `send_single_round`, …), 18 general browser-automation tools, and a task queue. See its [README](mcp-orchestrator/README.md). |
| `experiments/cli-dispatcher/` | The earlier approach we tested: fan work out to parallel Claude Code CLI worker sessions instead of browser automation. Archived with its findings — see its [README](experiments/cli-dispatcher/README.md). |

## Quick start

Runs anywhere Chrome and Node.js ≥ 20 run.

1. **Start Chrome with remote debugging** — or don't: the server auto-launches a debug Chrome on first connect (disable with `AUTO_LAUNCH_CHROME=0`). The profile lives at `~/.auto-browser/chrome-profile`, outside the repo — it holds real browser credentials.

   Manual start, macOS / Linux:
   ```bash
   mcp-orchestrator/scripts/start-chrome-debug.sh
   ```
   Manual start, Windows:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.auto-browser\chrome-profile"
   ```

2. **Log in** to claude.ai, chatgpt.com, and gemini.google.com in that Chrome instance (once — sessions persist in the profile).

3. **Register the MCP server** in `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):
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

Send latency was optimized 20× (15s → 0.75s per model) via parallel dispatch (`Promise.all`) and single-event text insertion (CDP `insertText` — no OS clipboard, no per-keystroke typing), with pre-captured message counts and verified streaming indicators; a full consensus round runs in under 20s.

## Development

```bash
cd mcp-orchestrator
npm ci
npm test                  # Chrome-free unit suite (runs in CI)
npm run test:integration  # requires a debug Chrome with logged-in tabs
```

## Status

Functional prototype under active development (July 2026).

## License

MIT — see [LICENSE](LICENSE).
