# Deployment

Local install steps are in [SETUP.md](SETUP.md). This page is the process split for a host.

Meridian is a web process plus two long-lived processes. A serverless request must not be the worker.

```
WEB          npm run dev / the host's Node server
WORKER       node scripts/worker-entry.ts
SCHEDULER    node scripts/scheduler-entry.ts
DATABASE     DATABASE_URL (Postgres)
OBJECT STORE S3-compatible bucket, or the filesystem provider in development
```

For JEV Research, the worker also needs `META_AD_LIBRARY_TOKEN`, `OPENAI_API_KEY`, one existing JEV chat key (`XAI_API_KEY` or `OPENROUTER_API_KEY`), and `ffmpeg`/`ffprobe` installed. `FFMPEG_PATH` and `FFPROBE_PATH` can select non-default executable paths. Missing keys remain `NOT_CONNECTED`; transient errors retry through the normal job policy and are dead-lettered after the configured attempts.

## Health

`GET /api/health` reports the database, worker heartbeat, scheduler heartbeat, storage configuration, and provider configuration. A missing heartbeat is `stopped`. It is not reported as running inside the web process.

The worker heartbeats on each tick, leases jobs for 120 seconds, recovers expired leases, and exits after `SIGTERM` once the current tick finishes. The scheduler only inserts due jobs. It does not execute them.

## Secrets

Set tokens in the host environment. Do not commit them. Supported names are listed in the README. Postgres stores connection status, external ids, and access tokens only after they are sealed with `TOKEN_ENCRYPTION_KEY`. It does not store the token in plaintext, and the UI does not return it.

`0009_completion.sql` adds OAuth state, sealed tokens, webhook receipts, and alert rows. `0010_activation.sql` adds the schedule payload, a sealed refresh token, delivery targets, and delivery attempts. There is no seed data. `migrations/*.sql` apply in order on startup and in `npm run build`.

`0016_jev_research.sql` adds tenant-scoped research collection, source-ad, transcript, analysis, segment, and pattern tables plus research provenance columns on opportunities. Back up Postgres before applying a release; use the rollback procedure below if needed.

## Rollback

Restore the previous release, then restore the database from a backup taken before the migration. The app does not automatically reverse SQL. A down migration is not generated.

## What this environment is not

The preview can start the web server. It does not keep a second machine's worker alive, and it has no ad account. Vercel serverless will not run `worker-entry.ts` between requests. Run the worker and scheduler on a VM, container, or other long-lived host that shares `DATABASE_URL`.
