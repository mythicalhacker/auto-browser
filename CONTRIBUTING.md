# Contributing to Auto_Browser

Thanks for your interest. Auto_Browser drives real, logged-in provider web UIs, so
contributing has a couple of wrinkles that ordinary Node projects don't — please
read the testing section before opening a PR.

## Prerequisites

- **Node.js ≥ 20** (CI runs 20 and 22).
- **Google Chrome** (or Chromium) for anything that talks to a browser.
- Your **own** accounts on claude.ai, chatgpt.com, and gemini.google.com for the
  live tests. Never automate against an account that isn't yours.

## Setup

The product lives in `mcp-orchestrator/`.

```bash
cd mcp-orchestrator
npm ci
```

State, the Chrome debug profile, and research artifacts live **outside the repo**
under `~/.auto-browser/`. Nothing credential-bearing should ever be added to version
control (see [SECURITY.md](SECURITY.md)).

## Tests

### Unit suite — what CI runs

```bash
npm test        # Chrome-free unit suite; 22 files
```

This is the gate every change must keep green. It is fully hermetic — no Chrome, no
network, no logged-in accounts — which is exactly why it can run in CI (Node 20/22).
Add or update unit tests alongside behavior changes.

### Chrome-bound and live e2e — never in CI

The integration and end-to-end tests attach to a **real debug Chrome with your own
logged-in tabs**. They cannot and must not run in CI: they need real sessions, some
of them **spend real deep-research quota and money**, and automating provider UIs is
your responsibility under each provider's terms. Run them locally, deliberately:

```bash
npm run test:integration        # Chrome-bound integration tests
node tests/run-all.js           # full suite — needs Chrome with fresh chat tabs
node scripts/e2e/run-e2e.js --gates=handshake,validation,corruptboot   # MCP-protocol e2e (Chrome-free)
node scripts/e2e/run-e2e.js --gates=logins,race,agreeable,verdictstrip,timeout,doublestart,compression --live
```

The `--gates=researchdr --live` gate runs real deep-research and **spends quota** —
only run it when you mean to.

## Selectors and provider UI drift

Provider UIs change often. Every selector lives in `models/registry.js`; you can
override any of them per key via `~/.auto-browser/registry.json` (deep-merged, no
code change needed) — that's usually the fastest fix for a broken flow. If you're
fixing selectors in the code itself, verify against a live Chrome with
`node tests/integration/test-selectors.js`.

## Code conventions

- **Parallel over sequential** (`Promise.all`) where independent.
- **Single-event text insertion** (CDP `insertText`) over per-keystroke typing or
  the OS clipboard.
- **STDIO safety:** runtime code uses `console.error` only — never `console.log`
  or `console.warn` (they corrupt the MCP stdio channel).
- **Evidence-based:** cite `file:line` for behavior claims; live-verify before
  claiming something works.
- Keep changes scoped and lean; avoid speculative abstractions.

## Pull requests

- Keep the unit suite green (`npm test`) and add tests for new behavior.
- Keep PRs focused; describe what you verified and how.
- Don't include anything from `~/.auto-browser/` — profiles, state, quota ledgers,
  or real conversation URLs. Use synthetic fixtures in tests.

## Reporting bugs and requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For anything security-sensitive,
follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
