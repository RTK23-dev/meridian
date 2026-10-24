# Setup

How to run Meridian on a laptop or a server. What the product does is in the [README](../README.md). Which keys exist, and which stay off until you opt in, is in [PROVIDERS.md](PROVIDERS.md).

## Requirements

- Node.js 22 (CI uses 22). Nothing else for a local trial.
- PostgreSQL 16 for a real deployment. A local trial needs no database server: it uses an embedded PostgreSQL (PGlite), kept on disk.

## Install and first run

```bash
npm run dev
```

On a fresh clone, that one command does the first run. `npm run dev` (`scripts/dev.mjs`):

- installs the dependencies with `npm ci` if `node_modules` is missing;
- creates `.env` from `.env.example` if `.env` does not exist, and generates `TOKEN_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` into it.
  Setup never overwrites a `.env` and never prints a secret;
- loads `.env`. A variable already set in your shell wins;
- starts the app on http://127.0.0.1:8080, and once it answers, says what is running. On a first start it also prints three steps:
  open the address, create an account, create a workspace and a brand.

`npm run setup` (`scripts/setup.mjs`) does the setup part on its own, and is safe to run again. It also runs the migrations when
`DATABASE_URL` is set, and says so when it is not.

The brand brain is the first screen to complete: the four required fields are positioning, target customers, tone and prohibited claims.

### The local trial (no `DATABASE_URL`)

- **The database is kept on disk** in `.data/pglite`. `npm run dev` sets `MERIDIAN_LOCAL_DATA_DIR` to that folder when `DATABASE_URL`
  is blank. Accounts, workspaces, brands and sign-in sessions survive a restart. Stop the server, delete `.data/pglite`, and start again
  to begin empty. Anything that does not set `MERIDIAN_LOCAL_DATA_DIR` keeps the database in memory, which is what the tests use.
- **The queued jobs run inside `npm run dev`**: Factory runs, research and generation. No `npm run worker` is needed. The log says so
  (`[jobs]` lines). A failed pass is logged and retried with a back-off, and the server keeps running.
- **Periodic work does not run.** Scheduled discovery and performance syncs need `npm run scheduler`, which needs `DATABASE_URL`.
- **Use one dev server per data folder.** `npm run db:local` opens the same `.data/pglite` folder, so do not run it while `npm run dev` runs.
- Production refuses to start without `DATABASE_URL`, unless `NODE_ENV` is explicitly `development` or `test`. `npm run dev` runs in
  `development`, because Vite sets that when `NODE_ENV` is not already set. With `NODE_ENV=production`, a missing `DATABASE_URL` stops
  the start, whatever `MERIDIAN_LOCAL_DATA_DIR` says.

## Saving provider keys

Keys are not set in `.env` for normal use. Open **Settings → General**:

- **Setup** lists each provider with its state from the server: usable, unusable, not configured, or the deployment's shared
  default. Each state has its reason.
- **Provider keys and settings** saves a key for this workspace. Only an admin can save or remove one. A key is stored
  encrypted and is never shown again; the screen shows its last four characters.
- **Google Drive** shows whether Drive is connected, and what is missing if it is not.

The decision engine is chosen on the **Setup** page (`/setup`), where the engine choice offers TypeSafe JEV or OpenAI Decisions. Only one engine receives decisions per workspace. Every provider and its deployment opt-in are listed in PROVIDERS.md.

## Google Drive

Drive stores artifacts and exports only. Postgres holds the data. Connect Drive with one of these, set in `.env`:

