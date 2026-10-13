# Operations

## Processes

| Process | Command | Needed for |
| --- | --- | --- |
| Web | `npm run dev` (development) or the built server | Screens and the API |
| Worker | `npm run worker` | Queued jobs: research collection, generation, publishing and the rest |
| Scheduler | `npm run scheduler` | Periodic work: discovery runs and performance syncs |

The web, worker and scheduler read the same `.env` and the same `DATABASE_URL`. With `DATABASE_URL` set, the web process never runs
jobs: the worker does. Without it (a local trial), `npm run dev` runs the queued jobs itself, because the embedded database can be
opened by one process only. See [Local trial](#local-trial).

## Local trial

With `DATABASE_URL` unset, `npm run dev` (`scripts/dev.mjs`) does three things:

- keeps the embedded database on disk in `.data/pglite` (`MERIDIAN_LOCAL_DATA_DIR`), so a restart keeps the data;
- loads `.env`, so `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` are the same after a restart: sign-in sessions and saved keys survive it;
- runs the queued jobs in the dev server (`vite.config.ts`, `localJobsPlugin`, through `scripts/local-jobs.mjs`). The log shows
  `[jobs] Ran N job(s).` when it runs some. A failed pass is logged as `[jobs] A job pass failed`, the next pass waits longer each time
  (10 s, 20 s, up to 60 s), and the server keeps running. `[jobs] The job pass works again.` shows the recovery.

To start again empty, stop the server and delete `.data/pglite`. To back it up, stop the server and copy that folder. Do not run
`npm run db:local` at the same time, because it opens the same folder.

A local trial does not run periodic work. The scheduler needs `DATABASE_URL`.

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

Rendered media and export packages go to Google Drive when the server connects it. S3 is retired. A storage object row in Postgres records each
one. The media route `/api/assets/:assetId` serves an artifact to a member of its workspace only. `/api/media-links/:creativeId` serves one
approved creative to Instagram and TikTok through a signed link that expires 15 minutes after it is made. It needs `MEDIA_LINK_SECRET` (32
characters or more, never committed) and `APP_URL` (an https origin). For TikTok, the host must also be listed in
`TIKTOK_VERIFIED_MEDIA_DOMAINS`, which TikTok has verified for the app.

Where live posting is not available, the manual export package is the delivery path. Export the package from the Library or the Studio
review, and post it by hand.

## Budgets

A workspace has a budget ledger. Generation reserves its estimated cost before the provider call, and releases the reservation when the
call fails. The Usage screen shows what has been spent. A budget that is exhausted stops new generation; it does not stop reading.

A reservation whose provider call did not return is held. Owner decision (NORTH_STAR section 2, decision D): once its submission window
(30 minutes from the reservation) has passed with no outcome from the provider, the worker asks the provider's own lookup whether it holds a
job for the submission. The hold is released only when the provider confirms it holds none, with the reason `window_expired` and the actor
`system`, and the Held budget panel lists it under "Released after the provider confirmed no job". A provider that has no lookup, a lookup
that does not answer, and a provider that reports a job all keep the hold, and the panel shows the last check beside it. No provider has a
lookup for a submission whose response never arrived yet (`SUBMISSION_LOOKUPS` in `security/held-reservations.ts` lists the lookups that exist), so every such hold stays for an admin. A submission the
provider answered, or that produced a creative, is never checked or released this way.

## Sign-in and the first admin

Sign-in uses better-auth with `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`. The first account creates a workspace and is its owner.
Members and roles are managed in the Accounts and Settings screens. Every mutation checks the caller's role on the server.

## Troubleshooting

- **Not configured / not connected.** The screen says which key, connection or variable is missing. Settings → General → Setup lists them.
- **A job stays queued.** With `DATABASE_URL`, the worker is not running, or it cannot reach the database: check its log. In a local
  trial, the dev server runs the jobs: its log has `[jobs]` lines, and a failing pass says why. A job that keeps failing is marked
  `dead` after its attempts, with the reason on the job.
- **A decision is in review.** The policy sent it to review: the question has no policy, the answer is unresolved, or the number is not
  calibrated. The decision record says which.
- **The app refuses to start.** Without `DATABASE_URL`, production (any `NODE_ENV` other than `development` or `test`) refuses to start.
  Set `DATABASE_URL`, or set `NODE_ENV` to `development` for a local trial.
- **Media does not play.** Check that the artifact exists in its storage and that the browser can request byte ranges.
- **A Factory run says awaiting approval.** The run reached a step that spends or publishes, in `manual` or `semi` automation. Approve the
  stage, or change the run's automation. The reason on the run names the stage. The Factory screen shows an approve button for that stage to
  a member. See [FACTORY.md](FACTORY.md).
- **A Factory run says paused or stopped.** Either the kill switch is engaged (every stage stops, in every mode) or a `full` run has no
  spend cap, or has reached it. The reason on the run says which.
- **A paused Factory run does not start again.** The kill switch is on, which refuses **Start again** until it is cleared (Live tests, an admin). A spend cap that is still reached stops the run again at the same stage, with the same reason.
- **A grade is in review and the Calibration screen says "Not enough outcomes: n of 100 measured".** The brand has fewer measured outcomes
  than the minimum for that grading question, so its threshold is not calibrated and the grade goes to review. Outcomes are measured rows
  on the control creative of a graded pick, on the pick's surface, that report the surface's metric. A pick whose ad was graded again after
  the pick, or that was picked before migration 0071, is not counted. Rows marked synthetic are never counted. See
  [FACTORY.md](FACTORY.md#calibration-per-brand-and-question).
- **The Calibration screen shows no report, only counts, after a release.** A report is stored when the brand's `learning.update` job runs,
  when a Factory learn stage runs, or when an admin presses **Recompute from outcomes**. Until one of these runs, the screen shows the counts
  measured now.
- **A Factory run says learning waits for a measured outcome.** None of the run's creatives has a stored metric yet. The measurement pull runs every six hours after a launch, and a run with no published creative never gets one. Once a metric is stored, use **Check learning again** on the run. The button is offered only while the run is running at its learn step.
- **A Factory variant is blocked with a rights reason.** A licence is not attested for its creative, the AI label is not confirmed for the
  variant, or a record was revoked. A member records it on the Factory run view (FACTORY.md, Licences).
- **An Instagram or TikTok post reports not connected with a link reason.** Set `MEDIA_LINK_SECRET` (32 characters or more), `APP_URL`
  (https), and for TikTok the deployment's host in `TIKTOK_VERIFIED_MEDIA_DOMAINS`. Nothing was sent.
- **A TikTok or YouTube post reports not connected.** The saved token does not grant the scope the publish needs (`video.publish` for
  TikTok, the upload scope for YouTube). Save a token that grants it on Connected accounts.

## Upgrading

Back up the database. Pull the new code. Run `npm ci`, `npm run build` (which migrates), then restart the web, worker and scheduler.
A rollback is a restore of the backup, because migrations are not reversed automatically.

This release adds migrations `0062` to `0065`. `0062` and `0063` make organic and paid metric columns nullable, so an unknown metric is
stored as null and not as zero. `0064` clears the survival default from the Factory timelines, and the next grade run rewrites them from
source data. `0065` adds run settings, the approvals table, and the `awaiting_approval` run status. Runs started before this release keep
working from their level.

This release adds migration `0070`. It gives `learned_patterns` a `surface` (organic or paid) and a `channel`, and fills the surface of each existing pattern from its metric. Every brand's patterns are rebuilt by the next recomputation (the telemetry sync, the organic bridge, or a Factory learn stage), which replaces the whole set. A pattern whose metric names neither surface stays `unassigned` until then, and it is not applied. Nothing else in the database changes.

This release adds migration `0071`. It gives `factory_picks` a `surface` and a `grade_fingerprint`. Both are empty for every pick written before it, and the Factory screen says the prediction of such a pick is not known. No existing row is rewritten.

This release adds migration `0072`. It makes `factory_costs.cents` nullable and adds the `tokens` basis, with `micros` (the priced cost in millionths of a dollar), the engine, model, prompt and completion tokens, the price table version and the gate record id. Existing rows keep their cents and have no micros. Nothing is rewritten. A token row with no price has a null cost, which the Factory screen shows as "tokens only, not priced".

This release adds migration `0074`. It creates `question_calibration_reports`, the per-brand, per-question calibration reports for the
grading questions (see [FACTORY.md](FACTORY.md#calibration-per-brand-and-question)). Nothing existing is rewritten. The table is not
`calibration_reports`, which migration `0045` already uses. No report is calibrated until a brand has the minimum measured outcomes.

The telemetry sync now writes one paid observation per measured row, keyed in `performance_observations.external_id` as `telemetry:<row id>`. A paid observation written before this release has no key. The next sync adopts it by its creative, day and values, so the first measurement is not counted twice. Nothing has to be run by hand.
