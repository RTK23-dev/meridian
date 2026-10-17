# Meridian

Meridian is a multi-tenant advertising operating system. It holds a brand's own facts, turns evidence into creatives, decides which
creatives may go out, exports them for posting, and records what happened afterwards.

**Status: prerelease.** The package version and the tag are `0.1.0-beta.12`. Read the upgrade notes in [docs/OPERATIONS.md](docs/OPERATIONS.md)
before deploying. Migrations 0077 to 0102 are new in this line. See [CHANGELOG.md](CHANGELOG.md).

## What works in this release

- **Brand brain.** 26 fields in six sections. Four are required for generation.
- **Products, market and opportunities.** Public web pages are read end to end, with provenance and deduplication. Each source shows its own state.
- **Studio.** A brief passes a gate before it can generate. Variants carry their evidence, decision and review. Video uses Gemini Omni by default.
- **Decisions.** One engine per workspace, TypeSafe JEV or OpenAI Decisions. A versioned policy turns answers into approve, review or reject.
- **Video engine (`src/engine/`).** Phases E1 to E6 are code complete on recorded fixtures. They cover the scene plan and edit decision list,
  the composition compiler and components, the budget engine (reserve, extend, cap mode), the asset router, the Claude roles, the take,
  pre-render and post-render gates, variants, the Shotstack fallback, chains for cartoon shots (stop motion is refused until `image.edit`
  has a price), and the operations layer. Every model, API and render call goes through one gateway, with OpenRouter as the default
  platform. Since 2026-10-17 a brief request writes its own script, narration goes through OpenRouter speech, an orchestrator picks each
  production model from OpenRouter's catalog, speech-to-text is Deepgram, ffmpeg runs on the worker, and held calls are settled by a
  reconciler once their bill is readable. No live run is recorded for any phase. See [docs/engine/PHASE_LOG.md](docs/engine/PHASE_LOG.md).
- **Content Factory.** One run settings object with brand defaults. `manual`, `semi` and `full` automation stop at the steps that spend or
  publish, and a person approves a stop. Before each engine call in the grade stage, the kill switch and the run's daily and total caps are
  checked; a refused call leaves that ad graded on observed signal only, with the reason. Ads are graded from their observed stop time and,
  with a decision engine, by JEV, both stored side by side. A run can name the Meridian video engine as its video provider. See
  [docs/FACTORY.md](docs/FACTORY.md).
