# Setup

Meridian 0.1.0-beta.1. Node.js 22 and a Postgres database.

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

Image and video generation need `XAI_API_KEY`. Without it, Studio reports the model as unavailable and stores no file. `test:video` is not a production provider and is off unless a test turns it on.

## 5. Optional connections

Leave a variable blank to keep that provider not connected.

| You want | Set | Then |
| --- | --- | --- |
| xAI images and video | `XAI_API_KEY` | Generate from Studio. A file is stored only after bytes come back. |
| S3-compatible files | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The active store switches after the client is configured. `S3_REGION` defaults to `us-east-1`. |
| Invite email | `EMAIL_API_URL`, `EMAIL_API_KEY` | The API receives JSON `{ to, subject, text }` with a bearer token. A failure leaves the invite pending. |
| External embeddings | `EXTERNAL_SEMANTIC_URL`, `EXTERNAL_SEMANTIC_KEY` | OpenAI-compatible `POST` with `{ model, input }`. Local MiniLM is used when these are blank. |
| Meta, TikTok, Google | The tokens in `.env.example` | An admin uses Integrations, tests the connection, and publishes only after the probe succeeds. |
| OAuth and webhooks | App ids, `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SECRET` | Tokens are sealed. Webhook posts without a valid signature are rejected. |

`TOKEN_ENCRYPTION_KEY` is a secret you generate, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`BETTER_AUTH_SECRET` should be a different long random string in production. `BETTER_AUTH_URL` is the public origin, such as `https://your-host.example`.

## 6. Checks before you ship a change

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`node scripts/a11y-audit.mjs` signs up through the real form against an already running app. It is not a screen-reader pass.

## 7. What a healthy empty install looks like

- `/api/health` has `application: up` and `database: up`.
- Worker and scheduler are `running` only while those processes are up.
- Integrations show Meta, TikTok, Google, and Ad Library as not configured.
- Video is `NOT_CONNECTED` until `XAI_API_KEY` is set, then `CONFIGURED`. Configured is not a generated clip.
- Creating a brand, storing an observation, and ranking it does not require any ad account.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Migrations say `DATABASE_URL not set` | `npm run db:migrate` reads `.env` and does not override a variable already in the shell. Put the URL in `.env`, or export it. |
| Health says the worker is stopped | Start `npm run worker` on a machine that can reach the same database. |
| Studio says the model is unavailable | `XAI_API_KEY` is missing or the provider rejected the request. No file was stored. |
| Invite says nobody was notified | `EMAIL_API_URL` or `EMAIL_API_KEY` is missing, or the provider returned an error. The row is still in `invites`. |
| Publish button does not create a campaign | The account is not healthy, or a required id (page, budget, country, link, or uploaded media id) is missing. |
| Build works and the site is blank | Confirm `/assets/*` is served as JavaScript, not HTML. See [DEPLOYMENT.md](DEPLOYMENT.md). |
