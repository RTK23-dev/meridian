# Deployment

Meridian is a web process plus two long-lived processes. A serverless request must not be the worker.

```
WEB          npm run dev / the host's Node server
WORKER       node scripts/worker-entry.ts
SCHEDULER    node scripts/scheduler-entry.ts
DATABASE     DATABASE_URL (Postgres)
OBJECT STORE S3-compatible bucket, or the filesystem provider in development
```

## Health

`GET /api/health` reports the database, worker heartbeat, scheduler heartbeat, storage configuration, and provider configuration. A missing heartbeat is `stopped`. It is not reported as running inside the web process.

The worker heartbeats on each tick, leases jobs for 120 seconds, recovers expired leases, and exits after `SIGTERM` once the current tick finishes. The scheduler only inserts due jobs. It does not execute them.

## Secrets

Set tokens in the host environment. Do not commit them. Supported names are listed in the README. Postgres stores connection status and external ids, not access tokens.

## Migrations

`migrations/*.sql` apply in order on startup and in `npm run build`. `0008_providers.sql` adds `provider_connections` and `provider_objects`. There is no seed data.

## Rollback

Restore the previous release, then restore the database from a backup taken before the migration. The app does not automatically reverse SQL. A down migration is not generated.

## What this environment is not

The preview can start the web server. It does not keep a second machine's worker alive, and it has no ad account. Vercel serverless will not run `worker-entry.ts` between requests. Run the worker and scheduler on a VM, container, or other long-lived host that shares `DATABASE_URL`.
