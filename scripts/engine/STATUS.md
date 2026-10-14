# STATUS: E1 acceptance script (task A1)

Phase E1, Bible section 19. Branch `eng-a1-acceptance`, cut from `origin/code/beautiful-cori-1zfk11` (a61a340). Covers
`scripts/engine/` (and `fixtures/` inside it) and one line in the root `package.json` (`engine:e1`). Operator guide:
`README.md` in this folder.

## Done (fixture-tested; the live run is the owner's)

- `e1-build.ts`: the hand-written EDL (one stock clip on `base`, `title.hook` and `cta.card` on `graphics`, `captions.karaoke`
  on `captions`, the TTS voice clip, one punch-in). Text and the style kit come from the contract fixtures. Every artifact is
  parsed with its zod contract. The kit uses bundled fonts only (Inter), not the fixture's Fraunces, so no font is fetched at
  render time (`compose/STATUS.md` item 7).
- `e1-run.ts`: for each master, in order: request row and production request artifact; `reserve()` in cap mode; budget, EDL and
  composition artifacts; `compile()`; `renderComposition()` through `HyperframesCloudAdapter` with
  `gateway.transportFor("heygen", org)` and `gateway.secretFor("heygen", org)`; integrity probe through
  `httpMediaFunctions(gateway.baseUrlFor("media_functions"), textTransport(gateway.transportFor("media_functions", org)))`
  and `checkRenderIntegrity`; `releaseReservation()`; ledger read-back; rendered video and gate artifacts. Eleven named checks
  per master. A failure is recorded, not thrown, and the reservation is still released.
- `e1-backend.ts`: `memory` (artifacts built and validated, nothing persisted) and `postgres` (the engine's `sqlLedgerStore`,
  `writeArtifact` and `advance`). The `engine_requests` row is inserted directly, because `startEngineRequest` queues intake jobs.
  The row's state is set from `advance()` for a start event, pointing at the production request artifact. No job is queued.
- `e1-replay.ts`: a strict replay transport. Each request must match the next recorded step by method and URL, carry the
  headers that step names, send the credential only to HeyGen (the placeholder is refused on signed URLs and on the media
  functions), and send the recorded body where one is named. An extra call, an unused step or a different body fails the run.
