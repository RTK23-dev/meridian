# Checkpoint: 2026-10-17 (usage limit reached)

Last green state on `main`: `0bd38bc`, full `npm test` 5444 passing, 0 failing, 41 skipped (env-gated). Pushed.

## Done and on `main`

- Settlement and billing safety (earlier checkpoints, engine-contracts@6).
- Factory fixes: Apify cap, sleep retry, measurement key (migration 0098, archives duplicates), stuck image jobs, trial-read slots, learning-bridge receipts, organic metrics per channel, representative frames in video decisions.
- Owner decisions recorded (Bible 10.5, CLAUDE.md rules 3 and 7): ffmpeg on the worker, Deepgram for speech-to-text, the orchestrator picks production models from the OpenRouter catalog.
- ffmpeg on the worker (`MEDIA_FUNCTIONS_MODE=in_process`), Deepgram speech-to-text with its bill lookup, Deepgram credential, root Dockerfile installs ffmpeg.
- Contract v7 (`modelChoice` on the asset spec, catalog candidate schema) and v8 (brief requests, `scriptwriter`, `model_chooser`, `written_script`, `model_choices`).
- Catalog read, eligibility filter and router change (`0bd38bc` and before): a chosen model's call goes to that OpenRouter model at its catalog price.
- Model choice after the plan: one `model_chooser` call per request, fallback to the route table on any ineligible or failed pick.
- Content Factory page at `/content-factory`: chat, files, Meridian sources, decision feed; a session is a brief request by default; PDFs accepted; admin only.
- Engine API `engineRequestFeed` reads brief requests and written scripts.

## Open, in worktrees (WIP checkpoints, not verified)

1. **Brief requests through analysis, script writing and voice**: branch `worktree-agent-a16624873a0973b89`, checkpoint `1492812`. Contains `write_script`, the production analysis and voice ports, mp3 storage path. Remaining per the agent: fix stale comments in the storage adapter and link route; then tsc, eslint, all `src/engine` tests.
2. **Budget estimate from the chosen model's catalog price**: branch `worktree-agent-a2c9afc7749cad17e`, checkpoint `95c6b11`. Reservation should price each call from its `model_choices` entry, and refuse at estimate time when the chosen total exceeds the request budget. Then tsc, eslint, all `src/engine` tests.

Merge each branch only after its verification passes, then run the full suite once and push.

## Not built yet

- Production language detection for the brief's reference (Deepgram `detect_language`): planned in item 1's brief.
- Speech billing: OpenRouter's speech output comes from chat completions with audio; the cost is read from `GET /api/v1/generation?id=...` (`data.total_cost`). Unverified live.
- Live runs of everything above. No live key has been used; the owner runs the acceptance.

## Owner decisions

- Speech output format (mp3 is requested) and speech-to-text vendor settings: confirm Deepgram key and project id.
- Whether a brief request's reference language should be detected or asked for.
- `COPY_RUN_WORDS = 6` for copied-script detection; confirm.
- Whether the orchestrator's choice may exceed the price table (it is priced from the catalog).
- Whether to purge `unified_performance_telemetry_duplicates` after review.
- Docker: the worker must run in_process; the web image builds only once the base image is reachable again (Docker Hub returned 429).

## Next session, in order

1. Merge item 1 and item 2 after verification; full suite; push.
2. Owner runs the live acceptance for one brief request with a reference video; record artifact ids and costs.
