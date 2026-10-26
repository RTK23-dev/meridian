# Changelog

## Unreleased

Nothing yet.

## 0.1.0-beta.16 — prerelease

OpenRouter decision routing with a live catalogue and a per-call ceiling, JEV image evidence, a stored-success freshness rule, disabled-by-default paths for every paid or side-effecting call that has no guard, a browser release acceptance, a guided setup, and a gate that requires every CI job. Tests use fixtures, fake transports, a seeded local app and PostgreSQL in CI. **No live provider call is recorded in this release.** Live provider behavior, real credentials, billing and publishing are unverified.

**Upgrade notes.** Six migrations are new since 0.1.0-beta.15: `0132_openrouter_decisions.sql`, `0133_jev_backend.sql`, `0134_generation_task_models.sql`, `0135_model_run_provenance.sql`, `0136_generation_holds.sql` and `0137_hold_releases.sql`. No new packages.

- **Decisions.** OpenRouter Decisions is a decision engine beside TypeSafe JEV and OpenAI Decisions. The model is chosen from the live catalogue and must have a verified profile. Each decision is held in the ledger before it is sent, is bounded by a per-call ceiling and the shared monthly budget, and is never retried.
- **Holds.** A call whose outcome is unknown (a timeout, an error status, an unreadable reply) keeps its hold and counts against the month. OpenRouter states no billing rule for these outcomes, so nothing releases a hold on a status code. An administrator releases one in Settings with a reason of at least ten characters, and the release is audited.
- **Provider readiness.** A recorded provider success is healthy for 24 hours. An older one, or one whose time cannot be read, is degraded. A saved key reads "Saved, not checked live".
- **Disabled paths.** Twenty paid or side-effecting paths refuse before any request and are never retried until they have an idempotency guard and a test. The list is in `docs/OUTBOUND_REQUESTS.md`. A refused Higgsfield, Omni, Gemini perception, Hypit or OpenAI call is reported as refused, not as an unknown outcome.
- **Setup and Content.** The Setup guide shows the required steps first and keeps optional ones behind "Open this step". The Content page's run planner is one click away under "Plan a run in detail". The setup progress card and the planner form share a soft static glow.
- **Release acceptance.** A browser acceptance of the Settings screens runs in CI against a seeded local app. It refuses any target that is not a loopback address and fails if a request leaves the local server.
- **CI gate.** The aggregate `check` requires every test shard, the static checks, the sidecar tests, the PostgreSQL money checks, the release acceptance, the UI smoke and the product-loop end to end, and fails if any was skipped. The browser smoke runs before the UI baseline, because the baseline's request volume trips Better Auth's rate limiter.
- **Docs.** The README describes what Meridian is meant to be, and the document index lists the release acceptance, outbound request and OpenRouter documents.

**Known issues.**
- No live run of any provider, publish, paid call or billing path has been made. The live steps are for the owner to run.
- An OpenRouter request that errors or times out may have been billed. Its hold stays until an administrator releases it.

## 0.1.0-beta.15 — prerelease

The cost and time record for paid engine calls, a bound on how often held bills are read, the 2026-10-22 review fixes from main, and the orchestrator's text steps. Tests use fixtures. No live provider call is recorded in this release. The owner's live check of the OpenRouter bill field and the token figures is still to run.

**Upgrade notes.** Three migrations are new since 0.1.0-beta.14: `0110_orchestrator_step_body.sql` (`orchestrator_step_outputs.body`, so a downstream step reads the content an upstream step produced), `0111_provider_token_expiry.sql` (`provider_secrets.expires_at`; a token with no stated expiry keeps null and is not treated as expired) and `0112_engine_call_telemetry.sql` (`engine_call_telemetry` and `engine_bill_reads`, both additive). No new packages.

- **Cost and time per call.** Each paid call writes one telemetry row in the same transaction as its ledger settlement: its tokens, latency, generation id and the cost its response reported. If that row fails, it rolls back to a savepoint and the settlement stands. No extra OpenRouter request is made.
- **Held bills are read a bounded number of times.** A held call's bill is read at most five times, 15 minutes, 1 hour, 4 hours and 12 hours apart. A call with no provider reference is not read. Overlapping runs cannot read the same call twice. Before this, a bill that never arrived was read every 15 minutes, indefinitely.
- **Orchestrator.** Plan, run and step edits need an admin, on the server and in the UI. A plan's spend counts every stored output, and a paid step records what it was charged. A run takes one budget reservation and releases what it does not spend. Text steps (reference, analysis, script) run. Visual and voice steps make their asset through the run's asset router; that path is covered by fixtures and no live call has run. Video, avatar, edit, compose and render are not connected, and they say so. Decisions made on the owner's behalf are in `docs/engine/run/DECISIONS_2026-10-22.md`.
- **Content Factory board.** Each shot shows its take as a 15-minute link, or says in words why there is none. A remake is quoted before it is confirmed, and the quote writes nothing. A reviewer can edit a generated shot's prompt, change a shot to cinematic or to stock footage, or pick a model for a generated shot. Each change is quoted, runs as a remake with its own reservation, and is limited to admins. A remake can replace one shot's visual type and source; any other visual type is refused, not guessed. A reviewer can also upload a clip for one shot. The file is probed and quoted before anything is stored. It must be an H.264 MP4 at the take size that covers the shot, and it becomes that shot's take with no model call.
- **Provider status.** The most recent probe decides, so a failure after an earlier success reads FAILED. A saved credential that cannot be used is a failed probe with its reason. A failed read of stored connections reports FAILED with the kind of error. The unused environment-token `providers` field is gone from system status.
- **Content Factory.** Search in the source picker no longer sends the composer's message. The script and model-choice cards show the right stages. File, message and source writes check the draft status in the same transaction. An ISO file counts as video only when its brand is MP4 or QuickTime.
- **Provider requests.** Provider redirects are refused, so a provider key is never sent to a redirect target. Live-priced estimates round up to four decimals, the ledger's precision.
- **Tests.** The deprecated-model fixture's shutdown date is in 2030, so it reads DEPRECATED on any date.