- `fixtures/e1-recorded.json`: one render (eight steps in the adapter's real order) and the stand-in bytes of the stock clip,
  the voice file and the video. Its provenance field says "CONSTRUCTED, NOT CAPTURED".
- `e1-live.ts`: the live preflight. It reports every missing item (never only the first): `heygen` and `media_functions`
  (gateway connection), `platform_size_limit`, `database` and `storage` (Drive health). Nothing is spent when any item is
  missing, and nothing is imported that the run does not need.
- `e1-acceptance.ts`: the command line. Exit codes: 0 pass, 1 fail, 2 usage, 3 NOT_CONNECTED. Only argv is read. The
  environment is never read (the script reads no key and no `DATABASE_URL`; `src/lib/db.ts` is imported only with `--database`).
- `e1-acceptance.test.mjs`: 7 tests, run by `npm test` through the scripts shard (13 files, verified by `scripts/test-shard.mjs`).
  They run the script in a child process (node strips the TypeScript; the scripts glob runs plain `.mjs`).

## Tests run in this worktree

- `NODE_ENV=development node --test scripts/engine/e1-acceptance.test.mjs`: **7 pass, 0 fail, 0 skipped.** Covers the dry run
  (every check, costs, probe, no key in output), `--count 3` (three keys, totals 1.56 / 0.15 / 1.41), `--with-database`
  (PGlite ledger and artifacts), replay drift (wrong URL, key on a signed URL, extra call, unused step, wrong body), fixture
  consistency (the probe is asked about the downloaded bytes), NOT_CONNECTED with no spend, and exit 2 for nine usage errors.
- `npm run engine:e1 -- --dry-run`: PASS, 1 of 1 masters, 11 of 11 checks. Probe 1080 x 1920, 30/1 fps, 12033 ms, AAC present.
  Estimate 0.52, reserved 0.52, render 0.05, actual 0.05 (estimate), released 0.47, final reservation 0.05.
- `npx tsc` on `scripts/engine/*.ts` plus the `src` modules they import, with a temporary tsconfig in the scratchpad: exit 0.
- `npx eslint scripts/engine`: 0 errors, 0 warnings.
- Scratch check (not committed): the E1 composition compiled from the EDL and linted with `hyperframes lint`: 0 errors, 0
  warnings, 0 info.
- `npm run typecheck` and `npm run lint`: see the final report.

## Live run: NOT_CONNECTED today (verified)

`npm run engine:e1 -- --org ws_e1_live_check --brand brand_e1_live_check` with no connections exits 3, lists `heygen`
("Meridian has no credential category for heygen yet"), `media_functions` (no base URL), `platform_size_limit` and `database`
(`--database` not given), and makes no request. No live call has been made.

## The owner's live run (exact)

Prerequisites, in README.md: the HeyGen credential category (owner decision), a deployed media functions host, a platform size
limit, `DATABASE_URL` with migrations applied, the workspace and brand rows, Drive connected, and the two assets in the brand's
store.

```bash
npm run engine:e1 -- --org <workspace-id> --brand <brand-id> --database \
  --media-functions-url https://<deployed-media-functions-host> \
  --platform-max-bytes <platform-file-size-limit-in-bytes> \
  --budget-usd 1 --month-budget-usd 50 --count 1 > e1-live-run-1.json
# then the same with --count 10 for the bill
```

The owner records: the JSON reports, the MP4 (from the report's `uri`, in Drive) and its `ffprobe` output, the HeyGen invoice
lines for each render against the ledger actuals, and the Idempotency-Key check (a separate run; the script does not resubmit).

## Decisions and interpretations (lead to confirm)

- **Live database by flag.** `--database` is required for a live run and is the only way `src/lib/db.ts` is imported. Importing it
  without `DATABASE_URL` in development starts an embedded PGlite (`db.ts`, the eager start at the bottom), which is not a live
  ledger. The task said "when DATABASE_URL is given"; the flag is the explicit way to say so.
- **Platform limit by flag.** `thresholds.render.platformMaxBytes` is null, and the integrity gate fails closed on null. The live run
  takes `--platform-max-bytes` until the owner sets the config (eng-contracts). The dry run uses a fixture limit, labelled as such in
  the report.
- **Integrity probe source.** The bytes are probed inline up to `FFMPEG_LIMITS.maxInlineBytes` (4 MB). A larger video is probed by its
  signed URL, which is the file the bytes came from. Without that, a 24 s 1080 x 1920 render would fail the probe as too large.
- **The cost is an estimate.** `renderComposition` reconciles with no bill, so the render's actual is its held amount, flagged
  `actualIsEstimate`. The report says `billVerified: false`. Nothing is presented as a provider bill.
- **Reservation lines.** A master reserves 0.52 (the fixed lines); the Claude, speech and generation lines are released unspent,
  because E1 makes no such call. The plan's shots are stock and code components, all $0 in `prices.ts`.
- **Ledger access.** `reserve()` and `releaseReservation()` use the raw `sqlLedgerStore`, not the `withWorkspaceLedger` and
  `withReservationLedger` transaction wrappers. `renderComposition` holds no transaction across its poll, so it uses the raw store too.
  One sequential process is safe for this run. A concurrent acceptance would need the wrappers around each call (eng-pipeline).
- **Assets are existing.** The stock clip and the voice file are read from the store; the run neither fetches stock footage nor
  generates speech. The EDL's span (12 s) is the contract the owner's files must meet; the run does not probe them before the render.
- **Test location.** A `.test.ts` next to the script would not run under `npm test` (the glob is `scripts/**/*.test.mjs`). The test
  is `e1-acceptance.test.mjs` and runs the script as a child process.

## Findings for the lead (outside this folder; not changed here)

1. **`npm run typecheck` does not check `scripts/engine`.** The root `tsconfig.json` includes only `src` and `server`. The script was
   checked with a temporary tsconfig in the scratchpad that extends the root one (exit 0). Adding `scripts/engine` to `include` would
   make the repo check it; that is a root config change, so the lead decides.
2. **Importing `src/lib/db.ts` in development starts PGlite** when `DATABASE_URL` is unset (the eager start at the bottom of `db.ts`).
   Anything that imports it for a status check gets that side effect. The live preflight avoids it by importing only with `--database`.
3. **The media functions have no credential.** `DEFAULT_PROVIDERS.media_functions` is `auth: none`, so anyone who can reach the deployed
   host can call probe, frames, loudness and cuts. Restrict the host before the live run (the README says so).
4. **Drive keys.** `createGoogleDriveObjectStore(client)` writes the `storage_objects` row through the metadata repository. The live
   path passes `createSqlStorageMetadataRepository(sql)`, so the row lands in Postgres. Not exercised here (no Drive).

## Blockers for the live run (owner)

- HeyGen credential category (`src/lib/meridian/credentials/contract.ts`, the resolver): owner decision.
- Media functions deployed and reachable only by Meridian; base URL passed as `--media-functions-url`.
- Platform file-size limit (`--platform-max-bytes`, or `thresholds.render.platformMaxBytes` by eng-contracts).
- `DATABASE_URL` with migrations applied, the workspace and brand rows, Drive connected for the workspace.
- The two assets in the brand's store (`assets/e1-stock-kitchen.mp4`, `assets/e1-voice.wav`, each at least 12 s).

Not verified by any run here: the HeyGen endpoints and bodies (taken from the CLI source), `Idempotency-Key` behaviour, the output
resolution and aspect, the Drive round trip, the media functions over HTTP, and the look of the composition against the golden frames.
