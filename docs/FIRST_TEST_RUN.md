# First test run

This is the order to follow for the first run of Meridian with a real workspace. It is written for the owner, who holds the keys. Agents
never hold keys (NORTH_STAR, decision 1), so the steps that call a provider are the owner's to run.

Each step says what it checks, what you should see, and what it does not prove. Where the repo's own check is red today, the step says so.
The state of the code is in [STATE_2026-10-28.md](STATE_2026-10-28.md).

## 0. What is ready and what is not

- **Ready and checked on this commit:** the app starts from a clean checkout with no `.env`, uses an embedded database, and the Settings
  screens work in a browser (`node scripts/release-acceptance/run.mjs`: 30 checks). Typecheck, lint, build and the test suites pass.
- **Not ready:** no provider has been called live. The video engine's acceptance (`npm run engine:e1 -- --dry-run`) is red today, for a
  reason the owner has to decide (step 6). Postgres-backed behaviour is checked in CI, not on a laptop without a server.

## 1. Install

Requirements: Node 22 and npm. For the worker, the scheduler and the Postgres checks: PostgreSQL 16 with the pgvector extension. For the
media tests: ffmpeg and ffprobe.

    npm ci

If the install fails downloading onnxruntime's GPU binaries (the CI runners set this too), run `ONNXRUNTIME_NODE_INSTALL=skip npm ci`.
The CPU runtime ships inside the package.

**Checks:** the install ends without errors.

## 2. Start the app with an embedded database

    npm run dev

Open http://127.0.0.1:8080. With no `DATABASE_URL`, the app uses an embedded database in `.data/pglite`, and it creates `.env` on the first
run. Nothing is sent to any provider.

Create the first account (it becomes the owner), then a workspace and a brand (`/brands/new`). Fill the brand brain: positioning, target
customers, tone and prohibited claims.

**Checks:** the account and the brand survive a restart of `npm run dev`.

## 3. See what is connected

    npm run live:readiness

The report prints names and yes or no only. It never prints a value, and it calls no provider. Each line is a provider or a capability and
the variable it needs. Anything marked "not set" is not connected, and the app says so too.

**Checks:** the report matches what you expect to be connected. A saved key in a workspace is not in this report; Settings shows it.

## 4. Save keys in Settings, one provider at a time

Go to `/settings` (and `/setup` for the guided path). Save each key the first run needs:

- **OpenRouter:** the chat and video catalogue, decisions and speech. Saved keys read "Saved, not checked live" until a live check passes.
- **Deepgram:** speech-to-text for the reference video. Save the key. The engine uses the one Deepgram project the key can see, and
  refuses when there are none or several (`src/engine/media/stt-deepgram.ts`).
- **Google Drive:** where artifacts and exports are kept. The roadmap lists a Drive connection as a requirement for the engine's production
  shots (`docs/ROADMAP.md`).
- **Media functions:** `MEDIA_FUNCTIONS_BASE_URL`, or the worker's in-process mode (`MEDIA_FUNCTIONS_MODE=in_process`).
- **HyperFrames:** the render key. Its price per minute is not set in the repo (see step 6).

Keys go in Settings or in `.env` on the server. They are never written to git, logs or chat. Do not paste a key into a chat or a ticket.

**Checks:** a saved key shows "Saved, not checked live". A live check (where the screen offers one) is recorded only when it passes.

## 5. Check the offline gates on your machine

    npm run typecheck
    npm run lint
    npm test
    npm run build
    node scripts/release-acceptance/run.mjs

**Checks:** all five pass. The acceptance starts its own server on a fresh data directory and sends no provider request; it fails if any
request leaves the local server.

## 6. Run the video engine's dry acceptance

    npm run engine:e1 -- --dry-run

This runs the E1 acceptance on a recorded replay: no network and no keys.

