# Running Meridian on Railway

This runs Meridian as its own Railway project, served at `https://meridian.victor.ceo`. The project has four services: PostgreSQL
with pgvector, the web app, the worker and the scheduler. The web app, worker and scheduler all build from this repository's
`Dockerfile`, so when `main` changes and Railway redeploys, the hosted copy changes with it. The victor.ceo site does not copy
Meridian's code. It only shows the hosted app.

The worker and the scheduler are always on, and Railway bills each service. Read [OPERATIONS.md](OPERATIONS.md) first: without the
worker, queued runs never progress, and without the scheduler, periodic work never starts.

## What is checked, and what is not

Checked in this repository, locally:
- `npx vite build` passes.
- The web start command from the `Dockerfile` (`sh -c` with `${PORT:-8080}`) serves on the `PORT` it is given.
- `/api/health` answers without a database.
- Every response carries `Content-Security-Policy: frame-ancestors`, set from `MERIDIAN_FRAME_ANCESTORS` when the server starts. A
  Chromium page on another origin was refused.
- The preview server answers the public host names only: the hosts of `APP_URL`, `PUBLIC_APP_URL` and `BETTER_AUTH_URL`, with
  `localhost` and IP addresses always allowed. Any other Host header gets a 403 from Vite, before the app runs. A 403 from that check
  carries no frame header, and that is expected. So `meridian.victor.ceo` is served, and the Railway default domain is refused, unless
  it is one of those three names.

Not checked here: the Docker image build, a Railway deployment, the production database, sign-in on the real domain, and a victor.ceo
page actually showing Meridian. Those need the real services.

## 1. Database

1. In the new Railway project, add a PostgreSQL service from the pgvector template (`railway.com/deploy/pgvector-postgresql`).
   Migration 0019 creates the `vector` extension, so the image must include pgvector.
2. Open the database service's Variables tab and find the private connection URL, the one whose host ends in `railway.internal`.
   Railway's sources disagree on its name (`DATABASE_URL` or `DATABASE_PRIVATE_URL`), so check the tab. Use it in step 2 and 3.

## 2. Web service

1. Add a service from the GitHub repository `rtk23-dev/meridian`, branch `main`. Railway should build from the `Dockerfile`. If it
   uses another builder, set it to Dockerfile in the service settings.
2. Leave the start command empty. The `Dockerfile` command runs the migrations and then the web app. Meridian has no `npm start`
   script, so a start command such as `npm start` fails. If a start command was set earlier, clear it.
3. Set the variables in section 5.
4. Optional: set the healthcheck path to `/api/health`.
5. Deploy. The logs should show the migrations finishing and the server listening on the Railway port.

## 3. Worker and scheduler

Add two more services from the same repository. Give each its own start command:

| Service | Start command | Extra variable |
| --- | --- | --- |
| worker | `node --experimental-strip-types scripts/worker-entry.ts` | `MEDIA_FUNCTIONS_MODE=in_process` |
| scheduler | `node --experimental-strip-types scripts/scheduler-entry.ts` | none |

Give both the same variables as the web service, including `DATABASE_URL`. Give neither a public domain.

## 4. Domain

1. On the web service, add the custom domain `meridian.victor.ceo`. Railway shows a target.
2. At the DNS provider for victor.ceo, add the CNAME record Railway shows, and the TXT record if it asks for one.
3. Wait for the green check. Railway issues the HTTPS certificate on its own.

## 5. Variables

Set these on the three Meridian services unless the table says otherwise. Never commit values. Generate the secrets yourself.

| Variable | Services | Value |
| --- | --- | --- |
| `NODE_ENV` | all three | `production` |
| `DATABASE_URL` | all three | a reference to the private database URL from section 1 |
| `BETTER_AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` | all three | 32 or more random characters each |
| `BETTER_AUTH_URL`, `APP_URL` | all three | `https://meridian.victor.ceo` |
| `MERIDIAN_ALLOWED_OAUTH_ORIGINS` | all three | `https://meridian.victor.ceo` (needed for Google Drive sign-in redirects) |
| `MERIDIAN_FRAME_ANCESTORS` | web | `https://victor.ceo` (add `https://www.victor.ceo` if it is used) |
| `MEDIA_LINK_SECRET` | all three | 32 or more random characters |
| Google Drive settings | all three | the service account key, or the OAuth client ID and secret |
| `MEDIA_FUNCTIONS_MODE` | worker | `in_process` |

Do not set these:
- `PORT`. Railway provides it, and the start command reads it.
- `VITE_AUTH_ENABLED=false`. Production refuses it.
- `MERIDIAN_TESTING_RUNTIME` or `ALLOW_SYNTHETIC_TELEMETRY`. Production refuses them.

Provider keys (OpenRouter, HeyGen, Anthropic and the others) are saved per workspace in Settings. Set a deployment-wide key only
after the owner has set a budget (section 6).

## 6. First checks, before anyone signs in

1. Open `https://meridian.victor.ceo/api/health`. It should return `{"status":"ok"}`.
2. Run `npm run check:deployment` with the same variables. It prints setting names and a verdict, never values. It must say
   "No blocking problem found".
3. Open the Jobs & health page (`/jobs`). It should show the worker and the queue.
4. Sign in yourself first. The first account becomes the workspace owner.
5. Set the Billing budget (`/billing`) before adding any provider key. An unset budget refuses OpenRouter decisions.

## 7. victor.ceo

The victor.ceo repository needs three small changes: a `/meridian` route, a page that frames `https://meridian.victor.ceo` with a
plain link as the fallback, and a navigation link. Its existing Railway service redeploys on push, and it already listens on `PORT`.
If the frame is refused, the page should fall back to the link. Check that `MERIDIAN_FRAME_ANCESTORS` names the victor.ceo origin
exactly.

## Things to confirm in the Railway dashboard

- Which database variable holds the private URL (section 1).
- That the web service's public port matches the port the app listens on.
- The names of the Railway settings in this guide. They were written from Railway's documentation and community threads, not from
  the dashboard, so check each one as you set it.
