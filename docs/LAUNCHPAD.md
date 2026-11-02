# Launchpad

> **Superseded (2026-10-28).** This describes release `0.1.0-beta.13` and migrations up to `0107`. The current release is `0.1.0-beta.16`
> with migrations up to `0137`. Start with [STATE_2026-10-28.md](STATE_2026-10-28.md) and then [FIRST_TEST_RUN.md](FIRST_TEST_RUN.md). The
> owner decisions it lists are still open, and the state document lists them with their current status.

Start here to open a new Claude chat with the whole Meridian context. Copy the **Opening prompt** below into the new chat, and attach the
repository (`RTK23-dev/meridian`, branch `main`). The prompt points the new session at the files that hold the current state, so it does
not rely on memory of this conversation.

State described here: `origin/main` at `e94f5e1`, on 2026-10-18. Release `0.1.0-beta.13` was cut on 2026-10-17.

## Opening prompt

```
You are continuing work on Meridian (github.com/RTK23-dev/meridian, branch main). Read these first, in order, and treat them as the
current state. Where two of them disagree, the newer dated entry wins.

1. AGENTS.md and CLAUDE.md (repo rules; CLAUDE.md's engine rules bind any work under src/engine/).
2. docs/LAUNCHPAD.md (this file): what we are building, where it stands, what is open, how we work.
3. docs/NORTH_STAR.md: the goal, the owner's decisions and the work queue.
4. docs/engine/CHECKPOINT_2026-10-17_final.md, then the 2026-10-17 entries at the end of docs/engine/PHASE_LOG.md.
5. docs/engine/VIDEO_ENGINE_BIBLE.md: sections 1, 3, 4 (the v6 to v9 notes), 10.5 and 19.

Then wait for my instruction. Do not change code until I say what to do. Before any push, run the checks in docs/LAUNCHPAD.md.
```

## What Meridian is

Meridian is a multi-tenant advertising operating system. It holds a brand's own facts, turns evidence into creatives, decides which
creatives may go out, exports or publishes them, and records what happened. The stack is TanStack Start, React 19, Tailwind v4, Postgres
(PGlite locally), a worker and a scheduler. It is in prerelease.

**Naming.** "Factory" is the automated ad pipeline (discover, produce, gate, publish, measure, learn), in `src/lib/meridian/factory/`.
"Content Factory" in NORTH_STAR and FACTORY.md means that pipeline. The new standalone page is also called Content Factory, at
`/content-factory`. It uses the video engine, not the ad pipeline.

## What we are building

**The owner's vision.** Anyone with an idea can get a video made, in the most accessible way possible. The owner's words:
someone finds a viral Instagram video, downloads it, and sends it with some text on the page. The engine analyses the video, takes the
rest of the input into account, plans how to recreate it, picks the models from OpenRouter, writes the script, makes the narration and the
visuals, assembles the video, and the person can see every decision as it happens.

**The page (`/content-factory`, admin only).** A chat. Type instructions, attach files from the computer (a video as the reference, images,
text, PDFs), and attach records from Meridian pages (brand brain, products, library, pages, market intelligence). "Make the video" starts a
run when the session has a reference video, a theme page with its kits, a length, a budget and a priority. A decision panel shows each
stage, its inputs and output, the model and provider used, and its cost as estimate, reserved and billed. A cost with no bill shows as
unknown, never as a number. Revisions reopen a session after its video is delivered or has failed.

**The engine (`src/engine/`).** The production pipeline behind the page. Stages: intake, analyze_reference (ffmpeg on the worker, Deepgram
speech-to-text, Claude roles), write_script (for brief requests), voice (narration through OpenRouter speech), plan (with `model_chooser`
picking each call's model from OpenRouter's live catalog), estimate_reserve, produce_shot, check_take, edit, compose, pre_render_gate,
render (HyperFrames cloud, Shotstack as fallback), post_render_review, variants, deliver. Principle: copy the example's genes (structure,
pacing, tone, grammar), never its content (footage, words, voice, music).

## Where it stands

- **Release.** `0.1.0-beta.13` (see CHANGELOG.md). Contracts are `engine-contracts@9` (`src/engine/contracts/version.ts`). Migrations run to
  `0107`; the engine's are `0077` onward.
