# Release acceptance: browser checks for the Settings states

This is the browser acceptance for the release review of PR #80. It checks what a workspace administrator sees in Settings: the uncertain
budget holds and their release, and the provider rows, where a saved key must read as stored and not as verified live. It runs against a
local dev server in the testing runtime, on a database that the seed script prepares. It sends no provider request. The key it saves is a
fixture, and the run fails if any request leaves the local server.

The screenshots from the passing run are in `docs/release-acceptance/`.

## Run it

1. Start the dev server in the testing runtime, on a data directory of your own:

       MERIDIAN_TESTING_RUNTIME=true MERIDIAN_LOCAL_DATA_DIR=/path/to/data npm run dev

2. Create the owner account once, through the create-account form on `/login`: name `Acceptance Owner`, email
   `acceptance-owner@example.com`, password `AcceptancePass-1`, then the workspace `Acceptance workspace`. The seed and the browser pass
   use these values unless `ACCEPTANCE_EMAIL` and `ACCEPTANCE_PASSWORD` are set.

3. Stop the dev server. The embedded database takes one process at a time. Seed the holds into the same directory:

       node scripts/release-acceptance/seed-holds.mjs /path/to/data

4. Start the dev server again, on the same directory, and run the browser pass:

       ACCEPTANCE_OUT=artifacts/release-acceptance node scripts/release-acceptance/acceptance.mjs

The seed resets the two holds on every run, so the pass starts from the same state. Set `ACCEPTANCE_BASE_URL` if the server is not on
`http://127.0.0.1:8080`.

## What the run checks

| ID | Check | Result on `c0748af`-era code |
| --- | --- | --- |
| A1 | Two uncertain holds are listed with their operation and model | PASS |
| A2 | A release with no reason is disabled | PASS |
| A3 | Keyboard: the reason takes focus, a reason under 10 characters keeps release disabled, Tab reaches release with a visible focus ring | PASS |
| A4 | Keyboard: Enter releases the hold, the notice names it, and only that hold leaves the list | PASS |
| A5 | The second, unreleased hold keeps its release disabled | PASS |
| B1 | A stored key reads as stored and usable, and nothing on the row or the page claims a live verification | PASS |
| C1 | Blank configuration fails closed: the decision engine says it cannot answer | PASS |
| D1 | No request left the local server | PASS |
| E1 | Phone width (390 px): no horizontal scroll | PASS |

The run prints `SUMMARY 9 pass, 0 fail` on the reset state. The audit side of A4 was checked separately, against the database: the
release wrote one `generation_hold_releases` row for the first hold, with the admin's user id, the organization, and the reason typed
in A3. The second hold stayed `uncertain`.

## What is not covered

- **Stale readiness: FAIL.** `src/lib/meridian/providers/live.ts` (`phaseForProbe`) passes `stale: false` to `connectionPhase` and nothing
  else ever sets it. A recorded success therefore reads HEALTHY however old it is. A 90-day-old success returns
  `HEALTHY | The last provider request succeeded.` `connectionPhase` in `providers/phase.ts` says HEALTHY requires a fresh success, so the
  rule exists and the path never applies it. The fix needs a freshness window, and the codebase defines none. It is a change to provider
  readiness logic, so it is not made here.
- **The wording "Usable".** A saved key shows the badge "Usable" with the line "The workspace's own saved key is in use." No live request
  has been made, and the page says so, but "Usable" next to a stored key reads more like a working connection than a saved one.
- **Live provider behaviour.** Nothing here calls a provider, so this proves the screens, not the providers.
- **Server-side outbound calls.** The browser can see only the requests the page makes. A request the server makes on its own is not
  visible from here.
- **PostgreSQL.** This pass ran on the embedded database. The same screens are not run against PostgreSQL here.
