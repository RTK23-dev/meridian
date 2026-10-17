# Checkpoint: 2026-10-17 (usage limit, earlier)

> Superseded by [CHECKPOINT_2026-10-17_final.md](CHECKPOINT_2026-10-17_final.md). Kept for the record.

All code for the open list is on `main`. Tests were run once, after the last code change (see the commit that carries this note).

## On `main`

- Settlement and billing safety (engine-contracts@6), settlement of every paid call from a bill or confirmed absence.
- Factory fixes: Apify cap for every call, sleep retry and per-scope caps, measurement key (migration 0098, archives duplicates), stuck image jobs, trial-read slots, learning-bridge receipts, organic metrics per channel (Facebook not implemented), representative frames in video decisions, learned patterns not erased by a failed read, minimum confidence never skipped.
- Hygiene: migration runner advisory lock, migration gap test, env scanner names through tables and constants, build and preview load `.env`, `Dockerfile.worker` removed, bill rounding up to four decimals.
- Owner decisions recorded: ffmpeg on the worker; Deepgram for speech-to-text; the orchestrator picks production models from the OpenRouter catalog (Bible 10.5; CLAUDE.md rules 3 and 7).
- Contract v7 (model choice), v8 (brief requests, `scriptwriter`, `model_chooser`, `written_script`, `model_choices`), v9 (ledger `providerRef`, migration 0101).
- Model choice: catalog read, eligibility, one `model_chooser` call per request, fallback to the route table, chosen models priced from their catalog price, over-budget chosen totals pause the run.
- Narration: `tts` route set to `elevenlabs/eleven-v4`, fallback `google/gemini-3.8-flash-tts`, both from OpenRouter's public listing read 2026-10-17. Speech settles from `GET /api/v1/generation`. Unverified live.
- Held calls: `engine.reconcile_holds` settles unsettled calls that have a provider reference once their bill is readable. Rows without a provider reference are reported for an operator, never settled automatically.
- Brief analysis: reference read from the engine's store, analysed, script written by `write_script`, voiced. Language detection on the reference via Deepgram.
- Content Factory: `/content-factory`, admin only. Chat, files, Meridian sources, decision feed. A session is a brief request. Text files up to 4000 characters are read into the brief; longer ones are refused. PDFs are kept with the session, and their text is not read yet.

## Not verified live (no keys were used)

- Speech: the request shape, the stream's generation id, `total_cost`, both speech model ids.
- Deepgram: project listing, request lookup, `detect_language`, the raw-bytes content type.
- Drive release, media functions host, HyperFrames render, Shotstack fallback.
- Docker: the web image has not been built here (Docker Hub returned 429 to this sandbox).

## Owner decisions still open

1. Speech: confirm the narration model and voices. Confirm the speech price basis (the Bible's $40 per million characters).
2. Render fallback: a second HyperFrames attempt under the same key is refused while its cost is unsettled, so the Shotstack fallback waits. This conflicts with the 2026-10-14 policy, so it is not resolved in code.
3. Text files: they are stored in Drive, so they need a brand and a connected Drive.
4. Video-DNA frame labelling calls OpenRouter directly and bypasses the perception provider. Routing it needs a schema change.
5. Rate limits are process-local. A shared store is needed before a second instance.
6. Six-decimal bills need a contract and column change. Bills are rounded up to four decimals for now.
7. Whether held calls should alert.
8. Lip-sync and avatar vendors are not chosen. Those classes stay NOT_CONNECTED.
9. Revisions after the first run are out of v1.

## Next, once keys exist

1. Owner runs one brief end to end with a reference video. Record the artifact ids and costs.
2. Owner runs the source-integration live checks.