- a service account: `GOOGLE_SERVICE_ACCOUNT_KEY` (the JSON key), or
- an OAuth refresh token: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`.

Set `MERIDIAN_DRIVE_FOLDER_ID` to the folder the artifacts go into. The Drive panel reports the state and the missing names.

To connect with OAuth from the app instead, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, enable the Drive API, and register
`<your origin>/api/drive/callback` as the redirect URI. An admin then connects from Settings → General. Uploads over 5 MB need
`TOKEN_ENCRYPTION_KEY`, which `npm run setup` generates.

## Variables for the video engine, the Factory and media links

The full list, with each variable's kind and what reads it, is in [OPERATIONS.md](OPERATIONS.md#environment-variables). The variables this
release reads are:

| Variable | Kind | Purpose |
| --- | --- | --- |
| `APIFY_TOKEN`, `APIFY_SHARED_DEFAULT` | per-workspace key, with a deployment opt-in | Instagram volume discovery (Factory Gather). Save the key in Settings, or set the deployment key and `APIFY_SHARED_DEFAULT=deployment`. |
| `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_SHARED_DEFAULT` | per-workspace secret, with a deployment opt-in | Verifies the Shopify `orders/create` deliveries to `/api/webhooks/shopify`. |
| `OPENROUTER_API_KEY`, `HEYGEN_API_KEY`, `ANTHROPIC_API_KEY`, each with its `*_SHARED_DEFAULT` | per-workspace key, with a deployment opt-in | The video engine's keys. Save them in Settings for each workspace. |
| `MEDIA_FUNCTIONS_BASE_URL` | deployment configuration | The HTTPS base URL of the ffmpeg media functions. Restrict its host before setting it, because the functions carry no credential. |
| `MEDIA_FUNCTIONS_MODE` | deployment configuration | `in_process` runs the ffmpeg handlers in the worker's own process (the root image installs ffmpeg), and needs no base URL. Unset or `http` uses `MEDIA_FUNCTIONS_BASE_URL`. Any other value is a configuration error. |
| `DEEPGRAM_API_KEY` | deployment key (opt-in) | Speech-to-text for reference analysis and the held-call reconciler. Used only with `DEEPGRAM_SHARED_DEFAULT=deployment`; a workspace can save its own key in Settings. |
| `MEDIA_LINK_SECRET` | infrastructure (secret) | Signs the 15-minute media links for Instagram and TikTok. At least 32 characters. |
| `APP_URL`, `PUBLIC_APP_URL` | deployment configuration | The public `https` origin the platforms fetch from. No path. |

Until a variable is set, the feature that needs it stays NOT_CONNECTED and says so. Nothing is sent in its place.

## Hypit runtime (video production, not yet routed in production)

Hypit is licensed under Apache 2.0 with conditions that bar a multi-tenant service and commercial bundling without Hypit.AI's written
authorization. Read `docs/HYPIT_LICENSE.md` before any use beyond one organization.

Hypit is not a skill and not a Docker service in this repository. Meridian talks to one process at `HYPIT_BASE_URL` through the
handoff in `src/lib/meridian/hypit/`, which uses four routes: `POST /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/artifact`
and `/health`. The only implementation of those routes here is `scripts/hypit-bridge.mjs`. It is a single-organization proof runner
that spawns a `hypit` CLI. The CLI is not in this repository and is not in the Meridian image.

To run it yourself, on a host where the Hypit CLI is installed:

```
HYPIT_BIN=<path to the hypit CLI> HYPIT_FFMPEG=/usr/bin/ffmpeg HYPIT_FFPROBE=/usr/bin/ffprobe \
HYPIT_BRIDGE_PORT=8766 HYPIT_JOB_ROOT=<a directory for job folders> HYPIT_API_TOKEN=<a long random token> \
node scripts/hypit-bridge.mjs
```

Set `HYPIT_BRIDGE_HOST` only to the address other machines should reach. Any address other than loopback refuses to start unless
`HYPIT_API_TOKEN` is set. In Meridian's environment set `HYPIT_BASE_URL` to the bridge's URL and `HYPIT_API_TOKEN` to the same token.
The bridge keeps its jobs in memory, so a restart loses them. The production router's `hypit` entry is not connected to this handoff
and refuses every job with `NOT_CONNECTED`, so no production run selects Hypit yet. A multi-tenant runtime and a cost figure for
Hypit are not built or verified. Owner action: run one live job with the real CLI and record the job id, the artifact bytes and the
provider bill, if any.

## Publishing and approving work

Publishing is optional. Paid ads (Meta, TikTok, Google) are created paused, and Meridian never switches them on. Regular posts go to a
Facebook Page, Instagram, YouTube or TikTok account, connected per brand on Connected accounts. The account and token each platform
needs are in [PROVIDERS.md](PROVIDERS.md#organic-publishing-accounts). The export package works without any account.

A Factory run waits at each step that spends or publishes, unless its automation is `full` with a spend cap. A waiting run shows
`awaiting approval` and the reason. The approval is recorded for that run and stage. See [FACTORY.md](FACTORY.md).

## Deploying

1. Create a PostgreSQL 16 database and set `DATABASE_URL`.
2. Set `BETTER_AUTH_URL` to the public address, and `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` to long random values.
   Keep `TOKEN_ENCRYPTION_KEY` safe: saved keys cannot be read without it.
3. Set `NODE_ENV=production`. Do not set `MERIDIAN_TESTING_RUNTIME`; it enables the test providers.
4. `npm run build` compiles the app and applies the migrations.
5. Start the web process, then start the worker (`npm run worker`) and the scheduler (`npm run scheduler`). Without the worker,
   queued jobs wait. Without the scheduler, periodic work never starts. The Docker Compose stack below does all three.

## Docker Compose (not yet verified)

`docker-compose.yml` runs the whole stack: `web` (port 8080), `worker`, `scheduler`, and `postgres` (PostgreSQL 16, with a healthcheck).
The three Meridian services use one image, built from `Dockerfile` (Node 22), and each reads `.env`. Compose sets `DATABASE_URL` for
each of them to the `postgres` service, so `.env` does not need a database URL.

```bash
cp .env.example .env      # or npm run setup, which also fills the two secrets
docker compose up --build
```

Then open http://127.0.0.1:8080. The web service applies the migrations when it starts. The worker and the scheduler start once the web
service answers `/api/health`. The Postgres password in `docker-compose.yml` is a local default: change it, and the `DATABASE_URL` lines,
before any shared deployment.

**This stack has not been built or run in the repository's own checks.** The environment that wrote it had no Docker daemon. The compose
file was checked for its YAML structure only. The first `docker compose up --build` is the real test: check `docker compose ps` for the
healthchecks, and check that the web service serves the built app on port 8080 (it runs `npm run preview`, which serves the output of
`npm run build`). If something differs, fix the Dockerfile and this section together.

`.env.example` lists every variable the code reads, with a comment saying whether it is infrastructure, deployment configuration
or a per-workspace key. It has two parts: "Needed to start", which a local trial reads and which is all optional, and "Needed for a
real deployment".
