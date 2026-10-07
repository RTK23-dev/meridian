# Setup

Meridian 0.1.0-beta.4. Node.js 22 and a Postgres database.

## 1. Install

```bash
git clone https://github.com/RTK23-dev/meridian.git
cd meridian
npm install
cp .env.example .env
```

Edit `.env`. Do not commit it.

## 2. Database

Use one of these. The app reads `DATABASE_URL`.

### Your own Postgres

```bash
createdb meridian
```

```
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/meridian
```

### Embedded Postgres, no separate server

This is for a single machine. The data directory is `.data/pglite`, which git ignores. Stop it with Ctrl-C.

```bash
npm run db:local
```

In another shell:

```
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable
```

`PGLITE_PORT` and `PGLITE_DATA` change the port and directory.

### Apply the schema

```bash
npm run db:migrate
```

Migrations in `migrations/` run in filename order, once each, inside a transaction. `npm run build` runs the same command and skips it when `DATABASE_URL` is unset. There is no automatic down migration. Restore a backup to roll back.

`NODE_ENV=production` without a real `DATABASE_URL` refuses to start. The embedded database is for local preview only.

## 3. Web, worker, and scheduler

Three processes share `DATABASE_URL`.

```bash
npm run dev          # http://127.0.0.1:8080
npm run worker       # claims jobs, heartbeats, retries
npm run scheduler    # inserts due jobs, does not run them
```

`GET /api/health` reports the database and whether those heartbeats are fresh. A missing heartbeat is `stopped`. The web process does not pretend to be the worker.

On a host that is not your laptop, run the worker and the scheduler as long-lived processes. A serverless web deploy does not keep them alive between requests. See [DEPLOYMENT.md](DEPLOYMENT.md).

## 4. Sign in and create a brand

1. Open `/login` and create an email account.
2. Create a workspace if you are not already in one.
3. Add a brand and fill Brand Brain: offer, audience, proof, and what the brand will not say.
4. Record market observations, or fetch one public page.
5. Open Studio. Rank an opportunity, accept the brief, and generate variants.

JEV model calls use OpenRouter (`OPENROUTER_API_KEY` and `OPENROUTER_MODEL`). Studio images are optional and can use Google AI Studio / Nano Banana when `GOOGLE_AI_STUDIO_API_KEY` is set. An image provider is not required for JEV or Hypit. Studio sends an approved JEV brief to a separate Hypit process. Without `HYPIT_BASE_URL`, generation stops at `HYPIT_NOT_CONNECTED` and stores no file. A verified stored Hypit MP4 can enter the Meta publishing flow only after the approved JEV decision and tenant/brand lineage are revalidated.

## 5. Hypit video

Hypit is not part of this repository. Install it yourself and follow its license. This app only talks to it over HTTP.

```bash
npm install @hypit/hypit@0.2.17
```

`ffmpeg` and `ffprobe` must be on `PATH`. Then, in another terminal:

```bash
export HYPIT_BIN="$(pwd)/node_modules/.bin/hypit"
export HYPIT_BRIDGE_PORT=8766
node scripts/hypit-bridge.mjs
```

In `.env`:

```
HYPIT_BASE_URL=http://127.0.0.1:8766
```

The bridge shells out to the Hypit CLI. It does not copy Hypit source into Meridian. A rejected or unapproved JEV decision never becomes a job. `scripts/hypit-product-loop.mjs` is a live smoke test against that process. It is not part of `npm test`.

When the tenant has a working Meta credential and matching `META_AD_ACCOUNT_ID`, Studio publishing uploads the verified MP4 through Meta, records Meta's confirmed video id, and then creates the existing campaign/ad-set/creative/ad chain in `PAUSED` state. Upload reservations and reconciliation prevent a normal retry from posting a second video when the first response is ambiguous. Ads are not activated. Without valid Meta credentials/account configuration, the flow reports `NOT_CONNECTED`; no live receipt is created. See [PROVIDERS.md](PROVIDERS.md) for behavior and external requirements.

## 6. Optional connections

Leave a variable blank to keep that provider not connected.

### JEV Research collection