**Known issues.**
- The OpenRouter generation-stats bill field and the token and cost figures are not confirmed against a live call. Run a few small calls and compare them with OpenRouter's dashboard.
- Video poll costs are not in the telemetry rows. They settle in the asset stages.
- The cost and time report and dashboard are not built. The existing Usage & cost screen still reads the older model-run data.
- The pull-request line's engine (contracts v5, its own billing) is not in main. It stays on GitHub as separate branches.
- Content Factory's remaining open items are listed in `docs/engine/CONTENT_FACTORY_STATE_2026-10-18.md`, section 7.
- Credentials are not yet in one API and hub.

## 0.1.0-beta.14 — prerelease

The Katana redesign's first waves, the connection-state fix, and the Create progress model, with the Content Factory work listed below. Tests use fixtures. No live provider call or live video run is recorded in this release.

**Upgrade notes.** Migrations `0107` through `0109` are new: an organic measurement key (`0107`), orchestrator plans and their events (`0108`), and the orchestrator model stored per workspace (`0109`). Run `npm ci` once. Archivo, Instrument Sans and JetBrains Mono replace Inter and Fraunces.

- **Settings and connections.** A connection that is not disconnected now shows its real state. Before, every connection read NOT CONFIGURED. A stored credential that cannot be used shows FAILED with its reason, so an earlier success never reads HEALTHY. Performance schedules follow the same credential state. Before, a schedule was always refused.
- **Design.** Archivo, Instrument Sans and JetBrains Mono. Buttons, fields, cards, badges and feedback are restyled in the Katana palette, with dark as the default theme and a light theme inverted from it. The new step bar, link tabs, drawer, save state and loading mark are built and tested, and the screens move to them in the next wave. The loading mark stops still when reduced motion is on. The primitive gallery is available in development only.
- **Content Factory.** The orchestrator model is stored per workspace, and each plan records the model that wrote it. Plan, run, step edit and model changes are shown to workspace admins only, with the reason shown to other people.
- **Create and Home.** The Create step model, progress helpers and the Needs you list are built and tested. The Create screens and Home do not use them yet.
- **Hot swap.** A reviewer can make one accepted shot of a delivered Content Factory video again. The rest of the video is kept, and the video is delivered again as its next revision. The shot can take a short direction (280 characters). Bible 5.5. Verified on fixtures; the second render needs the HyperFrames price, which is not set.
- **Flow board.** The Content Factory run is drawn as a flow of steps, with each shot as a node, and the step that is running shows a moving line. Phone and dark layouts are checked on a fixture feed.
- **Fix.** A delivered engine video's manifest is read from its own slot. Before this, the Factory's engine path could not read a delivered master.
- **Performance accounts.** Google Ads sync reads the brand's `google_ads` account. TikTok sync reads `tiktok_ads`. A TikTok creator profile is not sent as an advertiser id.
- **Organic observations.** A measurement key is stored on the row (migration `0107`). Two syncs cannot insert that measurement twice.
- **Rate limits.** A shared Postgres window gives up after 10 seconds if the database does not answer.
- **Status.** The system status no longer reports provider tokens found in the environment. Its unused `providers` field is removed.

**Known issues.**

- Orchestrator production steps are not connected. Each step reports NOT CONNECTED, and none reports success.
- The orchestrator's server checks still let a member plan, run and edit steps. The UI requires an admin. The owner decides whether the server changes.
- The provider status field in system status still reads environment tokens. It changes provider logic, so it waits for the owner's decision.
- Credentials are not yet in one API and hub. Phase 3, the connection-state fix, is in this release.
- Brand, Home and Create ready states are not checked against a real workspace. The development database cannot create a workspace yet.

## 0.1.0-beta.13 — prerelease

The factory, connection, and scoring work after 0.1.0-beta.12. Tests use fixtures. No live provider call is recorded in this release.

**Upgrade notes.** Migrations `0103` through `0106` are new: a shared rate-limit window, the OAuth return path, grade history, and Content Factory revisions. `GOOGLE_ADS_DEVELOPER_TOKEN` is used only when `GOOGLE_ADS_DEVELOPER_TOKEN_SHARED_DEFAULT=deployment`. A Google customer id and a TikTok advertiser id come from the brand's connected account, not from the process environment.

- **Integrations.** The page no longer loads the credential vault into the browser. Provider cards stay inside a narrow screen.
- **Accounts.** A pasted profile link stores the profile. A video, reel, short, or watch link is not an account id. Signing in from a brand returns to that brand.
- **Content Factory.** A session can be revised after its video is delivered or has failed. The earlier request stays stored. Analysis does not delete the session's reference file. A PDF within 4,000 characters is read into the brief. A longer PDF says it exceeded the limit. An unreadable PDF says it could not be read.
- **Factory.** A saved Factory Line is read for pick and produce. A refused image or an empty video hook is skipped, and the run stops only when nothing was produced. A full run does not approve its own plan when no spend cap is set. Sleep starts at the saved automation and stops above the owner ceiling. A later organic measurement of the same post is stored. A cross-surface win is proposed without changing the other surface's weight.
- **Spend.** A video bill is stored only when the provider reports one. That bill is kept if the file cannot be stored, and the cap does not add the estimate on top of it. The job cost and the run cost are written in one transaction when the database can do that.
- **Grades.** An earlier grade is kept when an ad is graded again. A grade is not rewritten when calibration changes. An unknown country count or platform count is not scored as zero.
- **Publishing and measurement.** Organic posts can go to a connected Facebook, Instagram, YouTube, or TikTok account. Paid ads are created paused. Facebook video reads request views and average watch time only. Unique views are not stored as reach. An Instagram token that declares scopes without `instagram_content_publish` is refused before a publish request.
- **Rate limits.** With `DATABASE_URL`, auth and model calls share one Postgres window (`rate_limit_windows`, migration `0103`). A database error is not reported as a rate limit. Without `DATABASE_URL`, the limit stays in the one local process. An idle database disconnect does not exit the process.
- **Learning.** An organic measurement stored on the sync day, before observation keys existed, is adopted instead of copied. The measurement day is kept.
- **Held calls.** The scheduler inserts one `engine.reconcile_holds` row per organization when none exists. A disabled row stays disabled.
- **Scores.** Opportunity workflow coverage is 1, 0.5, or 0 from whether a product and a known template exist. The heuristic grader does not fill a missing score. A calibration row with no score is left out of the report.
- **Video engine, carried from the unreleased notes.** Contracts v7 to v9: model choice on asset specs, brief requests with `write_script`, and the ledger's `providerRef` (migration `0101`). A chosen call is priced from its catalog price. Narration goes through OpenRouter speech. Speech-to-text is Deepgram. ffmpeg can run on the worker. Live runs are not recorded.
- **Operations.** One advisory lock for the migration runner. Build and preview load `.env`.
- **Docs.** The README, the product docs, and `wiki/` describe the product. The sign-in panel says what Meridian does.

