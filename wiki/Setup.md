# Setup

## On your machine

You need Node.js 22. You do not need API keys to start.

```bash
npm run dev
```

The first run installs dependencies, creates `.env`, and starts the app at http://127.0.0.1:8080. The database is an embedded Postgres file in `.data/pglite`. Accounts survive a restart. Queued jobs run inside this same process.

Then:

1. Open the app and choose **Create an account instead**.
2. Create a workspace, then a brand.
3. Fill the brand brain. The required fields are positioning, target customers, tone, and prohibited claims.
4. Add provider keys later, in **Settings**, when you have them.

`npm run setup` does the `.env` step on its own and is safe to run again.

## On a server

Set `DATABASE_URL` to PostgreSQL 16. Run the app, `npm run worker`, and `npm run scheduler` as separate processes. Docker Compose is described in [docs/SETUP.md](../docs/SETUP.md).

Production refuses to start without `DATABASE_URL`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | First-run setup, then the app on port 8080 |
| `npm run setup` | Create `.env` and generate secrets. Safe to repeat |
| `npm run worker` | Queued jobs, when `DATABASE_URL` is set |
| `npm run scheduler` | Periodic work, when `DATABASE_URL` is set |
| `npm run db:migrate` | Apply SQL migrations |
| `npm test` | Unit and integration tests |
