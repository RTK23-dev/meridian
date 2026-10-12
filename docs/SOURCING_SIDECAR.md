# Sourcing sidecar (Scrapling parser and Agent Reach channels)

The sidecar is a small local Python service in `sidecar/sourcing/`. It gives Meridian's sourcing two things from the upstream
projects, without rebuilding them:

- **Page parsing** from Scrapling (`vendor/scrapling`, BSD 3-Clause). The sidecar turns HTML that Meridian has already fetched into
  readable text and absolute links. Scripts, styles and other non-content tags are removed.
- **Public channels** from Agent Reach (`vendor/agent-reach`, MIT): the V2EX public API (hot and node topics) and RSS/Atom feed
  parsing with `feedparser`.

## The boundary, which the code enforces

The sidecar never fetches a URL it was given. Meridian's own fetch layer does every page request, and it still checks `robots.txt`,
refuses bot challenges and sends the truthful `MeridianBot/1.0` user agent. The sidecar only receives HTML or feed text that has
passed those checks. Its only outbound calls go to the fixed V2EX API host.

Two parts of the upstream projects are deliberately not used:

- Scrapling's stealth browser fetchers, which solve Cloudflare Turnstile challenges and impersonate browser fingerprints. Meridian
  does not solve challenges or get past bot checks (`docs/REVAMP.md`, "Sourcing"). Those modules are not vendored.
- Agent Reach's logged-in channels and proxy setup. Those stay on the operator's host, as described in `docs/AGENT_REACH.md`.

The sidecar also has no cookies, no proxy setting and no browser.

## Running it

1. Install the Python requirements: `python3 -m pip install -r sidecar/sourcing/requirements.txt` (Python 3.10 or newer).
2. Set a token of at least 24 characters, then start the sidecar:
   `MERIDIAN_SIDECAR_TOKEN=... npm run sourcing-sidecar`
3. Point Meridian at it, with the same token: `MERIDIAN_SOURCING_SIDECAR_URL=http://127.0.0.1:8765` and `MERIDIAN_SIDECAR_TOKEN=...`.

If either variable is unset, or the sidecar is down, slow (over five seconds) or returns an error, Meridian reads the page with its
built-in extraction. The stored record says which extractor ran (`scrapling` or `builtin`). The sidecar's error is not shown, because
it can carry part of the page.

The sidecar listens on `127.0.0.1` only. Every request except `/health` needs the token in the `X-Sidecar-Token` header. It keeps no
access log, and it never echoes a payload or a traceback.

## Routes

| Route | Input | Output |
| --- | --- | --- |
| `GET /health` | none | parser version and the route list |
| `POST /parse` | `{ html, baseUrl }` | `{ title, text, links }` |
| `POST /feed` | `{ feed, limit }`, where `feed` is the feed body already fetched | `{ feedTitle, items }` |
| `POST /v2ex/hot` | `{ limit }` | `{ items }` |
| `POST /v2ex/node` | `{ node, limit }`, where `node` is a V2EX node name | `{ items }` |

## What is wired, and what is not yet

- Wired: `fetchPublicText` (`src/lib/meridian/sources/fetch-page.server.ts`) uses the sidecar's `/parse` through
  `src/lib/meridian/sources/sidecar.server.ts`. Public web pages, the website adapter and the research snapshots all go through it.
- Not yet wired: no source adapter calls `/feed` or `/v2ex/*`. An RSS or V2EX adapter in `src/lib/meridian/sources/registry.ts` is the
  next step.

## Checks

- `python3 -m unittest discover -s sidecar/sourcing -p "test_*.py"`: the sidecar's own tests. They need the Python requirements, so
  they are not part of `npm test`.
- `npm test` covers the Node client (`sidecar.server.test.ts`), including the fallback when the sidecar is off, fails or is slow.

## Not verified

The parser's output on real sites, the V2EX API's behaviour under load, and the sidecar's behaviour on a production host were not
tested here.