**Still open, and not invented here.** Live keys and live acceptance. Prices Meridian does not guess: HyperFrames per minute, Apify per 1,000 results, and `image.edit`. The render fallback and video-DNA frame labelling remain owner decisions.

## 0.1.0-beta.12 — prerelease

This pre-release is the checkpoint of the video engine (E1 to E6), the Factory integration (I1 to I3) and the business layer (B1 to B6),
after a review of the whole branch. Everything is tested on recorded fixtures. No live provider call has been made.

**Upgrade notes.** Migrations `0095_oauth_state_user` and `0096_engine_chain_calls_request_key` are new. An OAuth connection that was
started before the upgrade must be started again. Connecting a platform account is now an admin action, as disconnecting already was. The
Factory's brand caps are checked against the brand's spend across all its runs. A Factory image provider whose cost is unknown is refused.
An https alert webhook must point at a public host.

**Fixed in the review.**
- Role changes: only an owner can make or change an owner, and nobody can change their own membership. An admin could make themselves owner.
- OAuth: a connection is bound to the person who started it, so another signed-in person cannot bind their own account to a workspace.
- Platform accounts: connecting needs admin, so a member cannot replace an account's credential.
- Invitations: every email, including one that already has an account, is sent an invitation to accept. Nobody is added without consent, and
  the answer does not reveal which emails have accounts.
- Factory approvals: an approval is refused unless the run is waiting at that stage. An early approval would have skipped a later stop.
- Factory caps: a run's own caps are checked against that run's spend, and the brand's caps against the brand's spend across all its runs.
  A new run no longer resets a brand's cap.
- Factory images: a provider whose cost is unknown is never used, so its spend cannot overrun a cap.
- Engine assets: the cache key includes the take count, so a two-take request is not answered from a one-take entry.
- Engine chain calls: a call must belong to a request of its own workspace (migration 0096).
- Alerts: an https webhook to a private or metadata address is refused.
- Keys: the masked form shows four characters only for a key of eight characters or more.
- Factory reels: a scraped link opens only over http or https.
- Release check: the release workflow (renamed `release-check.yml`) runs the same gates as CI, including ffmpeg.
- CI: the sidecar tests gate the `check` job.
- Developer scripts (`ui:baseline`, `ui:design-smoke`, `ui:button-audit`, `e2e`) read `.env`.
- Documentation: the decision engine is chosen on the Setup page; `.env.example` comments match the code.

**Known open in this pre-release, not fixed here.** Each is listed in [docs/engine/PHASE_LOG.md](docs/engine/PHASE_LOG.md).
- Live spend. The render's cost is a fixed estimate recorded as an actual. A server error on a submit can start a second paid job. Failed
  calls are held as spend. A reconciled bill can raise a reservation past its caps without a pause. Holds are not released when a request
  stops short of delivery. Keys must not be connected for the engine until these are fixed.
- Factory. The Apify weekly cap counts candidates but not baseline or snapshot calls. A sleep night that fails never closes its run. A metric
  row can be stored twice. A stuck image job reports as skipped. The learning bridge can write a `published` row with no external id, which
  is latent because nothing in production calls it.
- The migration runner takes no lock, so two overlapping builds can race.

- **A sidebar for the core loop.** Brand brain, Products and Connected accounts sit under Brand; Market and Intelligence under
  Research; Studio, Factory and Library under Create; Opportunities and Reviews under Review; Learning and Calibration under
  Results. Usage & cost, Alerts center, Audit log, Webhook events, Exports and Notification preferences are listed on the Settings
  screen, and every page ends with a link to the next step.
- **One command for a local trial.** `npm run dev` creates `.env` and the secrets on the first run, prints three steps once the app
  answers, and keeps the embedded database in `.data/pglite`. Accounts, workspaces and brands survive a restart. Without `DATABASE_URL`,
  the dev server also runs the queued jobs, so no second terminal is needed. Periodic work still needs `npm run scheduler`.
- **`npm run dev` loads `.env`.** Before, the dev server ignored `.env`, so sign-in sessions and saved provider keys did not survive a
  restart. Values already set in the shell still win. Existing `.env` files may now apply their non-blank defaults, such as
  `BETTER_AUTH_URL=http://127.0.0.1:8080`.
- **`.env.example` is grouped** under "Needed to start" and "Needed for a real deployment". `MERIDIAN_LOCAL_DATA_DIR` is new.
- **Docker Compose.** `Dockerfile`, `docker-compose.yml` and `.dockerignore` run the web app, worker, scheduler and PostgreSQL 16. Not
  yet built or run with a Docker daemon. See [docs/SETUP.md](docs/SETUP.md).
- **Brand brain setup.** The brain opens with a setup panel: the four required fields as steps, in form order. Each step links to its
  field, and the next open one is named. Every field says what to write and shows an example as placeholder text. The example is not saved.
- **Factory approvals on the screen.** A run waiting at produce, launch, test or review shows an approve button to members. Runs show their
  status in plain words, such as "Waiting for your approval". The approval rule is shared with the server, so a button appears only where
  the server would accept it.

### Video engine (`src/engine/`, E1 to E6): code complete on recorded fixtures

