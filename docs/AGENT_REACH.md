# Agent Reach (optional research tool)

Agent Reach is an MIT-licensed tool that installs and checks lightweight readers and search tools for public web pages, video
transcripts, GitHub, RSS, V2EX and some logged-in platforms. Meridian recommends it for operators who want research beyond the
app's own sources. It is vendored under `vendor/agent-reach/` at the commit recorded in `vendor/agent-reach/UPSTREAM.md`.

It is an operator tool. The Meridian app never calls it, never reads its configuration, and never reads its cookies.

## Running it

Run these from the repository root. The wrapper is `scripts/agent-reach.mjs`, and it needs Python 3.10 or newer.

| Command | What it does |
| --- | --- |
| `npm run agent-reach` | Checks the host and lists what is missing. Changes nothing. |
| `npm run agent-reach -- doctor` | Reports each channel's status. Makes read-only probe requests over the network. |
| `npm run agent-reach -- install --dry-run` | Shows what `--system` would change. Changes nothing. |
| `npm run agent-reach -- install --system --approve-system --channels=open` | Installs the chosen channels on this machine. Read the dry run first. |

The wrapper allows only `install` and `doctor`. Two flags are required for any system change: `--system`, and the wrapper's own
`--approve-system`. Proxy settings, cookie commands and uninstall are not run through the wrapper, so the operator runs them on the
host directly.

## What Meridian does not do

- **It does not bypass a bot check.** Meridian's own sources honour `robots.txt` and refuse a challenge page (`docs/REVAMP.md`,
  "Sourcing"). Agent Reach is a separate tool and Meridian does not route its fetches through it.
- **It does not set up proxies to avoid platform risk controls.** The upstream guide suggests residential proxies for servers that
  a platform restricts. The wrapper refuses `--proxy`, and Meridian does not recommend that setup.
- **It does not read cookies.** Some channels (Twitter/X, Reddit, Facebook, Instagram, Xueqiu, Xiaohongshu) need a login. The
  operator stores those cookies on the host with Agent Reach's own commands, ideally from a secondary account. Meridian does not
  store, read or send them, and no agent asks for them in chat.

The owner approved Agent Reach as a recommended tool on that basis. This is an exception to NORTH_STAR decision 1 ("agents never
receive keys"): the cookies stay on the operator's host, outside Meridian and outside its agents.

## Risks the operator accepts

- Logged-in use can get an account restricted. The upstream guide says so too.
- Some channels send requests through third parties. For example, the web reader sends each URL to `r.jina.ai`. Check the terms of
  each source before using it on client material.
- Video channels use `yt-dlp`, which downloads media. Use it only where the source's terms and the rights to the material allow.

## Not verified here

Only the check mode and `doctor` were run in the build environment, with the Python dependencies in a scratch environment. Live
behaviour of each channel against real sites was not tested.