- **Content Factory page (`/content-factory`).** Admin only. A chat that starts a video from any idea: type instructions, attach files from
  your computer (a video as the reference, images, text up to 4000 characters; PDFs are kept but their text is not read yet), and attach
  records from Meridian pages. The engine analyses the reference, writes the script, picks the models, and makes the video. Each stage
  shows its model and its cost; a cost with no bill shows as unknown. Built on recorded fixtures. See
  [docs/FACTORY.md](docs/FACTORY.md#content-factory-page-content-factory).
- **Discovery at volume (Factory Gather).** Instagram reels are gathered per niche through Apify, each with its creator's baseline and a
  tier from S to C, or "not rated" with the reason. Snapshots are scheduled at 24 and 72 hours after discovery. Tested on fixtures.
- **Theme pages.** An account-level object that a Factory run can target: its linked platform account, persona, voice and style kits, posting
  schedule (with a time zone), and whether its Instagram posts start as trial reels. Screen: `/brands/<brand>/pages`.
- **Instagram trial reels.** A trial post names its graduation strategy, MANUAL or SS_PERFORMANCE. A scheduled check reads the reel's
  documented fields once a day, for up to seven checks.
- **Sales attribution (Shopify).** A Shopify shop connects to one workspace by its `myshopify.com` domain. The `orders/create` webhook stores
  each order and links it to a reel by `utm_content`, or by a DM keyword in a discount code or note attribute. A tie links nothing.
- **Sleep mode.** Off until a person turns it on and sets a niche. Each night gathers, grades and plans through the Factory's own stages, then
  waits at produce for a person's approval. A 10% holdout is assigned and recorded. Any tuned-value change a night is given is held to 15%,
  and each refusal is in the morning summary. Production gives a night no tuned values yet.
- **Publishing.** Paid ads are created paused, and Meridian never switches them on. Regular posts go to a Facebook Page, Instagram, YouTube
  or TikTok account that is connected per brand.
- **Library and exports.** Creatives, their lineage, and an export package for manual posting.
- **Google Drive.** Admins connect from Settings with OAuth. Drive stores artifacts and exports only.
- **Settings.** Provider keys per workspace, encrypted and never shown again, with a setup view that states what is connected and why not.

## What is not connected or not verified

- **Live spend is not proven.** Do not connect a live provider key to the video engine until the owner's live run is recorded. The render's
  cost is no longer booked from an estimate, a server error no longer retries a paid submit, and a cap-mode raise pauses (see the
  2026-10-17 entry in [docs/engine/PHASE_LOG.md](docs/engine/PHASE_LOG.md)). Held calls from a failed or stopped request stay in the monthly
  total until a rejection or a delivery releases them. Whether a held call should alert is an owner decision. The Factory's own caps are
  checked per run and per brand, and unpriced image providers are refused.
- **No live run of the video engine.** Agents hold no keys, so each phase's live acceptance (Bible section 19) is the owner's run. Production
  shots stay NOT_CONNECTED until `MEDIA_FUNCTIONS_BASE_URL` is set (or `MEDIA_FUNCTIONS_MODE=in_process` on the worker), the workspace has a
  Google Drive connection and an OpenRouter key. Narration (OpenRouter speech) and speech-to-text (Deepgram) run on request shapes that are
  not yet verified live, so their bills are unverified. The HyperFrames price, the platform file-size limit, and the lip-sync and avatar
  vendors are still owner items, listed in [docs/ROADMAP.md](docs/ROADMAP.md).
- **Content Factory page.** Built on recorded fixtures. PDF text is not read, and an image's pixels are not used. Text files need a connected
  Google Drive and a brand. Revisions after the first run are not built. The first brief run with a reference video is the owner's to record.
- **Docker.** The compose stack has not been built in the repository's checks. The base image pull was rate-limited when it was last tried.
- **Factory discovery.** The Apify key and plan price are not set, and the cost per 1,000 results is unknown, so no discovery cost is
  estimated. Without a key the source reports not connected.
- **Trial reel feed step.** Meta documents no field that reports graduation, so the feed step is recorded only when Meridian observes a
  graduation. The live reader observes none, so a trial stays "manual action required". A MANUAL trial graduates when a person does it in
  the Instagram app; an SS_PERFORMANCE trial graduates when Instagram decides.
- **Shopify.** The webhook answers 200 for a stored order and for a repeat delivery, refuses a bad signature, and answers 503 when no usable
  secret is set. No live shop has sent an order, so the attribution has not been seen with real orders.
- **Sleep mode.** The holdout is recorded, but production does not read it yet. Production gives a night no tuned values, so the 15% cap
  has nothing to hold yet. Sleep mode writes no engine configuration, so an accepted change would only be recorded.
- **Factory caps.** Caps count priced, metered spend only. A video's estimate is held against the caps but is not metered spend, and a
  provider call that reports no cost is not counted. Without a decision engine, a Factory ad is graded on its observed signal only.
- Live source APIs are built and tested against fixtures. No live key was used, so their live responses are unverified.
- **Live organic metrics.** Instagram Reels, YouTube Shorts and TikTok metrics are read through each channel's stored token and stored only as
  observed values. No live call was made. Facebook Page is not implemented. Regular posts publish through a connected account and a signed
  media link (`MEDIA_LINK_SECRET`, `APP_URL`, and for TikTok `TIKTOK_VERIFIED_MEDIA_DOMAINS`), and show not connected until those are set.
- Calibration. Every probability and score is uncalibrated, so none approves or rejects on its own.

[ROADMAP.md](docs/ROADMAP.md) lists what is open, with the reason for each item.


## Quick start

Requirements: Node.js 22. Nothing else for a local trial. A real deployment uses PostgreSQL 16, or the Docker Compose stack in
[docs/SETUP.md](docs/SETUP.md).

```bash
npm run dev       # first run installs the dependencies and creates .env; then http://127.0.0.1:8080
```

The first run creates `.env` from `.env.example`, generates the two secrets, and prints three steps:

1. Open http://127.0.0.1:8080.
2. Create an account. On the sign-in page, choose **Create an account instead**.
3. Create a workspace and a brand, then complete the brand brain. Provider keys are saved in **Settings → General**.

The local database is kept in `.data/pglite`, so accounts, workspaces and brands are still there after a restart. The queued jobs run
inside `npm run dev` as well, so you do not need a second terminal. Set `DATABASE_URL` to use PostgreSQL instead.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Sets up on the first run, then runs the app on port 8080. Without `DATABASE_URL` it also runs the queued jobs |
| `npm run setup` | Creates `.env` and generates the secrets, safe to repeat. Runs migrations when `DATABASE_URL` is set |
| `npm run worker` | Runs queued jobs when `DATABASE_URL` is set (production) |
| `npm run scheduler` | Runs periodic work when `DATABASE_URL` is set (production) |
| `docker compose up --build` | The web app, worker, scheduler and PostgreSQL 16 (see [docs/SETUP.md](docs/SETUP.md)). Not yet built or run in the repository's checks |
| `npm run db:migrate` | Applies migrations |
| `npm test` | Unit and integration tests |
| `npm run typecheck`, `npm run lint` | Type and lint checks |
| `npm run build` | Production build, then migrations |
| `npm run e2e`, `npm run ui:button-audit`, `npm run ui:baseline` | Browser checks against the running app |
| `npm run engine:golden` | Video engine golden frames. Renders locally, so it needs ffmpeg and a Chrome headless shell (`HYPERFRAMES_BROWSER_PATH`). Not part of `npm test` |
| `npm run engine:e1 -- --dry-run` | Video engine E1 acceptance on the recorded replay (no network, no keys). The live run is in [scripts/engine/README.md](scripts/engine/README.md) |

## Documentation

Start with [docs/README.md](docs/README.md). It indexes the setup guide, the architecture, the numbered contracts the code follows,
the provider and key reference, the decision engine, the product workflow, operations, testing and the roadmap. The video engine's
specification, handoff and phase log are in [docs/engine/](docs/engine/). The latest checkpoint, with what is verified, what is not and
the owner's open decisions, is [docs/engine/CHECKPOINT_2026-10-17_final.md](docs/engine/CHECKPOINT_2026-10-17_final.md).

## Verification

CI runs `check` (tests, typecheck, lint, build), `ui-smoke` (baseline screenshots, design-system checks) and `e2e` (the product loop).
See [docs/TESTING.md](docs/TESTING.md).