**Expected today: FAIL, 0 of 1 masters passed.** The one failing check is `ledger_bill_settles_render_cost`. The HyperFrames price per
minute is unset, so a render has no provider bill to settle, and the render's cost stays unknown until the owner records the invoice line
(render/STATUS.md). The dry run cannot supply that bill. Every other check passes, including the 1080x1920 output, the frame rate, the
audio, the integrity gate and the single ledger entry.

This is an open owner decision, not a regression to hide. Choose one of these, and record it in `docs/engine/PHASE_LOG.md`:

1. Set the HyperFrames price per minute (`src/engine/config/prices.ts`) and keep the dry run strict. It will still fail until a bill exists.
2. Accept that a dry run cannot prove a bill, and let the dry run report that check as "not proven offline" rather than as a failure.

The live acceptance keeps the strict check either way.

## 7. The first live run (owner)

The first run that means something is one brief, end to end, with one reference video. It needs steps 2 to 4 done, and then:

1. In `/content-factory`, create a session for a brand, attach a reference video, and write the brief.
2. Choose the length, the budget and the priority, then press "Make the video".
3. Watch the board. Each step shows its status, its model and its cost: estimate, reserved and billed. A cost with no bill shows as unknown,
   never as a number.
4. When the video is delivered, approve or reject it in the Content Factory. A shot that is wrong can be remade on its own (see
   `docs/engine/CONTENT_FACTORY_STATE_2026-10-18.md`, section 3).

Record in `docs/engine/PHASE_LOG.md`, for this run: the request id, the artifact ids, each step's cost (estimate, reserved, billed), the
output's file name and its size and duration, and anything that failed with its reason. Record nothing you did not see.

## 8. Postgres mode (optional, for the worker and the scheduler)

    docker compose up --build

This starts the web app, a worker, a scheduler and PostgreSQL 16. It is **not verified on this repo's machine** (no Docker daemon here, and
the base image needs registry access). Run it once on a machine with registry access and record the result. The CI `postgres` job already
runs the money and migration checks against a real PostgreSQL with pgvector.

## 9. Owner checklist

Tick each line when it is done. The questions are in `.claude/loop/OPEN_QUESTIONS.md`, with what each one blocks.

- [ ] **Q2, the dry-run policy.** Choose step 6, option 1 (set the HyperFrames price) or option 2 (report the bill check as not proven offline).
- [ ] **Q10, Q11 and Q13, decided by the loop.** Confirm each, or reverse it. Q10 is how the gate runs the source tests locally. Q11 is the hook-timing decisions. Q13 is the asset router's closure, which stays whole.
- [ ] **Q12, where the secret reads live.** The secret values are read through the accessors in `src/lib/meridian/credentials/secret-settings.ts`. The ratchet in `server-settings.test.ts` now holds at 14 direct reads (it was 38).
- [ ] **Q6 and Q8, the pull request.** Merge PR #85 when it is ready, or keep it open, or split it. The run's commits stack on its branch until you decide.
- [x] **Q9, the permission rules.** Written to `.claude/settings.json`: full coding permissions, with the hard stops (env files, publishing, live provider runs, force pushes, merges) denied.
- [ ] **Q1, Q3, Q4, Q5 and Q7.** The preset contract change, the 45 test-only modules, the E6 server functions, the export package, and the reference reels. Each one is open, and nothing depends on it until you answer.
- [ ] **Step 4, the keys.** Save each provider's key in Settings and set the monthly budget. Set the budget before any live step.
- [ ] **Step 7, the first live run.** Run one brief, end to end, with one reference video. Record the request id, the artifact ids, each step's cost (estimate, reserved, billed), and the output's file, size and duration in `docs/engine/PHASE_LOG.md`.
- [ ] **Step 8, Postgres mode.** Run `docker compose up --build` once on a machine with registry access, and record the result.

## What not to do

- Do not run a live step without the keys and the budget set. The budget caps are the owner's safety net.
- Do not call a feature live from a fixture. Fixture-tested is the honest word.
- Do not merge a PR because the dry run is green. Read which checks are green and which were not run.
