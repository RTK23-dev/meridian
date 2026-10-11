# Operations

## Processes

| Process | Command | Needed for |
| --- | --- | --- |
| Web | `npm run dev` (development) or the built server | Screens and the API |
| Worker | `npm run worker` | Queued jobs: research collection, generation, publishing and the rest |
| Scheduler | `npm run scheduler` | Periodic work: discovery runs and performance syncs |

All three read the same `.env` and the same `DATABASE_URL`. The web process never runs jobs.

## Health

`GET /api/health` answers `{ "status": "ok" }` when the server is up. It does not read the database.
`GET /api/health?detail=1` returns operational detail for the signed-in workspace, to a workspace admin only. Put only the liveness
form behind a public load balancer.

## Database

- Apply migrations with `npm run db:migrate`. `npm run build` applies them too. Migrations run in filename order and are never edited
  after they have been applied.
- Back up with `pg_dump`. Restore into an empty database and point `DATABASE_URL` at it.
- Saved keys are encrypted with `TOKEN_ENCRYPTION_KEY`. A backup without that key still restores, but its saved keys cannot be read.

## Artifacts and exports

Rendered media and export packages go to the configured storage (Drive, or S3 when set). A storage object row in Postgres records each
one. The media route `/api/assets/:assetId` serves an artifact to a member of its workspace only.

Where live posting is not available, the manual export package is the delivery path. Export the package from the Library or the Studio
review, and post it by hand.

## Budgets

A workspace has a budget ledger. Generation reserves its estimated cost before the provider call, and releases the reservation when the
call fails. The Usage screen shows what has been spent. A budget that is exhausted stops new generation; it does not stop reading.

## Sign-in and the first admin

Sign-in uses better-auth with `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`. The first account creates a workspace and is its owner.
Members and roles are managed in the Accounts and Settings screens. Every mutation checks the caller's role on the server.

## Troubleshooting

- **Not configured / not connected.** The screen says which key, connection or variable is missing. Settings → General → Setup lists them.
- **A job stays queued.** The worker is not running, or it cannot reach `DATABASE_URL`. Check its log.
- **A decision is in review.** The policy sent it to review: the question has no policy, the answer is unresolved, or the number is not
  calibrated. The decision record says which.
- **The app refuses to start.** Without `DATABASE_URL`, production (any `NODE_ENV` other than `development` or `test`) refuses to start.
  Set `DATABASE_URL`, or set `NODE_ENV` to `development` for a local trial.
- **Media does not play.** Check that the artifact exists in its storage and that the browser can request byte ranges.

## Upgrading

Back up the database. Pull the new code. Run `npm ci`, `npm run build` (which migrates), then restart the web, worker and scheduler.
A rollback is a restore of the backup, because migrations are not reversed automatically.
