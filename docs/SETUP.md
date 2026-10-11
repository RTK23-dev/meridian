# Setup

## Requirements

- Node.js 22 (CI uses 22).
- PostgreSQL 16 for anything beyond a local trial. Development can run without one, on an embedded database.

## Install and first run

```bash
npm run setup
npm run dev
```

`npm run setup` (`scripts/setup.mjs`) is safe to run again. It:

- checks the Node version and installs dependencies only if `node_modules` is missing;
- creates `.env` from `.env.example` if `.env` does not exist, and never overwrites it;
- generates `TOKEN_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` into `.env` only when they are empty. It never prints them;
- runs the migrations when `DATABASE_URL` is set, and says so when it is not;
- prints the next steps.

Then open http://127.0.0.1:8080, create an account, create a workspace and create a brand. The brand brain is the first screen to
complete: the four required fields are positioning, target customers, tone and prohibited claims.

Without `DATABASE_URL`, development uses an embedded PostgreSQL (PGlite), which keeps its data in memory. Production refuses to start without
`DATABASE_URL`, unless `NODE_ENV` is explicitly `development` or `test`.

## Saving provider keys

Keys are not set in `.env` for normal use. Open **Settings → General**:

- **Setup** lists each provider with its state from the server: usable, unusable, not configured, or the deployment's shared
  default. Each state has its reason.
- **Provider keys and settings** saves a key for this workspace. Only an admin can save or remove one. A key is stored
  encrypted and is never shown again; the screen shows its last four characters.
- **Google Drive** shows whether Drive is connected, and what is missing if it is not.

The decision engine is chosen on the **Settings → JEV** tab. Every provider and its deployment opt-in are listed in PROVIDERS.md.

## Google Drive

Drive stores artifacts and exports only. Postgres holds the data. Connect Drive with one of these, set in `.env`:

- a service account: `GOOGLE_SERVICE_ACCOUNT_KEY` (the JSON key), or
- an OAuth refresh token: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`.

Set `MERIDIAN_DRIVE_FOLDER_ID` to the folder the artifacts go into. The Drive panel reports the state and the missing names.

## Deploying

1. Create a PostgreSQL 16 database and set `DATABASE_URL`.
2. Set `BETTER_AUTH_URL` to the public address, and `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` to long random values.
   Keep `TOKEN_ENCRYPTION_KEY` safe: saved keys cannot be read without it.
3. Set `NODE_ENV=production`. Do not set `MERIDIAN_TESTING_RUNTIME`; it enables the test providers.
4. `npm run build` compiles the app and applies the migrations.
5. Start the web process, then start the worker (`npm run worker`) and the scheduler (`npm run scheduler`). Without the worker,
   queued jobs wait. Without the scheduler, periodic work never starts.

`.env.example` lists every variable the code reads, with a comment saying whether it is infrastructure, deployment configuration
or a per-workspace key.
