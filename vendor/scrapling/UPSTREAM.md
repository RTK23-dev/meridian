# Scrapling (vendored, parser subset)

- Source: https://github.com/D4Vinci/Scrapling
- Commit: 7a684934907a8c7feaafe9ff1ccfd9d45cc26faf
- Version: 0.4.15
- Licence: BSD 3-Clause (see LICENSE in this folder)

Meridian vendors only the HTML parser and its core helpers: `scrapling/parser.py` and `scrapling/core`. The fetchers, browser engines,
spiders, CLI, integrations, and the AI/shell tool definitions (`core/ai.py`, `core/shell.py`) are not vendored: those define the stealth
fetch options, and they are removed from this copy. Their stealth features (Cloudflare Turnstile solving, browser fingerprint
impersonation) are not part of Meridian's sourcing rules, so they are not included. See docs/AGENT_REACH.md and docs/REVAMP.md.
