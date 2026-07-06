# Security Policy

## Supported versions

Security fixes target the latest release line (currently **3.2.x**). Please upgrade
to the newest tag before reporting.

## Reporting a vulnerability

**Report privately — do not open a public issue for anything security-sensitive.**

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab
→ **Report a vulnerability** (GitHub Security Advisories). That opens a private
channel with the maintainer. Please include a clear description, affected version,
and minimal reproduction steps, and give a reasonable window to respond before any
public disclosure.

### Never include session or profile data

When reporting — or in **any** public issue, discussion, log, or screenshot — never
paste:

- Chrome **profile paths or their contents** (`~/.auto-browser/chrome-profile/`),
- **cookies, tokens, or `Authorization` headers**,
- **real conversation URLs** (`claude.ai/chat/…`, `chatgpt.com/c/…`,
  `gemini.google.com/app/…`),
- account identifiers or any other session data.

If a reproduction seems to require session data, **describe** it instead of pasting
it, and we'll work out a safe way to reproduce.

## Security model — what you should know

- **The Chrome debug profile holds real logins.** It lives outside the repo at
  `~/.auto-browser/chrome-profile` and is git-ignored. Never commit or share it;
  anyone with that directory has your provider sessions.
- **This tool automates your authenticated accounts.** It sends prompts on your
  behalf and can spend real deep-research quota/money. Run it only against your own
  personal accounts, and be aware that browser automation may be restricted by each
  provider's terms of service.
- **Peer outputs are not yet injection-fenced.** In consensus rounds, each model
  sees the other models' responses. Prompt-injection fencing of that cross-pollinated
  content is on the roadmap but **not yet implemented** — treat model outputs as
  untrusted input, especially if a prompt pulls in external/web content.
- **Advisory limits.** The rate-limiter and latency stats are advisory and
  single-machine; they are not a security control.

Thank you for helping keep users safe.
