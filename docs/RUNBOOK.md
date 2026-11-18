# Runbook

What to do when something is wrong, in order. Every command here exists in `package.json` or `scripts/`. Health first, then the cause.

## First: is it up, and can it work?

- `GET /api/health` answers `{"status":"ok"}` while the web process runs. It reads nothing else. If it does not answer, the web process
  is down: restart it (the Docker image runs `node scripts/migrate.mjs && npm run preview`; restart the container, or redeploy).
- `GET /api/ready` answers 200 when the database answers within 2 seconds, every migration is applied, and the job queue is moving; else
  503 with each check's state (`database`, `migrations`, `jobs`) and nothing more. Point the uptime monitor at `/api/ready`.

| `/api/ready` says | Meaning | Do |
|---|---|---|
| `database: fail` | The database did not answer in 2 s | See "The database is down, full or slow" |
| `migrations: pending` | A migration file is not applied | `npm run db:migrate`, then check again |
| `jobs: stalled` | A job has been due for over 15 minutes | See "Jobs are stuck" |
| `unknown` | The check could not be read | Read the web process's log for the error |

## The site is down

1. `GET /api/health`. No answer: the web process is down. Restart or redeploy, then read its log for the cause (`docs/OPERATIONS.md`,
   "Troubleshooting").
2. Health answers but pages fail: `GET /api/ready` names the failing part.
3. A deploy just went out: roll back to the previous deploy. Migrations only add; a rolled-back app runs on the newer schema.

## The database is down, full or slow

- Down: restart it with your database host. The app fails closed: paid work is refused, nothing is half-written.
- Full: free space or grow the disk first. Then take a backup (`npm run db:backup`) before cleaning anything.
- Slow: `/api/ready` shows `database: fail` when a `select 1` takes over 2 s. Check the host's connections and long queries.

## Jobs are stuck

- `npm run worker` takes jobs, `npm run scheduler` queues the timed ones. `/api/ready` `jobs: stalled` means no worker is taking them:
  start or restart the worker.
- Settings, Jobs & health (an advanced screen: Settings, General, "Show advanced screens") lists jobs and dead jobs with their reasons.
- A Claude Code video stuck in "Being made" is queued again by itself when its runner stops answering (three tries, then Failed with the
  reason). Use Run again or Cancel on the card in Create.

## A provider fails, or spending jumps

- Every paid step is held against a budget line before it is sent (`docs/OPERATIONS.md`, "Budgets"). To stop new spending now, lower the
  workspace monthly budget or the brand budget on the Billing page (`/billing`, admins). A call already in flight finishes; nothing new
  starts past the line.
- To stop live ads for a brand: the brand's Content page, Factory, "Levels and kill switch". Ads are only ever created paused.
- A provider that is failing reports it on Integrations (`/integrations`) with its reason. Nothing is retried blindly: an unknown outcome
  is recorded as uncertain.

## A connector link or a key leaked

- Connector link (the `/api/mcp/...` address, also in a runner's `.meridian/runner.json`): Settings, Connections, Chat connector, Revoke.
  It answers nothing from then on. Make a new one and start the runner with it (`npm run claude:runner -- <new link>`).
- A provider key: replace it on Settings, Connections (the saved key is overwritten), then revoke the old key at the provider.
- `TOKEN_ENCRYPTION_KEY` (encrypts saved keys, OAuth tokens, the Drive connection and Drive upload sessions). To change it without
  losing what is saved:
  1. Set the old value as `TOKEN_ENCRYPTION_KEY_PREVIOUS` and a new long random value as `TOKEN_ENCRYPTION_KEY`, in every process
     (web, worker, scheduler), and restart them. Reads try the new key, then the old one; everything newly saved uses the new one.
  2. `npm run keys:rotate -- --dry-run` (needs `DATABASE_URL`). It changes nothing and prints, per table.column, how many values are
     re-encryptable, already current, and unreadable with both keys.
  3. `npm run keys:rotate`. It re-encrypts every value under the new key, in batches inside transactions, and prints the same counts.
     It is safe to run again; a second run changes nothing. Values neither key opens are left as they are and counted, never deleted:
     save those keys or connections again. It refuses to start when `TOKEN_ENCRYPTION_KEY_PREVIOUS` is unset or equals the new key.
  4. Remove `TOKEN_ENCRYPTION_KEY_PREVIOUS` and restart.

  A leaked key still means revoking the saved provider keys and tokens at each provider and saving new ones: anyone with the old key
  and a copy of the database (or a backup) can read them, and re-encrypting does not change that.
- `BETTER_AUTH_SECRET`: set a new value and restart; everyone is signed out.

## Restoring from a backup

1. Backups: `npm run db:backup` writes `backups/<db>-<time>.dump` with a `.sha256` and the row counts of the 20 largest tables. Keep
   copies off the database's machine. `BACKUP_KEEP` sets how many stay (14).
2. Restore into a new, empty database: set `RESTORE_DATABASE_URL` to it and run `npm run db:restore -- backups/<file>`. Check it, then
   point `DATABASE_URL` at it.
3. Restoring over the live database is refused unless `--into-live` is given, and then the database's name must be typed back in a
   terminal. Take a fresh backup first.
4. A local trial (no `DATABASE_URL`) keeps its database in `.data/pglite`: stop the app and copy that folder; that copy is the backup.

## Reading the restore drill

`npm run db:restore-drill` restores the newest backup into a scratch database on the same server, migrates it, compares the row counts
taken in the backup's own snapshot with the restored ones, prints PASS or FAIL, and drops the scratch database. It runs weekly in GitHub
Actions (`.github/workflows/restore-drill.yml`) on a throwaway database. FAIL names each table that differs: do not trust that backup;
take a new one and run the drill again. Exit codes: 0 PASS, 1 FAIL, 2 not run (missing tools or settings, said in plain words).

## Reading the load check

`PRODUCT_BASE_URL=<your site> MERIDIAN_LOAD_LINK=<a connector link you own> npm run load-check` loads liveness, readiness and the
connector for 30 s each at 20 requests at once, and prints p50/p95/p99 and errors. It fails when a p95 or the error rate (1%) is over its
limit. A connector link may make 60 calls a minute, so most connector calls come back throttled (429): that is the limit working and is
not an error. Run it only against a server you run. A run on a dev server is a baseline, not production capacity.
