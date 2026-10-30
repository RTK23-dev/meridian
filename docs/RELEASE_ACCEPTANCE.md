# Release acceptance: browser checks for the Settings states

This is the browser acceptance for the release review of PR #80. It checks what a workspace administrator sees in Settings: the uncertain
budget holds and their release, and the provider rows, where a saved key must read as saved and not as checked live. It runs against a
dev server in the testing runtime, on a fresh embedded database. It sends no provider request. The key it saves is a fixture, and the run
fails if any request leaves the local server.

The checked-in screenshots in `docs/release-acceptance/` are reference captures. Current-head browser screenshots, including `content-workflow-desktop.png` and `content-workflow-phone-390.png`, are uploaded as the `release-acceptance` CI artifact.

## Run it

One command does the whole sequence, locally or in CI:

    node scripts/release-acceptance/run.mjs

The script starts the dev server on a fresh data directory, creates the owner account through the sign-up form (`acceptance-owner@example.com`,
password `AcceptancePass-1`, workspace `Acceptance workspace`), stops the server, seeds two uncertain holds, starts the server again, runs
the browser checks, and then checks the database. Set `ACCEPTANCE_OUT` to choose where the screenshots and the server log go; the default
is `artifacts/release-acceptance`. Set `ACCEPTANCE_BASE_URL` if the server is not on `http://127.0.0.1:8080`.

The steps are also available one at a time, against a data directory you choose. The embedded database takes one process at a time, so the
server is stopped while the seed or the database check runs:

    node scripts/release-acceptance/seed-holds.mjs <data directory>
    node scripts/release-acceptance/acceptance.mjs
    node scripts/release-acceptance/verify-release.mjs <data directory>

CI runs the same script in the `release-acceptance` job, which the `check` gate requires. The job uploads the screenshots and the server log
whether the run passes or fails.

## What the run checks

