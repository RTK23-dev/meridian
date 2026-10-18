# Checkpoint: 2026-10-17, final code pass

Later changes on `origin/main` (release `0.1.0-beta.13` and other commits of 2026-10-17) supersede some lines here; they are listed in [docs/LAUNCHPAD.md](../LAUNCHPAD.md). This checkpoint supersedes [CHECKPOINT_2026-10-17.md](CHECKPOINT_2026-10-17.md). The earlier note was written before the last merges.

**Last tested tree:** `3747445`. `npm test`: 5539 engine and source tests passed, 0 failed, 41 skipped (env-gated); 160 script tests passed.
`npm run typecheck`, `npm run lint` (0 errors, 4 existing warnings) and `npm run build` passed on the same tree. No later commit changes code.
Docs commits after `3747445` change only Markdown.

## What is on `main`

**Engine contracts.** `engine-contracts@9`. v6: settlement from a verified bill or a confirmed absence only. v7: `modelChoice` on the asset
spec. v8: a request carries a script or a brief, with `scriptwriter`, `model_chooser`, `written_script` and `model_choices`. v9: a ledger
row carries `providerRef`, the provider's own id for a paid call (migration `0101`).

**Model choice (Bible 10.5).** The orchestrator's catalog read, eligibility filter and one `model_chooser` call per request. A pick that
is not eligible falls back to the route table. A chosen call is priced from its catalog price, and an over-budget chosen total pauses the
run in cap mode.

**Brief requests.** `write_script` writes the script from the brief and the reference analysis. Copied runs of six or more words are
refused (`COPY_RUN_WORDS = 6`). The reference is read from the engine's store, analysed with ffmpeg on the worker and Deepgram, and its
language is detected.

**Narration.** The `tts` route is `elevenlabs/eleven-v4`, with `google/gemini-3.8-flash-tts` as fallback. Both ids are from OpenRouter's
public listing, read 2026-10-17. Speech settles from `GET /api/v1/generation` (`data.total_cost`). If the bill cannot be read, the call
stays unsettled.

**Held calls.** `engine.reconcile_holds` settles an unsettled call once its provider reference has a readable bill. A call with no
reference is reported to an operator and never settled automatically. It runs only after its `job_schedules` row is inserted
(`src/engine/jobs/STATUS.md`).

**Media and speech-to-text.** ffmpeg runs on the worker with `MEDIA_FUNCTIONS_MODE=in_process`. Deepgram Nova-3 is the speech-to-text
vendor, its bill read from Deepgram's request lookup. The root `Dockerfile` installs ffmpeg. `Dockerfile.worker` is deleted.

**Content Factory page (`/content-factory`).** Admin only. A session is a brief request by default: instructions, sources from Meridian
pages, and attached files. Text files up to 4000 characters are read into the brief. Longer text files are refused in plain words. PDFs
and images stay with the session as attachments; their content is not read. The decision feed shows each engine stage, its model and its
cost. An unbilled cost shows as unknown.

**Hygiene.** Sleep caps are checked per scope. A failed organic read fails the learned-pattern recomputation, and that failure no longer
erases the patterns. The decision policy never skips a minimum confidence. The migration runner takes one advisory lock for a run. The
migration plan test pins the known gaps (`0083` to `0089`) and the duplicate `0027`. The env scanner reads names held in tables and lists.
Build and preview load `.env`. Bills are rounded up to four decimals, so a recorded actual is never below its bill.

**Earlier work still on `main`.** Settlement and billing safety; Factory fixes (Apify cap, sleep retry, measurement key with migration
`0098`, stuck image jobs, trial-read slots, learning-bridge receipts, organic metrics for Reels, Shorts and TikTok, representative frames in
video decisions); ffmpeg on the worker; Deepgram speech-to-text with its credential.

## Commits since the earlier checkpoint (`ac92648`)

`bc5478d` brief requests (write_script, production analysis and voice ports) · `386124b` and `f7e42d3` chosen-call pricing and cap pause ·
`a610ca2` content factory text files · `ba0b396`, `1721d1c`, `84cc957`, `07d8a9a`, `9f458b5`, `b845fc8`, `6d11741`, `c647cea`, `a8c641f`,
`bb6e4a1`, `c0530ae`, `df9121d` hygiene · `e60417f` narration, provider references and held-call reconciliation (contract v9) · `3747445`
test types.

## Verified

- The typecheck, the lint, the build and the full test suite, on `3747445`, as listed above.
- Owner decisions recorded in `CLAUDE.md` and Bible 10.5: ffmpeg on the worker, Deepgram, the orchestrator's model choice.

## Not verified live

No live key was used. Each of these needs the owner's run:

- **Narration.** The request shape (chat completions with audio, `stream: true`), the stream's generation id, `total_cost`, and both voice
  ids.
- **Deepgram.** The project listing, the request lookup and the bill, `detect_language`, and the raw-bytes content type. The price
  `$0.0043` per minute is third-party.
- **OpenRouter.** Video model ids and `pricing_skus`, the catalog's price fields, and the `model_chooser` answers.
- **Render.** HyperFrames and its price, the Shotstack fallback, the media functions' host, and Drive release.
- **Docker.** The web image has not been built here. The Docker daemon stopped with the session restart, and Docker Hub returned 429 to
  this sandbox earlier.

## Owner decisions still open

1. **Render fallback.** A second HyperFrames attempt under the same key is refused while its cost is unsettled, so the Shotstack fallback
   waits. This conflicts with the 2026-10-14 policy. It is not resolved in code.
2. **Narration.** Confirm `elevenlabs/eleven-v4` as the default and the speech price basis.
3. **Text files.** They are stored in Drive, so they need a brand and a connected Drive. Should they skip Drive?
4. **Video-DNA frame labelling** calls OpenRouter directly, outside the perception provider. Routing it needs a schema change.
5. **Rate limits** are per process. A shared store is needed before a second instance.
6. **Held calls** from a failed or stopped request stay in the monthly total until a rejection or delivery releases them. Should a held
   call alert, and after how long?
7. **Six-decimal bills** need a contract and column change. Bills are rounded up to four decimals for now.
8. **Lip-sync and avatar** vendors are not chosen, so those shot classes stay NOT_CONNECTED.
9. **Revisions** after the first run are outside v1.
10. **Merging `reconcile_holds`** into production needs its schedule row. Insert it per `src/engine/jobs/STATUS.md`.

## Next, in order

1. The owner runs one brief end to end with a reference video. Record the artifact ids, costs and output in the PHASE_LOG.
2. The owner runs the source-integration live checks, with the keys.
3. Decide the owner items above. Each one that changes code gets its own branch, a test run before its commit, and a push.
