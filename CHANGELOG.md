# Changelog

All notable changes to Auto_Browser are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The whole repo ships a
single version, sourced from `mcp-orchestrator/package.json`.

## [3.2.0] — 2026-07-06

Feature release on top of 3.1.0. **No breaking changes to the MCP tool API** — it
adds the deep-research pipeline, per-task model selection, and operational
hardening. The public tool count grows from **31 to 37**.

### Added

- **Deep-research batch pipeline** — six MCP tools (`research_submit_batch`,
  `research_status`, `research_collect`, `research_synthesize`, `research_export`,
  `quota_status`). Submit a batch of research prompts, route them across providers
  under a persisted per-provider daily quota ledger, drain them with a headless
  runner that survives restarts, and synthesize one final report per task.
- **Spend-safety as a design invariant** — a task seals `spent` *before* the send
  click and thereafter resumes its chat (re-open URL, re-harvest) rather than
  re-running, so a paid deep-research run is never doubled and completed reports
  stay re-harvestable for free.
- **Report harvesting for real provider UIs** — ChatGPT deep-research reports
  render in a sandboxed cross-origin iframe and are extracted frame-aware; Claude's
  full report lives in an expandable Document artifact and is captured in full (not
  just the preview); Gemini's research-plan confirmation is cleared automatically.
  Provider pre-generation gates are cleared from live-discovered registry selectors
  (`generationGates`) plus a "produce the full report now" prompt preamble.
- **Per-task model selection** — every send resolves an explicit model
  (per-call → per-task → configured default); pickers are discovered live and
  verified after selection; an unavailable model degrades to a typed warning +
  default, never a silent guess.
- **Provider registry** — `models/registry.js` is the single source of provider
  descriptors (URL patterns, selectors, capabilities, research profile, quotas),
  overridable per key via `~/.auto-browser/registry.json` (deep-merged, validated
  loudly). Adding a provider is a descriptor, not code.
- **Operational tooling** — Chrome auto-launch on first connect; a read-only stats
  CLI (`scripts/stats.js`) for quota, latency, and batch status; context
  compression of oversized peer text before cross-pollination (~6× observed);
  advisory rate-limiter and per-model latency stats (p50/p95/max/timeouts).
- **Send verification** — a two-phase receipt+release send path that confirms the
  user message actually landed before waiting on a response.
- **Project docs** — MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and GitHub
  issue templates.

### Changed

- **State and the Chrome debug profile now live outside the repo**, under
  `~/.auto-browser/` (profile, consensus state, research artifacts, quota ledger),
  so nothing credential-bearing is ever near version control.
- `config.js` selector/pattern/entry maps are now read-only **views** over
  `models/registry.js` rather than independent definitions.
- Per-round **login gating**: a tab sitting on a login/auth URL fails fast as
  `login_expired` instead of burning a response timeout.

### Fixed

- Hardening pass that closed a set of correctness bugs found in review: a
  `Browser.disconnect()` connection leak, provider error strings leaking into
  cross-pollination (now quarantined — peers see a neutral "did not respond"
  note), an unguarded state `loadState`, a missing single-flight run guard, and a
  Windows-only default Chrome path that broke macOS auto-launch.

### Tested

- A **22-file Chrome-free unit suite** runs in CI on Node 20 and 22 (`npm test`;
  22 passed / 0 failed / 0 skipped). Live end-to-end gates (parallel-send
  isolation, consensus, cold-start, double-start, crash-boot, and the
  deep-research flows per provider) were run against the real sites during
  development from `scripts/e2e/`; they require your own logged-in Chrome and never
  run in CI.

### Platform

- macOS is live-proven end to end. Windows and Linux Chrome paths are configured
  but currently untested since the migration to macOS.

---

History before 3.2.0 predates this changelog; see the git log for details.