The first research source is Meta Ad Library video ads. Configure `META_AD_LIBRARY_TOKEN` and `OPENROUTER_API_KEY`. The long-lived worker needs local WhisperX plus `ffmpeg` and `ffprobe`; set `WHISPERX_PATH`, `WHISPERX_MODEL` (defaults to `small`), `WHISPERX_DEVICE` (defaults to `cpu`), `FFMPEG_PATH`, and `FFPROBE_PATH` when installed outside `PATH`. Snapshot video download stays off unless `RESEARCH_SNAPSHOT_MEDIA=1` after an explicit rights review. A Meta snapshot that does not expose an explicit downloadable MP4 remains unavailable and is not transcribed or analyzed. No hosted transcription key is required.

Research is available only when these connections are configured. Missing credentials produce `NOT_CONNECTED`. Low-confidence structured analyses are retained with review status. Pattern summaries report observed corpus frequency only. Cross-brand organization summaries have no examples and are consumed only by brands that explicitly opt into organization learning in Learning settings.

| You want | Set | Then |
| --- | --- | --- |
| Hypit video | `HYPIT_BASE_URL` | Studio video. A file is stored only after Hypit returns MP4 bytes. |
| OpenRouter / JEV | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | JEV's model-backed analysis and decisions. |
| Optional Nano Banana images | `GOOGLE_AI_STUDIO_API_KEY`, optional `GOOGLE_NANO_BANANA_MODEL` | Image generation. Missing configuration skips optional images. |
| S3-compatible files | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The active store switches after the client is configured. `S3_REGION` defaults to `us-east-1`. |
| Invite email | `EMAIL_API_URL`, `EMAIL_API_KEY` | The API receives JSON `{ to, subject, text }` with a bearer token. A failure leaves the invite pending. |
| External embeddings | `EXTERNAL_SEMANTIC_URL`, `EXTERNAL_SEMANTIC_KEY` | OpenAI-compatible `POST` with `{ model, input }`. Local MiniLM is used when these are blank. |
| Meta, TikTok, Google | The tokens in `.env.example`; Meta video publishing also needs the tenant's intended `META_AD_ACCOUNT_ID` and a usable Meta ad account | An admin uses Integrations, tests the connection, and publishes only after the probe succeeds. Meta Hypit video publication creates a paused chain; it does not activate it. |
| JEV Research collection | `META_AD_LIBRARY_TOKEN`, `OPENROUTER_API_KEY`, local WhisperX, `ffmpeg`/`ffprobe` on the worker | Research stays `NOT_CONNECTED` without source/model/runtime connections. Ads whose snapshots expose no downloadable MP4 stay unavailable. Snapshot media stays off unless `RESEARCH_SNAPSHOT_MEDIA=1`. |
| OAuth and webhooks | App ids, `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SECRET` | Tokens are sealed. Webhook posts without a valid signature are rejected. |

`TOKEN_ENCRYPTION_KEY` is a secret you generate, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`BETTER_AUTH_SECRET` should be a different long random string in production. `BETTER_AUTH_URL` is the public origin, such as `https://your-host.example`.

## 7. Checks before you ship a change

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`node scripts/a11y-audit.mjs` signs up through the real form against an already running app. It is not a screen-reader pass.

## 8. What a healthy empty install looks like

- `/api/health` has `application: up` and `database: up`.
- Worker and scheduler are `running` only while those processes are up.
- Integrations show Meta, TikTok, Google, and Ad Library as not configured.
- Video is `HYPIT_NOT_CONNECTED` until `HYPIT_BASE_URL` answers. A configured URL is not a generated clip.
- Meta Hypit video publishing and Meta performance sync remain `NOT_CONNECTED` until a valid tenant credential and matching ad account are connected. No live provider receipt or observation is substituted.
- Creating a brand, storing an observation, and ranking it does not require any ad account.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Migrations say `DATABASE_URL not set` | `npm run db:migrate` reads `.env` and does not override a variable already in the shell. Put the URL in `.env`, or export it. |
| Health says the worker is stopped | Start `npm run worker` on a machine that can reach the same database. |
| Studio says Hypit is not connected | `HYPIT_BASE_URL` is empty, or the bridge is not running. No video was stored. |
| Studio skips optional images | `GOOGLE_AI_STUDIO_API_KEY` is missing or the provider rejected the request. JEV and Hypit video are unaffected. |
| Invite says nobody was notified | `EMAIL_API_URL` or `EMAIL_API_KEY` is missing, or the provider returned an error. The row is still in `invites`. |
| Publish button does not create a campaign | The account is not healthy, or a required id (page, budget, country, link, or uploaded media id) is missing. |
| Build works and the site is blank | Confirm `/assets/*` is served as JavaScript, not HTML. See [DEPLOYMENT.md](DEPLOYMENT.md). |