- **Tests.** The last full run I did was on `3747445`: 5539 engine and source tests passed, 0 failed, 41 skipped (env-gated); 160 script
  tests passed. Typecheck, lint (0 errors, 4 existing warnings) and the build passed on that tree. Commits by other people have landed on
  `origin/main` since then, and nothing has been tested against them yet. Run the checks before the next push.
- **Live.** Nothing has run against a live API. No provider key has been used by any agent. All engine work is verified on recorded fixtures
  only.
- **Built on fixtures:** the Content Factory page (brief requests, file and source attachments, revisions, the decision feed); the engine's
  model choice, brief pipeline, narration, held-call reconciliation (`engine.reconcile_holds`, scheduled per organization by
  `scripts/scheduler-entry.ts`); the ad pipeline's Apify cap, sleep retry and caps, measurement keys, trial-read slots, organic metrics for
  Instagram Reels, YouTube Shorts and TikTok (Facebook Page not implemented).

## Changed after the older docs were written

Trust these over any older line in the checkpoint, the README or the roadmap:

- **Held-call reconciler** is scheduled automatically: `scripts/scheduler-entry.ts` inserts one `reconcile_holds` row per organization.
  No manual insert is needed.
- **Rate limits** share one Postgres window when `DATABASE_URL` is set (`rate_limit_windows`, migration `0103`). Without a database the
  limit stays in one process.
- **PDFs** within 4000 characters are read into the brief. Longer ones are refused with a reason (beta.13 notes; I did not re-check this code).
- **Revisions** exist (migration `0106`). The older text saying they are not built is wrong.
- **Other changes on `main`:** OAuth return path (`0104`), grade history (`0105`), organic observation keys (`0107`), Google Ads and TikTok ad
  accounts, a `wiki/` folder, a rewritten README and product docs.

## Owner decisions still open

None of these is resolved in code. Each is recorded in `docs/engine/PHASE_LOG.md` (2026-10-17) with the reason.

1. **Render fallback.** A second HyperFrames attempt under the same key is refused while its cost is unsettled, so the Shotstack fallback
   waits. This conflicts with the 2026-10-14 policy (Shotstack is the only fallback, after the Remotion Lambda drop). CLAUDE.md says do not
   resolve it in code.
2. **Narration.** Defaults chosen by the lead on 2026-10-17: `elevenlabs/eleven-v4`, with `google/gemini-3.8-flash-tts` as fallback, both
   read from OpenRouter's public listing. The owner confirms the default and the speech price basis (the Bible's $40 per million
   characters).
3. **Video-DNA frame labelling** (`src/lib/meridian/factory/decode.ts`) calls OpenRouter directly, outside the perception provider.
   Routing it needs a schema change.
4. **Held calls.** Should a call held from a failed or stopped request alert, and after how long?
5. **Six-decimal bills.** Bills are rounded up to four decimals now. Six needs a contract change and a column change.
6. **Lip-sync and avatar** vendors are not chosen. Those shot classes stay not connected.
7. **Text files and Drive.** Text files are stored in Drive, so they need a brand and a connected Drive. Should they skip Drive?
8. **Prices we do not guess:** HyperFrames per minute, Apify per 1,000 results, and `image.edit`. Each stays null, and its feature stays not
   connected until the owner sets it.
9. **Deepgram project id.** The gateway resolves it from the key: exactly one project is used, otherwise the bill lookup is not connected.
   The owner confirms this is the right source.

## Not verified live

- **Narration:** the request shape (chat completions with audio output, `stream: true`), the generation id from the stream, `total_cost`
  from `GET /api/v1/generation`, and the voice ids.
- **Deepgram:** the project listing, the request lookup and its bill, `detect_language`, and the raw-bytes content type. The $0.0043 per
  minute price is third-party.
- **OpenRouter:** the video catalog's `pricing_skus` names, the `/models` price fields, and the speech modality name.
- **Render and media:** HyperFrames, the Shotstack fallback, the media functions host, and Drive release.
- **Docker:** `docker compose up --build` has not been built in this sandbox. The base image pull was rate-limited, and the daemon was not
  running at the last check. It needs a run on a machine with registry access.
