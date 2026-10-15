# Testing

## Commands

```bash
npm test          # unit and integration tests (scripts and src)
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # production build, then migrations
```

`npm test` runs `scripts/**/*.test.mjs` and `src/**/*.test.ts` with the Node test runner. Any new test file in those folders runs in
`npm test`. Some tests run twice, once on the embedded database and once on PostgreSQL, and are labelled `[embedded]` and `[postgres]`.

The video engine has two more commands, outside `npm test`:

```bash
npm run engine:golden          # golden frames of the components (renders locally)
npm run engine:golden:update   # writes the golden PNGs again; review each one before committing it
npm run engine:e1 -- --dry-run # the E1 acceptance on the recorded replay: no network, no keys
```

`npm run engine:e1 -- --dry-run` replays the recorded responses through the gateway, so routing and authentication run as they do live.
It proves the wiring, not a provider. The replay is also a test in `scripts/engine/e1-acceptance.test.mjs`, so `npm test` runs it. The live
run is the owner's, and its steps are in [scripts/engine/README.md](../scripts/engine/README.md).

The golden command needs ffmpeg and a Chrome headless shell (`HYPERFRAMES_BROWSER_PATH`). CI installs ffmpeg and sets
`MERIDIAN_REQUIRE_FFMPEG=1`, so a missing ffmpeg fails the run rather than skipping the media tests.

## Counts at this checkpoint

Measured on 2026-10-15 at `3ba590f` (the head of the checkpoint branch), with `MERIDIAN_REQUIRE_FFMPEG=1 npm test`:

| Run | Tests | Passing | Failing | Skipped |
| --- | --- | --- | --- | --- |
| `scripts/**/*.test.mjs` | 153 | 153 | 0 | 0 |
| `src/**/*.test.ts` | 5,102 | 5,061 | 0 | 41 |

The 41 skipped tests are the PostgreSQL-gated and credential-gated ones; they run when `MERIDIAN_PG_TEST_URL` or a key is set. The
PHASE_LOG records 5,101 tests, 5,060 passing, 0 failing and 41 skipped for the `src` run at `c9b5d8d` (2026-10-15). No test file changed
between `c9b5d8d` and `3ba590f`, so the one-test difference is not explained in this document.

## The PostgreSQL test database

Create an empty database, migrate it, and point the tests at it:

```bash
createdb meridian_test
DATABASE_URL=postgresql://localhost/meridian_test npm run db:migrate
MERIDIAN_PG_TEST_URL=postgresql://localhost/meridian_test DATABASE_URL=postgresql://localhost/meridian_test npm test
```

A test database must be migrated; the tests do not create the schema. Tests that create workspaces use unique ids, so a re-run on the
same database is safe.

## Browser checks

These drive the running app. Start it first (`npm run dev` on port 8080, with `MERIDIAN_TESTING_RUNTIME=true` for the test providers).

- `npm run e2e` (`scripts/product-loop.mjs`): signs up, creates a workspace and a brand, fills the brain, and runs a review through
  to publishing. It fails on the first step that does not work.
- `npm run ui:button-audit` (`scripts/button-audit.mjs`): visits each screen and checks that every enabled control acts, and that every
  disabled control shows its reason. It writes `artifacts/e2e/button-audit.json`.
- `npm run ui:baseline` (`scripts/ui-baseline.mjs`): screenshots every route at phone and desktop widths, in light and dark, and fails on
  horizontal overflow. It writes to `UI_BASELINE_DIR` (CI uses `artifacts/ui-baseline`).
- `npm run ui:design-smoke`: checks the design system for accessibility violations.

Playwright's Chromium is needed for the browser checks. CI installs it with `npx playwright install --with-deps chromium`.

## CI

| Job | Runs |
| --- | --- |
| `check` | `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` |
| `ui-smoke` | `npm run build`, starts the app, `npm run ui:baseline`, `npm run ui:design-smoke`, and a browser smoke |
| `e2e` | `npm run e2e` against the running app |

Only the `check` job's results decide whether code is safe to merge on its own. The browser jobs catch what unit tests cannot:
overflow, dead controls and broken flows.

## Writing tests

- Put a test next to the code it covers, as `<name>.test.ts`.
- Test the rule, not the implementation: what a person or a caller can observe.
- Tests that touch providers use injected fetch functions and fixture keys (`credentials/fixtures.ts`). No test calls a live provider.
- A test that depends on a live key is skipped without that key, and says so.