No live run is recorded for any phase. Agents hold no keys, so each phase's live acceptance (Bible section 19) waits for the owner. The
details and the open items are in [docs/engine/PHASE_LOG.md](docs/engine/PHASE_LOG.md).

- **E1, skeleton.** Every Bible section 4 contract as zod v4 with its fixtures, the versioned config, the budget engine (estimate, reserve,
  reconcile, cap mode), the scene plan and the composition compiler with five components, the HyperFrames cloud render adapter with an
  idempotency key and an integrity check, the ffmpeg media functions (`functions/ffmpeg`), the API gateway (`src/engine/gateway/`), and
  `npm run engine:e1` (a dry run on recorded responses).
- **E2, first visual types.** The asset router with its cache and circuit breaker; adapters for OpenRouter video, image and speech, Pexels and
  Pixabay; the take gate; five more components. Avatar IV is NOT_CONNECTED, because no verified OpenRouter API exists for it.
- **E3, planner and editor.** The plan stage and the director step, the planner, the director check and the request classifier; the
  deterministic editor with the Bible 8.3 rules; the analyze-reference and voice roles; a pre-flight budget hold at intake; Postgres router
  stores and a reservation-locked ledger.
- **E4, gates.** The pre-render gate, the post-render review, `critic_final` with a Sonnet re-check, and the decision-to-label writer.
- **E5, full range and variants.** The Shotstack fallback; generation variants (Bible 6.13); chain contract v5 and chain execution for
  `cartoon_generated` shots; `stopmotion.player` with a 24-frame floor; the manifest writer; deliver; learning events. Stop motion is
  refused until `image.edit` has a price. Production shot stages are NOT_CONNECTED until their deployment pieces are set.
- **E6, operations.** Stage metrics, alerts, dead letters and replay (replay for an admin only), the batch plan, concurrency proposals and a
  load test, with role-checked server functions in `src/lib/meridian/engine-ops`.
- **Factory integration (I1 to I3).** A Factory video can name the engine as its provider, the run counts one spend total, and the Factory's
  gates and review are shared with the engine.

### Content Factory and the business layer (B1 to B6)

- **Discovery at volume (B1, B2).** Instagram reel candidates per niche through Apify, with creator baselines, S to C tiers and the
  outlier rater; "not rated" with the reason where a tier cannot be known.
- **Theme pages (B3).** The account-level page a run can target, at `/brands/<brand>/pages`.
- **Instagram trial reels (B4).** A trial post with a MANUAL or SS_PERFORMANCE graduation strategy. The feed step is recorded only when a
  graduation is observed; the live reader observes none.
- **Sales attribution (B5).** The Shopify `orders/create` webhook at `/api/webhooks/shopify` stores each order and links it to a reel by
  `utm_content` or a DM keyword. It answers 200 for a stored order.
- **Sleep mode (B6).** Off by default. A nightly run gathers, grades and plans, then waits at produce for approval. A 10% holdout is recorded.
  Tuned values are held to a 15% change a night.
- **Caps at the grade stage.** Before each engine call, the grade stage checks the kill switch and the run's daily and total caps. A refused
  call leaves its ad graded on observed signal only, with the reason, and pauses the run.
- **Provider facts.** Apify, Instagram trial reels, Shopify and the OpenRouter model ids are recorded in
  [docs/PROVIDERS.md](docs/PROVIDERS.md) and [docs/engine/PROVIDER_APIS.md](docs/engine/PROVIDER_APIS.md), with their sources and the date
  read (2026-10-15). They are partly verified; the `verified` flags in the engine's routes stay false until a live run.
- **Screens.** Before and after screenshots of the changed screens are in [docs/feature-screens/](docs/feature-screens/README.md).

### Decisions recorded (2026-10-14 and 2026-10-15)

- Owner: the user sets the cost per master of each video. There is no default. Intake refuses a budget below the minimum for the request.
- Owner: OpenRouter is the default platform for model calls, behind one gateway. The Anthropic API stays as a route target.
- Owner: per-workspace credentials for OpenRouter, HeyGen and Anthropic, and a monthly video budget per workspace with no default.
- Owner: Shotstack is the only render fallback. Remotion Lambda is dropped, because it needs an S3 bucket.
- Delegated to the lead by the owner: Apify is the discovery provider.
- Lead: the stop-motion floor is 24 frames. The kit image key convention is `kits/{org}/{brand}/{kind}/{kitId}/{name}.png`.

### Migrations

- `0077` to `0094` are new. `0083` to `0089` have no file in this repository. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for each one.

## 0.1.0-beta.11 — prerelease

The sections below this one are part of beta.11. Operators must read the upgrade notes in [docs/OPERATIONS.md](docs/OPERATIONS.md)
before deploying. Migrations `0062` to `0065` are new.

- **Factory run settings (behaviour change).** A run has one settings object, with brand defaults and per-run overrides. The old levels map
  to automation modes: level 0 or 1 is `manual`, 2 is `semi`, 3 is `full`. Runs store the settings they started with. The owner ceiling and
  the verified round trip still apply, checked against the mode's level. See [docs/FACTORY.md](docs/FACTORY.md).
- **Factory stops and approvals.** `manual` and `semi` runs wait at produce, launch and test, and `manual` also waits at review. A waiting
  run has the status `awaiting_approval` with the reason. The kill switch stops every stage. `full` stops when it has no spend cap. The
  approval is the `approveFactoryStage` server function. The Factory screen has no approve button yet.
- **Spend caps are declared, not enforced.** No Factory stage writes metered spend yet, so the cap is not checked against real spend.
- **Factory grading uses source data only.** The Meta Ad Library collector stores each ad's stop time and reached countries. An unknown value
  contributes nothing to the score. Days running run to the last sighting. The fixed quality and track-record values are removed. A board
  item with no stored grade says "Not graded yet". The JEV grade is not implemented; it needs the owner's questions and thresholds.
- **Factory cost estimates removed.** The decode, grade, template and produce stages no longer write made-up cents and seconds. Cost rows
  come only from metered calls, and none exist yet.