- **Source integrations:** YouTube, SerpAPI, Meta Ad Library, TikTok, Instagram and the rest have request code and fixture tests only.
- **Organic metrics:** the reads for Instagram Reels, YouTube Shorts and TikTok are unverified live.

## Working rules we have used

- **Git.** Commit and push to `main` directly; the owner asked for this. Run `git fetch` and `git status -sb` first. Other people and sessions
  push to `main` too, so fast-forward before pushing. Never force-push. Commit messages are plain: no model names, a `Claude-Session` trailer
  is fine.
- **Tests.** Run the full suite once, just before the final commit of a change. Docs-only commits need no test run. Typecheck, lint and the
  build also run before the push.
- **Stop hook.** It nags about unpushed commits and uncommitted changes. Push only when the checks have passed for that change.
- **Parallel work.** We used git worktrees under `.claude/worktrees/`, one per workstream. The lead cherry-picks the finished commits onto
  `main`, strips any model-name trailers, runs the checks, and pushes. Agents do not run tests until all their code for the task is written.
- **Engine rules** (CLAUDE.md): fail closed; no fake success; every paid call goes through the gateway, the router and the ledger; contracts
  change only with a version bump, a Bible section 4 note and lead approval; copy genes, never content; secrets never in git, logs or chat;
  agents hold no live keys.
- **Owner decisions.** When the owner has not decided something, the lead decided it and recorded it in PHASE_LOG and the checkpoint, so the
  owner can confirm or reverse it.
- **Known conflicts** (CLAUDE.md): S3 in the Bible versus Drive; the live-run requirement versus agents holding no keys; PR #39 and Veo; Hypit.
  Do not resolve these in code.

## Repository map

- `src/engine/`: the video engine. `contracts/` (zod schemas, versions), `config/routes.ts` (models and providers per capability),
  `budget/` (reserve, reconcile, reconcile-holds), `gateway/` (the only place that calls `fetch`; catalog reads; OpenRouter generation
  bills), `assets/` (router and provider adapters), `jobs/` (stages, runtime, dispatch, maintenance), `analyze/`, `voice/`, `plan/`,
  `review/`, `deliver/`, `media/` (ffmpeg clients and Deepgram), `api/index.ts` (the API the app calls).
- `src/lib/meridian/content-factory/`: the page's server side (files, request mapping, service, feed, model). UI in
  `src/components/content-factory/` and `src/routes/_app/content-factory.tsx`.
- `src/lib/meridian/factory/`: the ad pipeline. `src/lib/meridian/credentials/`: workspace and deployment keys (categories include
  `openrouter`, `heygen`, `anthropic`, `deepgram`, `apify`).
- `migrations/`: SQL in filename order, `0001` to `0107`.
- `docs/`: NORTH_STAR, FACTORY, ROADMAP, PROVIDERS, SETUP, OPERATIONS, TESTING; `docs/engine/`: the Bible, the handoff, PHASE_LOG,
  PROVIDER_APIS, and the checkpoints. `wiki/`: product pages added on 2026-10-17.
- `scripts/`: `scheduler-entry.ts`, `worker-entry.ts`, `migrate.mjs`, and `scripts/engine/` (the E1 acceptance script).
- `docker-compose.yml` (web, worker with `MEDIA_FUNCTIONS_MODE=in_process`, scheduler, Postgres 16) and the root `Dockerfile` (installs ffmpeg).
- `.env.example`: every variable, with comments.

## Commands

- `npm run dev` (port 8080; PGlite locally), `npm run worker`, `npm run scheduler` (need `DATABASE_URL`).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- `npm run engine:e1 -- --dry-run` (the E1 acceptance on the recorded replay; no network, no keys).
- `docker compose up --build` (not yet built or run in this sandbox).

## Next steps, in order

1. Fast-forward to `origin/main`. Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` on it, because the commits from
   2026-10-17 after `3747445` have not been tested here.
2. Owner: provide the keys (OpenRouter, Deepgram with its key, Drive, and the media functions host or the worker's in-process mode). Then run
   one brief end to end with a reference video. Record the artifact ids, costs and output in PHASE_LOG.
3. Owner: decide the open items above. Each decision that changes code gets its own branch, a test run before its commit, and a push.
4. Owner: run the source-integration live checks with the keys.
5. Owner: run `docker compose up --build` on a machine with registry access, and record the result.
