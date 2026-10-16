# E1 acceptance (`engine:e1`)

Runs the Video Engine Bible's E1 acceptance (section 19): one hand-written EDL with one stock clip, one TTS voice file and
three components (`captions.karaoke`, `title.hook`, `cta.card`). The EDL is reserved (`budget/`), compiled (`compose/`),
rendered through HeyGen's HyperFrames cloud (`render/`), checked by the render-integrity probe (`media/`), and reconciled in
the ledger. The script prints a JSON report on stdout.

Files: `e1-acceptance.ts` (the command line), `e1-run.ts` (the pipeline), `e1-build.ts` (the EDL, plan and request),
`e1-backend.ts` (ledger, artifacts and media), `e1-replay.ts` (the recorded dry run), `e1-live.ts` (the live preflight),
`fixtures/e1-recorded.json` (the recording), `e1-acceptance.test.mjs` (the tests, run by `npm test`). See `STATUS.md`.

## Dry run (no network, no keys)

```bash
npm run engine:e1 -- --dry-run
npm run engine:e1 -- --dry-run --count 3
npm run engine:e1 -- --dry-run --with-database   # ledger and artifacts in the test helper's PGlite
```

The dry run replays the recorded responses through the gateway's injected transport, so routing, authentication and the
render adapter run as they do live. The replay refuses any request that differs from the recording, and it sends the
placeholder credential only to HeyGen. A passing dry run proves the wiring. It does not prove a provider: the recording is
constructed from the HyperFrames CLI source, not captured from the API.

## Live run (the owner's)

Agents hold no keys. The live run is the owner's and needs the settings below first. Without them the run stops before any
spend and prints `NOT_CONNECTED` for each missing item (exit code 3).

```bash
npm run engine:e1 -- --org <workspace-id> --brand <brand-id> --database \
  --media-functions-url https://<deployed-media-functions-host> \
  --platform-max-bytes <platform-file-size-limit-in-bytes> \
  --budget-usd 1 --month-budget-usd 50 --count 1 > e1-live-run-1.json
```

For the 10-render bill (Bible 19, E1), run the same command with `--count 10`. Each master is a separate request, reservation
and composition, so each makes its own render call.

### What the owner must set first

1. **HeyGen key.** Save the HeyGen key for the workspace in Settings, or set `HEYGEN_API_KEY` with `HEYGEN_SHARED_DEFAULT=deployment`.
   The HeyGen category is in `src/lib/meridian/credentials/contract.ts`. The gateway resolves it per workspace. Until a usable key
   exists the run reports `NOT_CONNECTED heygen` and spends nothing.
2. **Media functions.** Deploy `functions/ffmpeg` and pass its HTTPS base URL with `--media-functions-url`. The app reads the same URL
   from `MEDIA_FUNCTIONS_BASE_URL` (see [OPERATIONS.md](../../docs/OPERATIONS.md#environment-variables)). This script reads only its
   command line, not the environment, so pass the value. The gateway sends no credential to the functions (`auth: none`), so restrict
   access to them (network or a gateway change) before a live run.
3. **Platform file-size limit.** Pass `--platform-max-bytes` with the limit of the platform you deliver to, or set
   `thresholds.render.platformMaxBytes` in `src/engine/config/thresholds.ts` (eng-contracts). It is `null` now, and the
   integrity gate fails closed on a null limit, so the run reports `NOT_CONNECTED platform_size_limit` until one is given.
4. **Database.** Put `DATABASE_URL` in `.env` (loaded by `npm run engine:e1`), apply the migrations (`npm run db:migrate`),
   and make sure the workspace (`--org`) and brand (`--brand`) rows exist. `--database` is required for a live run, so the
   ledger always lands in Postgres.
5. **Google Drive.** Connect Drive for the workspace in Meridian. The run stores the rendered MP4 in the brand's object store
   under an `engine/<workspace>/<request>/render/...` key, and reads the two assets from the same store.
6. **Assets.** The run reads the stock clip and the TTS voice file from the brand's object store, at the default URIs
   `store://assets/e1-stock-kitchen.mp4` and `store://assets/e1-voice.wav`. The EDL runs for 12 seconds (`E1_DURATION_MS` in
   `scripts/engine/e1-build.ts`), so each file must be at least that long. Pass `--stock-uri` and
   `--voice-uri` with other `store://` keys to use other files. The voice file is the TTS audio you already have. The run does not
   generate it, and it does not fetch stock footage.
7. **Budgets.** `--budget-usd` is the request budget of each master (default 1). `--month-budget-usd` is the workspace month
   (default 50). Set them to what you accept. Each master reserves about $0.52 for the fixed lines
   (`fixedPerMasterUsd` in `src/engine/config/budgets.ts`, Bible 14.2). The render line of $0.05 is that fixed figure, an estimate.
   It is not a HyperFrames price: `render_hyperframes_cloud` is `null` in `src/engine/config/prices.ts`, because the price is unknown.
   The report's `billVerified` is `false`, because the render adapter reads no bill from HeyGen, so the actual is the list estimate.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every master passed every check. |
| 1 | A master failed a check, or the run stopped. The report says which. |
| 2 | Bad usage (a message and the usage text on stderr). |
| 3 | `NOT_CONNECTED`: a connection is missing and nothing was spent. |

### What the report says

- Per master: request, reservation, EDL, composition and idempotency key (the composition hash), render id, video id, the
  stored `store://` URI, artifact ids, the ledger lines, the probe result (`width`, `height`, `fps`, `durationMs`,
  `audioPresent`, codecs), the integrity checks and each check's result.
- Costs: `estimateUsd` (the reservation's fixed lines, $0.52), `reservedUsd`, `renderEstimateUsd` ($0.05), `actualUsd`,
  `actualIsEstimate`, `releasedUsd`. The top-level `billVerified` is `false`: the render adapter reads no bill from HeyGen, so
  the actual is the list estimate. Compare each render's ledger line with the HeyGen invoice; that comparison is the bill
  check of Bible 19.

### What the owner records for the phase PR

- The JSON report of the 1-render run and of the 10-render run (`--count 10`).
- The MP4 of the 1-render run (download it from the `uri` in the report, from Drive) and its `ffprobe` output.
- The HeyGen invoice lines for the 10 renders, next to the ledger actuals.
- The Idempotency-Key behaviour (Bible 6.11, `render/STATUS.md` item 4). The script does not resubmit a composition, so this
  check needs its own run; it is not part of this acceptance.