- **Telemetry honesty.** An unreported metric is stored as null, not zero. Views are no longer copied into impressions. An organic post row
  needs the platform's own post id. Learning reads only paid rows with all four metrics known.
- **Telemetry sync fix.** The bridge now writes `created_by`, which the production table requires. On Postgres the sync failed for any new
  paid row.
- **TikTok regular video.** A TikTok channel uploads through the Content Posting API. The token must grant `video.publish`. Posts are
  private until TikTok approves the app, and a publish is reported as done only on `PUBLISH_COMPLETE`. Not run against the live service.
- **Sourcing sidecar and feeds.** An optional local sidecar parses pages Meridian has already fetched. RSS and V2EX source adapters use it.
  Without the sidecar, both report not connected.
- **S3 retired.** There are no `S3_*` settings. Storage status reads `RETIRED`. Publishing reads media from Postgres or Google Drive.
- **Settings.** The decision engine and provider keys have one entry point, in the Setup panel. Settings points there.
- **Interface.** One page-title size across the screens, a rail on the active sidebar item, tabular figures in stats, button press feedback,
  and the Market screen has a section bar. Not yet checked in a browser; the CI `ui-smoke` run is the check.
- **Not in this release.** Factory work-queue items 3, 5, 6, 8, 9, 10 and 11, the JEV grade, live organic metrics, and the Studio and
  organic reads that show an unknown metric as zero. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Unreleased — production readiness batch 1

Operators must read these before deploying. Migration `0061_oauth_state_redirect_origin.sql` is new.

- **JEV approval needs calibration**: a probability that clears the approval threshold routes to HUMAN_REVIEW until the threshold has a
  calibration report. A probability alone never approves.
- **Learned patterns replace atomically**: the brand's patterns are read, computed, then swapped in one transaction. A failed write keeps
  the previous set, and two replacements for one brand are serialized.
- **OAuth state is single use per origin**: the start origin is stored with the state. The callback claims the state in one statement that
  also checks provider, origin and expiry, then exchanges the code with the stored redirect URI. States started before this release cannot
  be claimed; their users connect again.
- **Artifact host allowlist (optional)**: `MERIDIAN_ARTIFACT_HOST_ALLOWLIST` limits provider artifact downloads to the listed domains and
  their subdomains, checked on every redirect hop. Blank keeps the public-host policy. Set it in production once the provider CDN hosts are
  confirmed.

## Unreleased — fixes from the review of 2b0a119

Operators must read these before deploying. Senders of webhooks must change how they sign.

- **Webhook signature (breaking)**: the signature now covers provider, account, event id, timestamp and the SHA-256 of the body, in the
  `v2` canonical string documented in `docs/PROVIDERS.md`. Old-format signatures are refused with 401. Re-address attempts are refused.
- **Webhook duplicates**: a valid redelivery of a stored event returns 200 "already received" instead of 401. The event and its job are
  written in one transaction.
- **Webhook receipts**: the receipt says "recorded". No downstream processing runs for a webhook yet.
- **Webhook timing**: a body that stalls for 10 seconds returns 408. A bad signature makes no database call.
- **Artifact size and type**: every input form is capped at the artifact byte limit. A job whose modality does not match the artifact
  fails with `ARTIFACT_MODALITY_MISMATCH`. An animated GIF is classified as video.
- **Attached images**: attach runs through the production lifecycle: budget reservation, a job row, storage through the artifact store and
  settlement. It needs the artifact store and refuses before any spend without it. The creative and asset state follow the quality outcome.
  An in-flight or unresolved attach blocks a second one for the same creative.
- **Review actions**: an approve or reject commits all its writes together, and a second decision on the same review is refused.
- **Prohibited claims**: a creative's claims come from its stored product, not from the first product in the brand.

## Unreleased — fixes from the static review of 01307e8

Operators should read these before deploying. Migration `0060_webhook_tenant_scope.sql` is new.

- **Webhooks**: a body over 256 KB is refused with 413, and a body that is not `application/json` with 415. An account connected to
  several organizations is refused with 409 and stores nothing; before, the first organization was picked. Deduplication is per
  organization. Confirm that the relay sends `application/json` and that each account maps to one organization.
- **Calibration**: a saved threshold version no longer enables automatic approval or rejection. Numeric scores go to review until a real
  calibration exists, so workspaces that relied on threshold rows will see more review items.
- **Image QC**: visual checks read the generated image bytes, and attach goes through the shared decision gate. A durable image job is
  judged on its own copy, not on the generation prompt. A plan with an image that has no copy is refused before anything is sent.
- **Providers**: Higgsfield status and cancel requests go only to its fixed origin, and redirects are refused. Provider artifacts are
  downloaded only from public https hosts, with a 200 MB cap and a 30-second deadline. Polling stops at once on permanent errors
  (401, 403, 404) and after 240 polls or 24 hours, moving the job to `SUBMISSION_UNKNOWN`. Its reservation stays held.

## Earlier work in 0.1.0-beta.11 — never tagged

Verified on a freshly migrated PostgreSQL database: the full test suite, typecheck, lint, build, and the browser checks (UI baseline,
browser smoke, design-system smoke, product loop, button audit). Migrations 0055 to 0059 are new.

**Action for deployments that used environment keys:** provider keys from the environment are now used only when the deployment
opts in with the category's `*_SHARED_DEFAULT` variable (see `docs/PROVIDERS.md`). Set the opt-in, or save the key in Settings.

- **Keys**: every workspace provider key resolves through one resolver. Source connectors each have a key and an opt-in. The Meta Ad
  Library key moved into its own encrypted entry. A deployment key alone no longer makes a source ready.
- **Decisions**: one engine per workspace (TypeSafe JEV or OpenAI Decisions). Compare mode, automatic fallback between engines and the
  OpenRouter decision transport are removed. A malformed engine answer is a provider error, never a coerced value.
- **Video**: Google Veo is removed. Gemini Omni is the only Google video engine and the default. Stored videos play in Studio review and
  the Library, with byte-range support.