**Last fully verified code head:** [CI run 40263991449](https://github.com/RTK23-dev/meridian/actions/runs/40263991449) on `b4b94ea984caf9ab3b524fd2999a9f8fbb49678b` completed with all 13 required jobs successful. The release-acceptance job reported 13 pass, 0 fail; its screenshots and logs are attached as the `release-acceptance` artifact.

| ID | Check | Result |
| --- | --- | --- |
| A1 | Two uncertain holds are listed with their operation and model | PASS |
| A2 | A release with no reason is disabled | PASS |
| A3 | Keyboard: the reason takes focus, a reason under 10 characters keeps release disabled, Tab reaches release with a visible focus ring | PASS |
| A4 | Keyboard: Enter releases the hold, the notice names it, and only that hold leaves the list | PASS |
| A5 | The second, unreleased hold keeps its release disabled | PASS |
| B1 | A stored key reads as "Saved, not checked live", and nothing on the row or the page claims a live verification | PASS |
| C1 | A stored provider success older than 24 hours is shown as DEGRADED, never HEALTHY/live-verified | PASS |
| C2 | Blank configuration fails closed: the decision engine says it cannot answer | PASS |
| D1 | No request left the local server | PASS |
| E1 | Settings phone width (390 px): no horizontal scroll | PASS on run 40263991449 (head b4b94ea) |
| F1 | Content workflow tabs were accessible and the admin saw Ads (legacy label) | PASS on run 40263991449 (head b4b94ea) |
| F2 | Create presets expose the selected state and no-brand empty state | PASS on run 40263991449 (head b4b94ea) |
| F3 | Content page at 390 px has no horizontal overflow | PASS on run 40263991449 (head b4b94ea) |
| F4 | The admin-only Batch tab opens on Video batches; Research-led runs (advanced) opens on Make a batch | PASS on run 40855263261 (head 60d49282); current-head rerun required after later source guards/docs changes |
| G1 | Market explains one exact page URL (no setup) versus an optional phrase search | not yet run on CI |
| G2 | A run that stored new examples says so, with source rows closed | not yet run on CI |
| G3 | A duplicate-only run says nothing new, offers a next step, and counts unused sources as not failures | not yet run on CI |
| G4 | A robots.txt-blocked page is reported as blocked, not bypassed, with a supported alternative | not yet run on CI |
| G5 | The default view prints no per-source rows; the details open on request | not yet run on CI |
| G6 | Only search sources ask for a key; unavailable sources say no key is needed | not yet run on CI |
| G7 | `/settings#monthly-budget` focuses one field named "Monthly budget (USD)" | not yet run on CI |
| G8 | Setup shows key saved, test passed and active engine as separate steps | not yet run on CI |
| G9 | The Setup sources step does not ask for a key to read a page | not yet run on CI |
| G10 | A pasted social URL says up front there is no connector and no key is used | not yet run on CI |
| G11 | OpenRouter walk through the real actions with a recorded catalogue and transport (testing runtime only): no budget refuses before anything is sent, the link focuses the budget field, a passed test does not activate OpenRouter, and choosing it does | not yet run on CI |
| G12 | Video variations: one seeded source draft becomes a bounded batch of Ready drafts in the browser; a budget that cannot cover the count is refused with the reason; the template is not offered as a draft to pick; Start the batch is still waiting; no request leaves the local server | PASS on run 40855263261 (head 60d49282), 26 checks pass / 0 fail; current-head rerun required after later source guards/docs changes |
| G12b | The batch shows counts by state and downloads a CSV summary of each video's recorded state, with no file and nothing marked delivered | not yet run on CI |
| G13 | Pattern-finding: the research format (structure, opening, hook, call to action with counts) is shown, and ticking it bases the videos on those patterns, with fixed angles filling the rest | not yet run on CI |
| G14 | Demo run on seeded fixture data (titled DEMO): a batch with two delivered videos and one draft is reviewed in the browser, one approved, one rejected with a reason, and summarised; a draft is never offered for review | not yet run on CI |
| M1 | Page heights on a clean account are recorded to `page-heights.json` and bounded (Setup, Settings, Market, Brand brain) | not yet run on CI |

`verify-release.mjs` then checks the database: exactly one `generation_hold_releases` row, for the first hold, attributed to the owner account,
with a reason of at least ten characters, and the second hold still `uncertain`.

## Stale readiness

A recorded provider success is HEALTHY only while it is fresh. The window is one day (`PROVIDER_SUCCESS_FRESH_MS` in `providers/phase.ts`).
The success is recorded only when someone checks or connects the provider, so a shorter window fails closed sooner: a success older than a day
reads DEGRADED with "The last successful request is stale.", and a success that cannot be read as a time is DEGRADED too.

The rule is tested at the function, integration and browser boundaries. `providers/stored-freshness.test.ts` calls the function the Integrations and Performance screens call, with fresh, stale, 90-day, unreadable and boundary inputs. `providers/connection-state.test.ts` runs the stored-connection status path and asserts DEGRADED. The browser pass seeds a 25-hour-old Meta success and a deterministic sealed dummy token encrypted with an acceptance-only key. The token is not a provider credential; the browser only reads the Integrations status, and no probe is invoked. The browser asserts that the actual card says DEGRADED and explains that the last success is stale, never HEALTHY or live-verified.

A stale connection stops performance sync from being planned until someone checks the provider again. Performance sync does not record a
success, so re-checking is the only way back to HEALTHY.

## The saved-key wording

A stored key shows the status "Saved, not checked live", with the reason "The workspace's own key is saved and can be read. Nothing has
been checked against the provider with it." The setup flow has no live-verified state: the Check key action reads the key and calls no
provider. The HEALTHY phase in the connection rows is the only live-verified state, and it needs a recorded successful provider request.

## The first-run journey (G checks)

`seed-first-run.mjs` stores three finished discovery runs for a brand the run creates through the form: new examples, every example
already stored, and a page the site's robots.txt did not allow. They are stored states. No page is fetched, because a local address is
refused by design and this run sends no request to a live site. The real page read, the duplicate count and the robots refusal are
covered by the server tests (`public-page-run.test.ts`). The G checks prove what a person is shown for each state.

## What is not covered

- **The budget blocker link inside the OpenRouter test.** Reaching it needs the live OpenRouter model catalogue. The link target is
  checked (G7), and the text that triggers the link is a pure function with a unit test.

- **Live provider behaviour.** Nothing here calls a provider, so this proves the screens and the fixtures, not the providers.
- **Server-side outbound calls.** The browser can see only the requests the page makes. A request the server makes on its own is not
  visible from here.
- **PostgreSQL.** The browser pass ran on the embedded database. The same screens are not run against PostgreSQL here.
- **A real provider request.** The stale row uses an acceptance-only dummy token and the browser only reads status. No provider call or live credential is exercised.
