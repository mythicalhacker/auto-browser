# Auto_Browser

**Multi-model consensus and deep-research orchestration over your own browser.**

Auto_Browser is an MCP server that drives **Claude, ChatGPT, and Gemini through their web UIs in parallel** — a real Chrome session over the Chrome DevTools Protocol, using the subscriptions you already pay for. It runs cross-pollinated consensus rounds between the models and orchestrates multi-provider deep-research batches: submit a set of research prompts, route them across providers under quota limits, harvest the reports, and synthesize one final report per task.

Exposed as MCP tools, so you can run all of this from Claude Desktop (or any MCP client).

## How it works

Instead of paying for three APIs, Auto_Browser attaches to a Chrome instance you're already logged into (`--remote-debugging-port=9222`), sends the same prompt to all three chat UIs simultaneously, collects the responses, and iterates rounds until the models converge. From round 2 on, each model sees the *other* models' answers (cross-pollination) and ends its reply with a machine-readable `VERDICT: AGREE` or `VERDICT: DISAGREE` line; consensus is declared when at least two models cast an unhedged AGREE and none dissent.

The deep-research pipeline extends the same idea to each provider's *deep-research mode*: a persisted, quota-aware queue runs research prompts unattended, harvests the reports (including provider UIs that resist naive scraping), and compiles them into a synthesized final report.

## Components

| Path | What it is |
|------|------------|
| [`mcp-orchestrator/`](mcp-orchestrator/) | **The main component.** Node.js MCP server exposing **37 tools**: the consensus workflow (7), 18 general browser-automation tools, a task queue (6), and the deep-research batch pipeline (6). See its [README](mcp-orchestrator/README.md) for full setup, tools, env vars, and the verdict protocol. |

## Quick start

Node.js ≥ 20. macOS is the live-proven platform (see **Platform status** below).

1. **Start Chrome with remote debugging** — or don't: the server auto-launches a debug Chrome on first connect (disable with `AUTO_LAUNCH_CHROME=0`). The profile lives at `~/.auto-browser/chrome-profile`, outside the repo — it holds real browser credentials, so never commit or share it.

   Manual start, macOS / Linux:
   ```bash
   mcp-orchestrator/scripts/start-chrome-debug.sh
   ```
   Manual start, Windows:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.auto-browser\chrome-profile"
   ```

2. **Log in** to claude.ai, chatgpt.com, and gemini.google.com in that Chrome instance (once — sessions persist in the profile).

3. **Install and register the MCP server** in `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):
   ```bash
   cd mcp-orchestrator && npm ci
   ```
   ```json
   {
     "mcpServers": {
       "orchestrator": {
         "command": "node",
         "args": ["/absolute/path/to/Auto_Browser/mcp-orchestrator/server.js"]
       }
     }
   }
   ```

4. From Claude Desktop: `connect_browser` → `start_consensus({ prompt: "your question" })` → `get_consensus_results`.

## Performance

Sends go out to all three providers **in parallel** (`Promise.all`) via a single Chrome DevTools `insertText` event — no per-keystroke typing and no OS clipboard, with pre-captured message counts and verified streaming indicators. A round's wall-clock is bound by the *slowest model's response*, not by send overhead or the orchestrator.

Observed response latencies on the tested personal accounts (ordinary sends, not deep research): Claude ≈ 8–13 s, Gemini ≈ 9–20 s, ChatGPT ≈ 44–120 s+ with extended thinking. Deep-research runs legitimately take minutes to tens of minutes each. When peer responses are large, they are compressed (~6× observed) before being cross-pollinated into the next round.

## Monitoring

`mcp-orchestrator/scripts/stats.js` is a zero-dependency, read-only CLI for persisted quota, latency, and batch-artifact status (`node scripts/stats.js`, `--json`, `--batch <id>`). See the [component README](mcp-orchestrator/README.md#monitoring).

## Tested how

A **22-file Chrome-free unit suite** runs in CI on Node 20 and 22 (`npm test`). Live end-to-end gates — parallel-send isolation, consensus, cold-start, double-start, crash-boot, and the deep-research flows per provider — were run against the real sites during development from the gate scripts in `mcp-orchestrator/scripts/e2e/`. Those gates require your own logged-in Chrome and **never run in CI**.

## Terms of service & risk disclaimer

This project **automates provider web UIs**. It is **not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or Google.** Browser automation of these sites may be restricted by each provider's terms of service. Run it only against **your own personal, paid accounts, at your own risk** — you are responsible for compliance with each provider's terms and for any consequences to your accounts. Deep research **spends real quota and money**; the queue is built to respect caps and never double-spend, but the spending is real. The software is provided "as is", without warranty, under the [MIT License](LICENSE).

## Platform status

**macOS is live-proven end to end.** Windows and Linux Chrome paths are configured but currently untested since the project's migration to macOS — expect to adjust the Chrome binary path (`CHROME_PATH`) and debug them before relying on them there.

## Support

- **Bugs and feature requests:** open an issue using the [templates](.github/ISSUE_TEMPLATE/). The bug template asks for provider and UI-drift context; please **never paste profile paths, cookies, or session data** into a public issue.
- **Security concerns:** report privately via GitHub security advisories — see [SECURITY.md](SECURITY.md). Never file a public issue that contains session or profile data.

## Roadmap

Prompt-injection fencing of peer outputs · API-fallback driver · new providers as registry descriptors (descriptor-only) · Windows/Linux re-validation.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 mythicalhacker.