- **Storage**: Postgres is the system of record. Drive and S3 hold artifacts and exports. Drive uploads resume from the last confirmed byte,
  and the session is kept in Postgres (migration 0056). Admins connect Drive from Settings with OAuth; the refresh token is stored encrypted
  and resumable session URIs are sealed at rest (migration 0058). Uploads over 5 MB need `TOKEN_ENCRYPTION_KEY`.
- **Sourcing**: public-page discovery runs end to end with per-source states, provenance on every evidence row, and deduplication by
  content hash within a brand (migrations 0057 and 0059). Discovery starts from Market and lists recent runs. YouTube, SerpAPI and Meta
  Ad Library have live request code, not yet run against the live services.
- **Brand brain**: the 26 fields come from one list. Four are required, and "Complete brand brain" depends only on those. Onboarding
  resumes at the section the person left (migration 0055).
- **Setup**: `npm run setup` is the one command. Settings → General has a setup view and a Drive panel. `.env.example` lists every variable
  the code reads.
- **Publishing**: Facebook Page and YouTube Shorts post through a connected account, and a receipt is stored only when the service returns an
  id. Instagram Reels reports not connected until a public media route exists. No live posting call was made in this release. Environment
  tokens no longer configure paid Meta, TikTok or Google. The Reddit API reports not connected.
- **Controls**: every button acts or shows why it cannot (`npm run ui:button-audit`). The settings screen and the brand switcher state what is
  missing instead of showing a percentage.
- **Cleanup**: removed dead modules (the Instagram graph adapter, the Meta outcome ingestion, the duplicate-evidence helper, the shadow-decision
  flag and others), a stray emoji, and stale comments.
- **Docs**: rewritten. Start at `docs/README.md`. The legacy plugin brief is kept as it was.

Not yet done: see `docs/ROADMAP.md`.

## Unreleased — UI overhaul

The interface was rebuilt in phases. Server-side role checks, tenancy checks, auth and provider logic did not change.

- **Shell and navigation**: the workspace picker sits at the top of the sidebar and the brand picker sits below it on brand pages. The header is one row. Both pickers are in the mobile navigation.
- **Data layer**: reads and writes go through React Query. Writes report pending, success and failure through one hook.
- **Screens**: Home, Settings, Market, Opportunities, Studio, Library, Reviews, Learning, Brain and Factory were redesigned on one design system. The library trace opens in a sheet.
- **Media**: generated images and videos are served from `/api/assets/:assetId`, which checks tenancy and supports byte ranges and cache validators.
- **Operations**: Jobs, Usage, Audit, Alerts, Calibration, Exports and Webhook events have their own screens.
- **Forms**: typed validation shares one schema between browser and server. Field errors and unsaved-change guards appear before submit.
- **Provider keys**: a key typed for one provider category is no longer sent when another category is saved.
- **Accessibility**: one visible focus outline, 44px touch targets on touch screens, one `main` landmark per screen, and tables become cards below the `md` breakpoint. See the design system's accessibility checks. The repository is not certified.
- **Cleanup**: removed the legacy `components/ui.tsx` shim, `components/status.tsx`, and the unused `email-auth`, `audit` and `why-this-drawer` components. Removed the unused `--color-ink` token and the unused `zustand` dependency.

Not verified yet: the unit test suite, the production build, the browser end-to-end suite and axe audits of the redesigned screens. Those run in the testing pass.

## 0.1.0-beta.8 — 2026-10-09

Meridian beta.7 Stabilization Hotfix:
- **Direct TypeSafe JEV System One**: Implemented official `POST https://api.typesafe.ai/v1/systemone` endpoint with Bearer auth; typed parsing for `choice`, `score`, and `noul`; wired shared `JevRouter` across all decision paths with `auto` fallback and `compare` mode telemetry.
- **Google Gemini Omni Video & Model Lifecycle**: Updated to official Interactions API REST payload (`POST /v1beta/interactions`) with `steps[].content[]` video Base64 extraction and SHA-256 verification; marked retired `veo-2.0-generate-001` as `SHUTDOWN` and set active preview to `veo-3.1-generate-preview`.
- **Cyclone Scout Observation**: Replaced guessed `/devices/{id}/health` with supported `/health` and `/api/v1/devices` readiness checks; zero-fabrication for unobserved permalinks, post dates, and view counts.
- **Evidence-Honest Opportunity Scoring & Benchmark Harness**: Removed synthetic `roas = 1.0` default; created versioned Gold Set harness (`benchmark-harness.ts`) evaluating ranking with governance requirements ($N \ge 100$ for `validated`).
- **Live CreativeManifest Studio Wiring**: Wired `CreativeManifest` into Studio generation with mode/strategy gating, preventing `research_only` from submitting generation jobs and mapping manifest beats into durable `CreativeSpec` and `production_jobs.input`.
- **Test Suite Expansion**: Added comprehensive acceptance tests across all hotfix modules (502 tests passing).

## 0.1.0-beta.7 — 2026-10-09

Unified Master Engineering Specification v3: Native Decisions API JEV Router, Google Gemini Omni Video, Strict Metrology & Discovery Truthfulness, 4-Target Viral Intelligence, and Universal Creative Manifest.

- **Dual JEV Provider Router**:
  - Implemented `JevRouter`, `TypeSafeDirectJevProvider`, and `OpenRouterJevProvider` supporting `AUTO`, `TYPESAFE_DIRECT`, `OPENROUTER`, and `COMPARE` provider routing policies.
  - Full adherence to OpenRouter native Decisions API (`POST /api/alpha/decisions`) and model `typesafe/jev-1.13`, preserving exact `choice`, `noul`, and `score` union responses without generic chat-completion fallback.
  - Fail closed with `NOT_CONFIGURED` when credentials or endpoints are missing; comparison mode runs on gold sets without merging answers.
- **Google Gemini Omni Video & Model Lifecycle Registry**:
  - `GeminiOmniVideoProvider`: Google video generation adapter via official Gemini Interactions API (`POST /v1beta/interactions`) with `gemini-omni-1.1-flash`.
  - `ModelCapabilityRegistry`: Tracks model lifecycle, supported tasks/modalities, and shutdown dates. Flags `veo-3.1-generate-preview` shutdown date (2026-10-22) with automated warnings pointing to `gemini-omni-1.1-flash`, while keeping stable GA `veo-2.0-generate-001`.
  - Fully integrated into `ProductionRouter` alongside `veo`, `higgsfield`, `hypit`, and `manual_cloud`.
