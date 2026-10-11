# Architecture

Meridian is one TanStack Start application (React 19, Tailwind v4) on PostgreSQL, with a separate worker process and a scheduler
process. Every piece of data belongs to one workspace (organization), and most rows also belong to one brand.

## Layers

- `src/routes/` holds the screens (file-based routes) and the server route handlers under `api/`. `routeTree.gen.ts` is generated
  by the router and is never edited by hand.
- `src/components/` holds the UI. The design system is in `components/ui/`.
- `src/lib/meridian/` holds the domain logic and the server functions (`createServerFn`). The main modules:
  - `credentials/` resolves every provider key for a workspace (see PROVIDERS.md).
  - `decisions/` and `jev/` hold the decision engines, the policy gate and the evidence scopes (see DECISIONS.md).
  - `studio/` builds briefs and variants, and records reviews and publishing.
  - `production/` routes a creative to a production provider (Gemini Omni, Hypit, Higgsfield, manual cloud, image providers).
  - `sources/`, `discovery/`, `research/` and `evidence/` collect public sources and store evidence with its provenance.
  - `brand/` stores the brand brain, its versions and its onboarding progress.
  - `settings/` holds the provider settings summary and the save and test actions.
  - `storage/` writes artifacts and exports, and serves media.
  - `measurement/`, `learning/` and `publishing/` record what happened after publishing and feed it back.
- `src/lib/db.ts` picks the database. A `DATABASE_URL` selects PostgreSQL. Without one, development and tests use an embedded
  PostgreSQL (PGlite). Any other environment refuses to start (OPERATIONS.md).

## Data

- PostgreSQL is the system of record. The schema is in `migrations/`, applied in filename order by `npm run db:migrate`
  (and by `npm run build`). A migration is never edited after it has been applied.
- Every query that reads or writes workspace data filters by `organization_id`, and brand data also by `brand_id`. The server
  functions check the caller's role and tenancy before they read.
- Money is recorded in micro-units in the budget ledger. Generation reserves budget before a provider call (ARCHITECTURE_CONTRACTS.md, section 5).

## Workers and scheduling

- The web process does not run jobs. `npm run worker` runs the durable job loop (`scripts/worker-entry.ts`). Jobs are claimed
  under a lease, so a crashed worker's job is picked up again.
- `npm run scheduler` enqueues the periodic work (`scripts/scheduler-entry.ts`), such as discovery runs and performance syncs.
- Both processes need the same `DATABASE_URL` as the web process.

## Storage and media

- Postgres holds every row. Google Drive and S3 hold only artifacts and exports (rendered media, export packages, uploaded
  source files). An upload is resumable: its session is recorded in Postgres, and an interrupted upload continues from the
  last confirmed byte.
- Media is served from `/api/assets/:assetId`. The route checks tenancy and supports byte ranges and cache validators.

## Authentication and health

- Sign-in uses better-auth. `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET` configure it. Sign-up is open to the people the
  deployment invites; the deployment decides how.
- `GET /api/health` is a liveness check: `{ "status": "ok" }`, with no database read. `?detail=1` returns operational detail
  to a signed-in workspace admin only.

## Frontend data

- Reads and writes go through React Query. A write reports pending, success and failure through one hook.
- Forms use one zod schema shared by the browser and the server, so the field errors match what the server would refuse.
