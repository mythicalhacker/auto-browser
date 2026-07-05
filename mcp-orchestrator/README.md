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
| `REGISTRY_FILE` | `~/.auto-browser/registry.json` | Provider registry override (deep-merged over the built-in descriptors) |
| `RESEARCH_HOME` | `~/.auto-browser/research` | Deep-research queue + artifacts |
| `QUOTA_FILE` | `~/.auto-browser/quotas.json` | Per-provider deep-research quota ledger |
| `PROMPTS_DIR` | `~/.auto-browser/prompts` | Location of `compilation.md` (synthesis prompt template) |
| `DR_TIMEOUT_MS` | `5400000` (90 min) | Per-deep-research wait ceiling |

**Registry override.** Every provider fact (URL patterns, selectors, model choices, per-day deep-research cap, research profile) lives in `models/registry.js` and can be overridden per key via `~/.auto-browser/registry.json`. Objects deep-merge; arrays and scalars replace. Adding a fourth provider needs only a complete descriptor. Invalid overrides refuse to boot with every problem listed. Example — bump Gemini's daily deep-research cap and point Claude at a different default research model:

```json
{
  "gemini": { "quotas": { "deepResearchPerDay": 8 } },
  "claude": { "research": { "model": "Opus 4.8" } }
}
```

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

**Deep-research batches** — submit many research prompts, run each through the providers' deep-research mode, and synthesize:

| Tool | Description |
|------|-------------|
| `research_submit_batch` | Queue an array of `{prompt, project?, gemini_priority?}`. `gemini_priority` tasks run on Gemini (daily-capped) + Claude + ChatGPT; others on Claude + ChatGPT |
| `research_status` | Per task × provider status table (queued / running / complete / awaiting_quota / paused_flagged / blocked_login / failed) |
| `research_collect` | Show a task's collected reports with on-disk artifact paths |
| `research_synthesize` | Compile a task's reports (≥ 2) into one final report via a compilation round + verdict rounds (long-running; holds a drain lock) |
| `research_export` | Return the synthesized `FINAL.md` for a task |
| `quota_status` | Per-provider deep-research quota: today's count vs cap, cooldowns, eligibility |

## Monitoring

`scripts/stats.js` is a zero-dependency, read-only CLI for persisted quota,
latency, and batch artifact status:

```bash
node scripts/stats.js
node scripts/stats.js --json
node scripts/stats.js --batch batch-2026-07-05-a1b2c3
AUTO_BROWSER_HOME=/tmp/ab-state node scripts/stats.js --batch ~/.auto-browser/research/batch-2026-07-05-a1b2c3 --json
```

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

### Deep-research batches

Submit a batch of research prompts, run each through the providers' deep-research mode unattended, then synthesize one final report per task.

**1. Submit (from a Claude session, via MCP).** For a ~37-prompt batch where the top 5 should also run on Gemini:

```
research_submit_batch({ items: [
  { prompt: "…prompt 1…", gemini_priority: true },
  { prompt: "…prompt 2…", gemini_priority: true },
  …                                                  # 5 gemini-priority
  { prompt: "…prompt 6…" },                          # standard: Claude + ChatGPT
  …                                                  # 32 standard
]})
```

`gemini_priority` tasks run on Gemini **and** Claude **and** ChatGPT; the rest on Claude + ChatGPT. Optional `project` runs the task inside a provider project/notebook (missing project → a typed `project_not_found` warning and a normal chat).

**2. Drain it (headless — no MCP attach needed).** Keep the Mac awake and the sites logged in:

```bash
caffeinate -dims node scripts/run-queue.js --batch=<batch-id>
```

The runner drives each provider serially (one tab, one run at a time), providers in parallel. It enables deep-research mode, verifies the send, and waits for the report. Deep-research prompts are prefixed with a "don't ask clarifying questions, produce the full report now" directive so runs don't stall waiting for a scoping reply. On a quota/limit banner a provider goes on **cooldown** and its tasks become `awaiting_quota`; the runner sleeps until the reset and resumes. A **paid run is never lost**: its chat URL is recorded the moment it starts, and a task that already spent resumes by re-opening that chat rather than re-running. Check progress any time with `research_status` or `node scripts/run-queue.js --status`.

**3. Synthesize + export.** Once a task has ≥ 2 reports:

```
research_synthesize({ task_id: "<id>" })   # compilation + verdict rounds → FINAL.md
research_export({ task_id: "<id>" })        # returns the final report
```

or headless for the whole batch: `node scripts/run-queue.js --synthesize --batch=<id>` (skips tasks that already have a `FINAL.md` unless `--force`).

**Wall-time honesty.** A real batch is long even when everything works. ~32 tasks × 2 providers × 15–45 min each, serial per provider, is **multiple days of runtime** — plus Gemini's ~5 deep-research/day trickle for the priority set, and provider limits that can appear on Claude/ChatGPT too. The persisted queue + cooldown auto-resume + headless runner exist precisely so this needs no babysitting — but the Mac must stay awake (`caffeinate`) and the sites logged in. Watch the daily Gemini budget with `quota_status`.

**Known limitation (deep-research pre-generation gates).** As of July 2026, Claude and ChatGPT deep research each open with a UI step *before* generating — Claude shows a "which connectors to enable" modal after send; ChatGPT may pose a scoping question. The runner already prefixes each prompt with a "don't ask clarifying questions, produce the full report now" directive, but a *modal* can't be dismissed by prompt text — clicking through these gates needs a provider-specific driver step (live-discovered selector + a post-send `ensureChat` action). Until that lands, unattended deep-research runs can stall at this gate and time out (the run is marked `failed` with its chat URL preserved, never a fabricated report, never a double-spend). The consensus/synthesis paths are unaffected. Track this before running the full 37-prompt batch.

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
node scripts/e2e/run-e2e.js --gates=drivers --live      # ensureChat: projects/models/modes (set E2E_PROJECT_NAME)
node scripts/e2e/run-e2e.js --gates=researchdr --live   # 2 real deep-research runs through the queue (spends DR quota)
```