- **Truthful Metrology & Discovery Fabric**:
  - Removed all synthesized metrics (`15000` default follower count, `Math.max(1000, likes * 15)`, `5000` reels count) across `cyclone-scout-adapter` and `graph-api-adapter`.
  - Missing metrics strictly remain `undefined`/`null`, eliminating artificial outliers and skewed baselines.
- **4-Target Viral Intelligence & Concept Genome**:
  - Decomposed opportunity rating into 4 explicit, distinct targets: `observedBreakoutScore`, `conceptStrengthScore`, `transferPotentialScore`, and `businessPotentialScore`.
  - Business potential strictly returns `null` when downstream telemetry is unavailable.
  - `ConceptGenome`: Versioned entity mapping mechanisms directly to the 11D Angle Bible, supporting organic structures and multi-format concepts.
- **Universal Creative Manifest**:
  - Implemented `CreativeManifest` supporting all creation modes: `research_only`, `image_ad`, `organic_image`, `carousel`, `video_reel_short`, and `mixed_format`.
  - `validateCreationPlan`: Enforces execution safety, strictly preventing `research_only` from spinning up production jobs, and validating required assets and beat lists.
- **Historical Regression Hardening**:
  - Added regression tests 29-35 in `historical-regression.test.ts` verifying all core invariants (35/35 historical regression tests and 484/484 total repository tests passing).

## 0.1.0-beta.6 — 2026-10-09

Final Runtime Integration & Hardening: ProductionRouter, Durable PostgreSQL Jobs, Model-Accurate Adapters, Truthful Nullable Semantics, and End-to-End Integration Gates.

- **ProductionRouter Integration**: Studio generation path completely decouples provider specifics, routing via `CreativeSpec` to `ProductionRouter.route()` across Veo, Higgsfield, Hypit, and ManualCloud.
- **Strict Testing Runtime Isolation**: `test:video` cannot be resolved in `ProductionRuntime` and is strictly confined to `TestingRuntime` via dependency injection.
- **Durable PostgreSQL Job State**: Added migration `0028_durable_production_jobs.sql` persisting `request_id`, `status_url`, `cancel_url`, `spec_hash`, polling timestamps, and resumption metadata to guarantee persistence across worker restarts.
- **Model-Accurate Video Adapters**:
  - `Google Veo Provider`: Validates model-specific `VideoCapability` specifications before remote network calls; parses REST `generatedSamples` for output artifacts.
  - `Higgsfield Provider`: Implements model selection (`dop-v1`, `higgsfield-video-v1`) with official `Authorization: Key` contract and preserves exact upstream request/status/cancel URLs.
- **Truthful Nullable Telemetry & Metrology**: Search-and-replace elimination of `Number(...) || 0` coercion; unobserved views, shares, and completion rates are strictly preserved as `null`, preventing false negatives in Bayesian updates and outlier scoring.
- **Native JEV Decisions API & Strict Protocol**: Strict enforcement of the `answers` object protocol from OpenRouter Decisions API, preserving unadulterated `noul` probabilities without fake confidence, and recording true `NULL` database values.
- **Canonical CreativeStructure**: Formats modeled canonically (`organic_short`, `pov`, `skit`, `listicle`, etc.) with inferred classification heuristics (`heuristicScore`), reserving the 6-beat `AdNarrative` as an optional projection for paid ads.
- **Loud Migration Validation**: Removed `when others then null` in migration `0027` to ensure schema reconciliation fails loudly rather than corrupting tenant state.
- **Comprehensive End-to-End Integration Testing**: 4 representative boundary tests covering organic discovery, production routing, publishing gating, and closed-loop telemetry updates (464/464 total automated tests passing).

## 0.1.0-beta.5 — 2026-10-08

Enterprise JEV Account Intelligence, Multi-Account Credential Vault, Publishing Orchestrator, Unified Telemetry Flywheel, and Operator Control Center.

- **Cryptographic Credential Vault**: AES-256-GCM authenticated encryption for platform credentials with per-brand and per-tenant cryptographic isolation. Multi-account credential assignment across Instagram, Facebook, YouTube, TikTok, Meta Ads, and Google Ads.
- **Multi-Account Platform Manager**: Manage multiple social pages, creator handles, and ad accounts per brand with automated status probing and health monitoring.
- **JEV Large-Scale Multimodal Account Intelligence**: Full 6-beat short-form narrative decomposition (hook, problem, mechanism, demonstration, proof, call-to-action), decile trait performance separation, logistic hook retention curves, and interactive Whitespace Opportunity Radar.
- **Multi-Account Publishing Orchestration**: Deterministic minute-normalized idempotency hashing, atomic PostgreSQL `FOR UPDATE SKIP LOCKED` worker claims, platform rate limits, backoff retry policies, and durable publication receipts.
- **Unified Telemetry & Closed-Loop Bayesian Flywheel**: Multi-channel performance telemetry ingestion (CTR, CVR, ROAS, 3s hook retention, completion rate, share rate) with 14-day half-life exponential recency-decay weighting, conjugate Beta-binomial updating, hierarchical vertical cold-start priors, and Benjamini-Hochberg FDR control.
- **Operator Control Center**: Global Cmd+K / Ctrl+K command palette with instant search and keyboard chords (`G O`, `G S`, `G R`, `G I`, `G L`, `G F`, `G A`), queue observability in `/api/health`, and dedicated worker jobs (`accounts.probe`, `publishing.dispatch`, `telemetry.sync`).
- **Complete Enterprise Documentation**: Comprehensive operator runbooks, security specifications, and architecture guides across all core subsystems.

## 0.1.0-beta.4 — 2026-10-07

Content factory foundation on top of beta.3. Copy the framework, never the ad.

