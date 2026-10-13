# Meridian

Meridian is a multi-tenant advertising operating system. It holds a brand's own facts, turns evidence into creatives, decides which
creatives may go out, exports them for posting, and records what happened afterwards.

**Status: prerelease.** The package and the tag are `0.1.0-beta.11`. Read the upgrade notes in [docs/OPERATIONS.md](docs/OPERATIONS.md) before
deploying. See [CHANGELOG.md](CHANGELOG.md).

## What works in this release

- **Brand brain.** 26 fields in five sections. Four are required for generation. Saves change only the fields the person changed.
- **Products, market and opportunities.** Public web pages are read end to end, with provenance and deduplication. Each source shows its own state.
- **Studio.** A brief passes a gate before it can generate. Variants carry their evidence, decision and review. Video uses Gemini Omni by default.
- **Decisions.** One engine per workspace, TypeSafe JEV or OpenAI Decisions. A versioned policy turns answers into approve, review or reject.
- **Content Factory (partial).** One run settings object with brand defaults. `manual`, `semi` and `full` automation stop at the steps that
  spend or publish, and a person approves a stop. Ads are graded from their observed stop time. See [docs/FACTORY.md](docs/FACTORY.md).
- **Publishing.** Paid ads are created paused, and Meridian never switches them on. Regular posts go to a Facebook Page, Instagram, YouTube
  or TikTok account that is connected per brand.
- **Library and exports.** Creatives, their lineage, and an export package for manual posting.
- **Google Drive.** Admins connect from Settings with OAuth. Drive stores artifacts and exports only.
- **Settings.** Provider keys per workspace, encrypted and never shown again, with a setup view that states what is connected and why not.

## What is not connected or not verified

- Instagram Reels posting reports not connected. Facebook Page, YouTube Shorts and TikTok regular videos go through a connected account, but
  no live call was made in this release. The export package is the delivery path for everything else.
- Live source APIs are built and tested against fixtures. No live key was used, so their live responses are unverified.
- Factory spend caps are declared, not enforced: no stage writes metered spend yet. The JEV grade is not built. Live organic metrics are not
  pulled from any platform.
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
| `docker compose up --build` | The web app, worker, scheduler and PostgreSQL 16 (see [docs/SETUP.md](docs/SETUP.md)) |
| `npm run db:migrate` | Applies migrations |
| `npm test` | Unit and integration tests |
| `npm run typecheck`, `npm run lint` | Type and lint checks |
| `npm run build` | Production build, then migrations |
| `npm run e2e`, `npm run ui:button-audit`, `npm run ui:baseline` | Browser checks against the running app |

## Documentation

Start with [docs/README.md](docs/README.md). It indexes the setup guide, the architecture, the numbered contracts the code follows,
the provider and key reference, the decision engine, the product workflow, operations, testing and the roadmap.

## Verification

CI runs `check` (tests, typecheck, lint, build), `ui-smoke` (baseline screenshots, design-system checks) and `e2e` (the product loop).
See [docs/TESTING.md](docs/TESTING.md).
