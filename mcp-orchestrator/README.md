# MCP Orchestrator

Multi-model consensus orchestration for Claude, ChatGPT, and Gemini.

## Setup

### 1. Install dependencies
```powershell
cd "<path-to>\Auto_Browser\mcp-orchestrator"
npm install
```

### 2. Start Chrome with debugging enabled
```powershell
# Close all Chrome windows first, then:
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="<path-to>\chrome-debug-profile"
```

### 3. Open tabs in Chrome
Open these 3 tabs and log in:
- https://claude.ai
- https://chatgpt.com
- https://gemini.google.com

### 4. Add to Claude Desktop config
Edit: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["<path-to>\\Auto_Browser\\mcp-orchestrator\\server.js"]
    }
  }
}
```

### 5. Restart Claude Desktop

---

## Tools

**Consensus** — the core workflow:

| Tool | Description |
|------|-------------|
| `connect_browser` | Connect to Chrome on CDP port 9222 |
| `health_check` | Verify Chrome connection, tabs, and login state |
| `send_single_round` | Send prompt to all 3 models and wait for responses (single round) |
| `start_consensus` | Start autonomous consensus workflow (iterates until agreement) |
| `get_consensus_status` | Check current consensus workflow status and progress |
| `get_consensus_results` | Get full results from completed or in-progress workflow |
| `get_last_round` | Get just the last round's outputs |

**Browser automation** — 18 general-purpose `browser_*` tools for driving the connected Chrome directly: navigation (`browser_navigate`, `browser_back`, `browser_forward`, `browser_new_tab`, `browser_close_tab`, `browser_tabs`), interaction (`browser_click`, `browser_type`, `browser_hover`, `browser_select`, `browser_press_key`, `browser_wait`, `browser_file_upload`), and inspection (`browser_get_text`, `browser_get_html`, `browser_screenshot`, `browser_snapshot`, `browser_evaluate`).

**Task queue & dispatch** — queue prompts as background tasks: `task_submit`, `task_status`, `task_list`, `task_cancel`, plus `task_run` / `task_run_all` for direct dispatch.

---

## Workflow

### Single Round
1. `connect_browser` → verify Chrome connection
2. `send_single_round("Your question here")` → sends to all 3 models in parallel
3. Review responses from Claude, ChatGPT, and Gemini

### Autonomous Consensus
1. `connect_browser` → verify Chrome connection
2. `start_consensus({ prompt: "Your question", max_rounds: 5 })`
3. `get_consensus_status` → check progress
4. `get_consensus_results` → get final consensus when complete

The consensus workflow cross-pollinates responses: each model receives the OTHER two models' responses in subsequent rounds, iterating until agreement is reached.

---

## Troubleshooting

**"Failed to connect to Chrome"**
- Make sure Chrome is started with `--remote-debugging-port=9222`
- Use a separate `--user-data-dir` from your default profile
- Close other Chrome instances first

**Tab not found**
- Make sure tabs are open for: claude.ai, chatgpt.com, gemini.google.com
- Run `connect_browser` to see connection status

**Selectors not working**
- Sites update their UI often; selectors are defined in `config.js`
- Run `node tests/unit/test-selectors.js` to check them

---

## Tests

```bash
node tests/run-all.js --quick   # unit + integration (skips the e2e consensus test)
node tests/run-all.js           # full suite — requires Chrome connected with fresh chat tabs
```