- Production and published deploys refuse to start without `DATABASE_URL`. The embedded database remains for local preview only.
- JEV outputs are labelled as scores, not probabilities. A calibration report records Brier score and a reliability curve without moving thresholds.
- Learning uses a beta-binomial model per attribute with credible intervals and a multiple-testing correction. Thin samples are not stored as winners.
- Rate limits apply to sign-in, invites, uploads, and model-calling server functions (per IP or user).
- Research collection records yield: ads found, videos downloaded, transcripts, snapshot-without-video. Snapshot media stays off unless `RESEARCH_SNAPSHOT_MEDIA=1`.
- Factory job graph (`factory.discover` … `factory.learn`), Winner Score with a range and evidence, ad timelines, Creative DNA v1, trend clusters, abstract storyboard templates, originality/brand/claims/policy/rights gates, Thompson sampling inside caps, and a kill switch.
- Hypit is adapter one behind a `VideoEngine` interface.
- Factory screen: Discover, Templates, Production, Review, Live tests, Learnings. Autopilot levels 0–3. Spending still starts only inside owner-set caps.

Not in this beta: a live Meta round-trip, a licensed ad-intelligence feed, or measured Ad Library yield on a live token. Those stay `NOT_CONNECTED` until configured.

## 0.1.0-beta.3 — 2026-10-06


JEV Research now collects and analyzes external Meta video-ad evidence as a research layer. It does not replace or gate JEV decisions.

- Forms share typed browser/server validation for market collection, competitor records, creative observations, manual performance, paused publishing, performance schedules, and Studio generation choices. Field errors and unsaved state appear before submission; invalid calendar dates are rejected.
- Reject IPv4-mapped and translated private IPv6 targets, non-public IPv6 ranges, and reserved IPv4 ranges before public fetches; malformed address input fails closed.
- Public-page text extraction decodes named and numeric HTML entities exactly once.
- Long-running SQL jobs renew their lease heartbeat while work is active; `claimAndRun` also schedules retries with exponential backoff.
- Webhook deliveries that lose a concurrent duplicate insert race return success.
- The request rate-limiter helper is documented accurately as not wired to routes.
- A tenant-scoped worker collects bounded, deduplicated Meta Ad Library video records with captured source provenance. A run stores at most 100 MB of source video and each video is capped at 24 MB.
- Public Meta snapshot media is fetched only when an explicit video URL is exposed, validated against the existing SSRF protections, verified as MP4, and stored with a checksum. Unavailable media remains unavailable.
- Local WhisperX transcription stores timestamped segments by content hash. OpenRouter produces versioned typed advertising analysis with evidence references and confidence; low-confidence results require review.
- Research analysis is durably stored with field evidence, confidence, model/prompt provenance, and analysis ids; retries reuse the same transcript/schema/model analysis. Aggregates report observed corpus frequency, not performance or causal evidence. Organization-level summaries contain no cross-brand examples and are used only when the brand has opted into organization learning.
- Repeated external patterns feed the existing opportunity, JEV decision, brief, and Hypit lineage path. Research evidence enriches a matching opportunity rather than creating a duplicate angle.
- Research model runs are recorded for provenance; transient collection/media/transcription/analysis failures use the existing job retries and dead-letter policy.
- Approved stored Hypit MP4s now use the existing Meta publisher: Meridian validates the JEV/Hypit/tenant lineage and bytes, reconciles ambiguous upload retries, persists Meta's confirmed video id, then builds the existing paused campaign/ad-set/creative/ad chain. Missing Meta configuration stays `NOT_CONNECTED`; no receipt is fabricated.
- Meta performance scheduling and worker execution verify creative/ad ownership for the same organization and brand. Performance fetches use the organization's credential and confirm access to the selected ad account before observations are stored.
- Workspace forms now share typed browser/server validation for all supported form workflows, including field-level errors and unsaved-change feedback.

Research collection requires `META_AD_LIBRARY_TOKEN`, `OPENROUTER_API_KEY`, local WhisperX, and `ffmpeg`/`ffprobe` on the worker host. Google AI Studio / Nano Banana is optional for image generation. Hypit remains the only production video engine, and the worker no longer executes legacy xAI video jobs. Meta snapshots that do not expose a downloadable video remain unanalyzed. See `docs/PROVIDERS.md` and `docs/SETUP.md`.

## 0.1.0-beta.2 — 2026-10-06

Video generation now follows an approved JEV decision into a separate Hypit process.

- Studio uses Hypit for the production video path. A rejected or unapproved decision creates no job. A missing `HYPIT_BASE_URL` is `HYPIT_NOT_CONNECTED`. A failed Hypit run stores no video.
- A succeeded Hypit artifact is stored, then published through the existing publisher. A missing file, a failed job, or another tenant's artifact is not published.
- Test performance attached to that receipt uses the existing ingestion and `learning.update` path. It is labeled `test:performance` and is not a live ad-account result.
- A public page collected by the existing fetcher is passed into the next brief as untrusted text. The Meta Ad Library stays not connected without its token.
- Setup documents the separate Hypit runtime. Hypit source is not included in this repository.

Not in this beta: a live Meta, TikTok, or Google account, or a claim that synthetic performance is real delivery data.

## 0.1.0-beta.1 — 2026-10-06

First beta of the Meridian application.

- Brand Brain, market evidence, semantic clustering, opportunities, JEV, briefs, Studio, review, publishing clients, performance ingestion, and learning write-back are in the product path.
- JEV is the decision layer for opportunity, brief, and creative QA. Missing or contradictory evidence does not auto-approve. Calibration changes future decisions only after an admin approves a version.
- Historical beta note: video generation used the then-current provider adapter. This has been replaced by the Hypit production path described above.
- Meta, TikTok, Google Ads, and Ad Library clients stay not connected until a request succeeds.
- Invites are stored. Email is sent only when an email API is configured and accepts the message.
- Local setup is documented in `docs/SETUP.md`, with `.env.example` and an embedded Postgres option.
- GitHub Actions runs tests, typecheck, lint, and the production build. The application is not published to npm.

Not in this beta: a hosted ad account, a verified S3 bucket, or a claim that live campaigns are running. Those stay external.
