# Meridian

Meridian is a multi-tenant advertising operating system. It holds a brand's own facts, turns evidence into creatives, decides which
creatives may go out, exports them for posting, and records what happened afterwards.

**Status: prerelease.** The package is `0.1.0-beta.11`, and the tag `v0.1.0-beta.11` is not cut yet. See [CHANGELOG.md](CHANGELOG.md).

## What works in this release

- **Brand brain.** 26 fields in five sections. Four are required for generation. Saves change only the fields the person changed.
- **Products, market and opportunities.** Public web pages are read end to end, with provenance and deduplication. Each source shows its own state.
- **Studio.** A brief passes a gate before it can generate. Variants carry their evidence, decision and review. Video uses Gemini Omni by default.
- **Decisions.** One engine per workspace, TypeSafe JEV or OpenAI Decisions. A versioned policy turns answers into approve, review or reject.
- **Library and exports.** Creatives, their lineage, and an export package for manual posting.
- **Google Drive.** Admins connect from Settings with OAuth. Drive stores artifacts and exports only.
- **Settings.** Provider keys per workspace, encrypted and never shown again, with a setup view that states what is connected and why not.

## What is not connected or not verified

- Instagram Reels posting reports not connected. Facebook Page and YouTube Shorts posting go through a connected account, but no live call was made in this release. The export package is the delivery path for everything else.
- Live source APIs are built and tested against fixtures. No live key was used, so their live responses are unverified.
- Calibration. Every probability and score is uncalibrated, so none approves or rejects on its own.

[ROADMAP.md](docs/ROADMAP.md) lists what is open, with the reason for each item.


## Quick start

Requirements: Node.js 22. PostgreSQL 16 for anything beyond a local trial.

```bash
npm run setup     # creates .env, generates the secrets, runs migrations if DATABASE_URL is set
npm run dev       # http://127.0.0.1:8080
```

Create an account, a workspace and a brand, then complete the brand brain. Provider keys are saved in **Settings → General**.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | One-time setup, safe to repeat |
| `npm run dev` | Development server on port 8080 |
| `npm run worker` | Runs queued jobs (needed in production) |
| `npm run scheduler` | Runs periodic work (needed in production) |
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
