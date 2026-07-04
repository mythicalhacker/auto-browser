# MCP Orchestrator

Multi-model consensus orchestration for Claude, ChatGPT, and Gemini.

## Setup

### 1. Install dependencies (Node.js ≥ 20)
```bash
cd <path-to>/Auto_Browser/mcp-orchestrator
npm ci
```

### 2. Start Chrome with debugging enabled

Usually you can skip this step: the server **auto-launches** a debug Chrome on
first connect (disable with `AUTO_LAUNCH_CHROME=0`). The profile lives at
`~/.auto-browser/chrome-profile` — outside the repo, since it holds real
browser credentials.

Manual start, macOS / Linux:
```bash
scripts/start-chrome-debug.sh
```

Manual start, Windows:
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.auto-browser\chrome-profile"
```

### 3. Log into the model sites
On a cold start the server opens the three model tabs itself; log in once to
each (sessions persist in the profile):
- https://claude.ai
- https://chatgpt.com
- https://gemini.google.com

### 4. Add to Claude Desktop config
Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

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

### 5. Restart Claude Desktop

---

## Configuration (environment variables)

All optional; defaults in `config.js`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CDP_URL` | `http://localhost:9222` | Chrome DevTools endpoint to attach to |
| `STATE_FILE` | `~/.auto-browser/consensus_state.json` | Where consensus state is persisted |
| `CHROME_PATH` | platform default (macOS/Windows/Linux) | Chrome binary for auto-launch |
| `CHROME_USER_DATA` | `~/.auto-browser/chrome-profile` | Debug profile dir (holds the site logins) |
| `AUTO_LAUNCH_CHROME` | `1` | Set `0` to never auto-launch Chrome on connect |
| `TIMEOUT_RESPONSE` | `120000` | Fallback max ms to wait for a model's response |
| `TIMEOUT_RESPONSE_CLAUDE` | `300000` | Per-model response ceiling (extended-thinking models take minutes) |
| `TIMEOUT_RESPONSE_CHATGPT` | `600000` | Per-model response ceiling |
| `TIMEOUT_RESPONSE_GEMINI` | `300000` | Per-model response ceiling |
| `TIMEOUT_NAVIGATION` | `30000` | Page navigation timeout (ms) |
| `TIMEOUT_ACTION` | `10000` | Click/selector action timeout (ms) |

---

## Tools

**Consensus** — the core workflow:

| Tool | Description |
|------|-------------|
| `connect_browser` | Connect to Chrome on CDP port 9222 |
| `health_check` | Chrome connection, tabs, login state, per-platform send counts, and persisted response-latency stats (p50/p95/max/timeouts per model) |
| `send_single_round` | Send prompt to all 3 models and wait for responses (single round) |
| `start_consensus` | Start autonomous consensus workflow (iterates until agreement; `max_rounds` 2–10, default 5; optional `response_timeout_ms` per-call ceiling for deep-research prompts) |
| `get_consensus_status` | Check current consensus workflow status and progress |
| `get_consensus_results` | Get full results from completed or in-progress workflow |
| `get_last_round` | Get just the last round's outputs |

**Browser automation** — 18 general-purpose `browser_*` tools for driving the connected Chrome directly: navigation (`browser_navigate`, `browser_back`, `browser_forward`, `browser_new_tab`, `browser_close_tab`, `browser_tabs`), interaction (`browser_click`, `browser_type`, `browser_hover`, `browser_select`, `browser_press_key`, `browser_wait`, `browser_file_upload`), and inspection (`browser_get_text`, `browser_get_html`, `browser_screenshot`, `browser_snapshot`, `browser_evaluate`).

**Task queue & dispatch** — queue prompts as background tasks: `task_submit`, `task_status`, `task_list`, `task_cancel`, plus `task_run` / `task_run_all` for direct dispatch.

---

## The verdict protocol

From round 2 on, every model is asked to end its response with a standalone line:

```
VERDICT: AGREE     (or)     VERDICT: DISAGREE
```

- A verdict only counts on its own line — instruction echoes, prose mentions, and error strings never match.
- `AGREE` must be unhedged (a qualified agree is an abstention); `DISAGREE` tolerates a trailing clause so a hedged dissent still blocks.
- Consensus requires **≥ 2 AGREE votes and zero DISAGREE** among models that responded.
- Peer verdict lines are stripped before responses are cross-pollinated, so a quoted answer can't cast a spurious vote.
- Failed models are quarantined: their error text never enters cross-pollination or results — peers see a neutral "did not respond this round" note instead.
- Dissent is sticky across failures: if a model's last cast vote was DISAGREE and it fails a later round, its dissent still blocks consensus until it responds again.
- Runs abort immediately with `insufficient_models` when fewer than 2 model tabs are open.

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
- The server normally auto-launches Chrome; if that's disabled (`AUTO_LAUNCH_CHROME=0`), start it with `--remote-debugging-port=9222`
- Use a separate `--user-data-dir` from your default profile
- Close other Chrome instances first

**Tab not found**
- Make sure tabs are open for: claude.ai, chatgpt.com, gemini.google.com
- Run `connect_browser` to see connection status

**Selectors not working**
- Sites update their UI often; selectors are defined in `config.js`
- Run `node tests/integration/test-selectors.js` (needs the debug Chrome running) to check them

---

## Tests

```bash
npm test                        # Chrome-free unit suite (what CI runs)
npm run test:integration        # Chrome-bound integration tests
node tests/run-all.js --quick   # unit + integration (skips the e2e consensus test)
node tests/run-all.js           # full suite — requires Chrome with fresh chat tabs
node scripts/e2e/run-e2e.js --gates=handshake,validation,corruptboot   # MCP-protocol e2e (Chrome-free)
```

Live e2e gates (require ≥ 2 logged-in models; 30-messages/site budget ledger built in):
```bash
node scripts/e2e/run-e2e.js --gates=logins,race,agreeable,verdictstrip,timeout,doublestart,compression --live
node scripts/e2e/run-e2e.js --gates=coldstart --live   # needs NO Chrome on :9222
```
