# Setup

Meridian 0.1.0-beta.8. Node.js 22 and a Postgres database.

## 1. Install

```bash
git clone https://github.com/RTK23-dev/meridian.git
cd meridian
npm install
cp .env.example .env
```

Edit `.env`. Do not commit it. You can also configure credentials directly from the application interface under `/settings`.

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

## 4. Sign in and configure providers

1. Open `/login` and create an email account.
2. Create a workspace if you are not already in one.
3. Open **Settings → Provider Integrations** (`/settings`) to configure credentials securely (stored AES-256-GCM encrypted in the workspace vault):
   - **JEV Intelligence**: Choose TypeSafe Direct (`TYPESAFE_JEV_API_KEY`) or OpenRouter (`OPENROUTER_API_KEY`).
   - **Perception**: Google AI Studio Gemini API Key for transcription and OCR.
   - **Sources & Crawling**: Crawl ladder boundaries and Meta Ad Library token.
   - **Production**: Gemini Omni Flash or Veo video generation key.
   - **Storage**: Google Drive Service Account credentials.
4. Add a brand and fill Brand Brain: offer, audience, proof, and what the brand will not say.
5. Record market observations, crawl a public page, or run a deep contrast study.
6. Open Studio. Rank an opportunity, inspect JEV provenance via the **Why this decision?** drawer, accept the brief, and generate variants.

## 5. Studio Video Production (`ProductionRouter`)

Meridian routes creative production through `ProductionRouter`, supporting multiple video execution engines:

1. **ManualCloud (Zero Spend)**: Prepares production manifests and Google Drive drop folders for manual editor workflows.
2. **Google Veo**: High-fidelity AI video generation via `predictLongRunning` (`MERIDIAN_VEO_MODEL`, `GOOGLE_AI_STUDIO_API_KEY`).
3. **Higgsfield AI**: Generative camera-directed video models (`HIGGSFIELD_API_KEY`, `HIGGSFIELD_MODEL`, e.g., `dop-v1`, `higgsfield-video-v1`).
4. **Hypit Video Engine**: Multi-segment UGC video assembly via local bridge (`HYPIT_BASE_URL`).

### Optional Hypit setup

Hypit is not bundled in this repository. Install it and start the HTTP bridge:

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

### Google Drive Primary Storage Setup

Meridian uses Google Drive as the primary authoritative store for binary media, mapped through Postgres `storage_objects`:

```
GOOGLE_DRIVE_FOLDER_ID=your_drive_root_folder_id
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Media `<= 5MB` uploads via multipart; media `> 5MB` uses resumable chunked upload sessions.

## 6. Optional connections

Leave a variable blank to keep that provider not connected.

| You want | Set | Then |
| --- | --- | --- |
| Google Drive Primary Storage | `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Media stored to Drive; falls back to local storage if unset. |
| Google Veo Video | `GOOGLE_AI_STUDIO_API_KEY`, `MERIDIAN_VEO_MODEL` | Asynchronous generative video generation via Google Cloud. |
| Higgsfield AI Video | `HIGGSFIELD_API_KEY`, `HIGGSFIELD_MODEL` | Generative video via Higgsfield official REST API. |
| Hypit video | `HYPIT_BASE_URL` | Studio video. A file is stored only after Hypit returns MP4 bytes. |
| OpenRouter / JEV Decisions | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Native Decisions API judgments (`typesafe/jev-1.13`). |
| Optional Nano Banana images | `GOOGLE_AI_STUDIO_API_KEY`, optional `GOOGLE_NANO_BANANA_MODEL` | Image generation. Missing configuration skips optional images. |
| S3-compatible files | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Secondary S3 object storage client. |
| Invite email | `EMAIL_API_URL`, `EMAIL_API_KEY` | The API receives JSON `{ to, subject, text }` with a bearer token. |
| External embeddings | `EXTERNAL_SEMANTIC_URL`, `EXTERNAL_SEMANTIC_KEY` | OpenAI-compatible `POST` with `{ model, input }`. Local MiniLM is used when blank. |
| Meta, TikTok, Google | The tokens in `.env.example`; Meta video publishing also needs the tenant's intended `META_AD_ACCOUNT_ID` | An admin uses Integrations, tests connection, and publishes only after probe succeeds. |
| JEV Research collection | `META_AD_LIBRARY_TOKEN`, `OPENROUTER_API_KEY`, local WhisperX, `ffmpeg`/`ffprobe` on worker | Research stays `NOT_CONNECTED` without connections. Snapshot media stays off unless `RESEARCH_SNAPSHOT_MEDIA=1`. |
| OAuth and webhooks | App ids, `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SECRET` | Tokens are sealed. Webhook posts without a valid signature are rejected. |

### Multi-channel social distribution & organic connectors

Meridian supports dual-track distribution across paid ad accounts and organic social channels:
- **Paid Advertising**: Meta Ads, TikTok Ads, Google Ads (requires ad accounts configured via Integrations).
- **Organic Social**: Instagram Reels, Facebook Pages, YouTube Shorts (stored under `channel_connections` and `organic_posts` via migration `0020_organic_publishing.sql`).

Publishing options can be selectively configured in Studio per variant. Telemetry ingestion updates Bayesian posteriors with organic engagement metrics (`retention_3s`, `completion_rate`, `shares`).

### Modular n8n-style flow pipelines

Engines (`GradingEngine`, `PlannerEngine`, `PublishEngine`, `VideoEngine`, `SourceAdapter`) are pluggable. Custom pipelines can be wired using `createFlow("pipeline-id")` without modifying core database schemas or server functions.

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
