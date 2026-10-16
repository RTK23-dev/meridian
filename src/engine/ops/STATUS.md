# ops (W14, Phase E6): status

Branch `eng-e6-ops-2`, base `5d5925b`. Owner instruction: this agent ran no test, typecheck or lint. Every test here is written and
**unrun**. The lead runs the checks after the phases are done.

## What is here

| File | Purpose | Test |
| --- | --- | --- |
| `metrics.ts` | Pure stage durations (p50, p95 per stage and basis), request wall time, gate pass rates, provider health, cost per master and variant with ledger reconciliation, queue depth and age | `metrics.test.ts` |
| `metrics-sql.ts` | Reads the engine tables for a workspace scope and runs `metrics.ts` on the rows | exercised by `load.test.ts` |
| `alerts.ts` | Pure alert rules: `budget_overrun`, `dead_letter_growth`, `breaker_open`, `stuck_request`, `gate_pass_drop`. Each alert is typed, with a severity, a reason code and the measured number | `alerts.test.ts` |
| `alerts-sql.ts` | Reads the alert snapshot for a scope at a given clock | exercised by `load.test.ts` |
| `deadletter.ts` | Lists the dead engine jobs of a workspace (per request), with the stage, attempts, short error, and whether the job is recorded, replayed, or paused on this request | `replay.test.ts`, `load.test.ts` |
| `replay.ts` | Replays one dead job: re-queues its stage with the orchestrator's own `resume` from the request's last good artifacts (Bible 5.2). Idempotent under `replay:<jobId>`; an audit row per job (`ops.replay`). Admin role, checked here | `replay.test.ts`, `load.test.ts` |
| `batch.ts` | Batch planning for `priority: batch`. Every plan is normal calls today (see the route request below) | `batch.test.ts` |
| `concurrency.ts` | Proposes a size per bucket (video, image, tts) from 429 share and latency trend, held without headroom evidence. Writes nothing | `concurrency.test.ts` |
| `distribution.ts`, `scope.ts`, `json.ts` | Percentiles and rates (null when empty), the workspace scope (refused when empty, blank or over 1000), safe JSON reads | `distribution.test.ts`, `scope.test.ts` |
| `thresholds.ts` | The proposed thresholds (below). Not in `config/`; the lead moves them when accepted | checked in `alerts.test.ts` |
| `test/chain.ts` | Test driver: per-request ids for the chain fixtures, upstream stages answered from fixtures, the real stages drained through Meridian's `claimAndRun` (worker claim, retry and dead-letter semantics), with retries due at once | used by the two PGlite tests |
| `replay.test.ts` | One request: a deliver fault gives three attempts, a dead letter and a pause; member refused; admin replay; second replay a duplicate; the request delivers | PGlite |
| `load.test.ts` | E6: 100 requests across 10 formats and 3 brand pages, all in flight together. Four deliver faults: three replayed, one left paused. Checks no request is lost, the metrics, the alerts, batch planning and concurrency | PGlite |

Fix made to existing code: `metrics.ts` `costSummary` now counts a request whose delivered video has an unknown cost, or whose
delivered videos have no ledger total, as unreconciled. Before, both were skipped or counted as a mismatch.

## Run (lead)

    NODE_ENV=development node --experimental-strip-types --test src/engine/ops/*.test.ts
    npm run typecheck
    npm run lint

Each PGlite test creates its own database (about 80 migrations), so the two PGlite files take several seconds each. With
`MERIDIAN_PG_TEST_URL` set, the same tests run on Postgres.

## Hook points for the lead (src/engine/jobs is not edited)

1. **Stage start event.** `dispatch.ts` `run()` should write a `stage.started` row (kind `stage.started`, stage, subject_id,
   job_id = job.id, dedupe `start:<jobId>`) before `handler.run`. `metrics.ts` already pairs it. Until then the stage durations
   are `queued_to_result` (they include the queue wait), and the report names the basis.
2. **Bucket saturation.** `proposeConcurrency` needs `saturation` per bucket: the share of sampled moments a bucket was full.
   `engine_bucket_leases` can be sampled into a table (an engine migration, eng-pipeline). The router does not record a full bucket
   as an attempt. Until a sample exists the sizing holds at the current size (the tests check it).
3. **Replay of a succeeded stage** (Bible 15.5, for debugging) needs an orchestrator event that re-queues a completed stage.
   Not built. `replay.ts` covers dead-lettered stages only.
4. **Role checks on reads.** `replayDeadJob` checks the admin role itself. The reads (`readStageMetrics`, `readAlertSnapshot`,
   `listDeadJobs`) check tenancy only (`scope.ts`); the API route must check the viewer role before calling them.
5. **Alert channels.** Alerts carry `severity` (`page` or `warn`). The lead maps them to channels. Nothing is paged from here.
6. **Full reads.** `readStageMetrics` reads the whole scope unless `since` is passed. The API should pass a time window
   (the last day or week).
7. **Formats.** `engine_requests.format_id` is the format column the metrics group by. The contract has no format registry, so
   the load test varies this column (`fmt_load_01` to `fmt_load_10`) and keeps the fixture body.

## Proposed thresholds (`ops/thresholds.ts`, for config/thresholds.ts)

| Value | Proposed | Source |
| --- | --- | --- |
| Reservation overrun share | 0 (any settled spend over the ceiling is a defect) | Bible 14.1 cap mode |
| Format over estimate, share | 0.2 for a day | Bible 14.4 |
| Format minimum delivered requests | 5 | proposed |
| Open dead letter, minutes | 15 | Bible 15.3 |
| Dead-job growth: window and count | 60 minutes, 5 jobs | proposed |
| Breaker alert when open | on | Bible 15.3 |
| Stuck request: minutes with no live job | 30 | proposed |
| Gate pass drop: points, recent window, baseline window | 0.2, 60 minutes, 24 hours | Bible 15.3 (points and window); baseline proposed |
| Gate minimum evaluations per window | 10 | proposed |
| Concurrency window | 1 hour | proposed |
| Concurrency 429 share limit | 0.05 | proposed (Bible 10.4 gives the breaker's 30 per cent, not 429s) |
| Concurrency shrink factor, growth share | 0.75, 0.10 | proposed |
| Concurrency saturation minimum | 0.5 | proposed |
| Concurrency latency rising ratio | 1.5 | proposed |
| Concurrency minimum attempts | `router.minAttempts` (10) | config |
| Concurrency bounds (floor, ceiling) | video 2 to 20; image 4 to 40; tts 4 to 60 | proposed. The router's current 10, 20, 30 sit inside |

The router's own concurrency numbers stay in config (`router.concurrency`). Nothing changed there.

## Batch route request (Bible 20.3 item 6)

The route table has no batch field and OpenRouter's batch support is unknown. The planner reports `not supported on this route`
and runs normal calls for every batch request, so no batch saving (Bible 11.4, 14) is counted. Request to the lead and eng-contracts:
verify whether OpenRouter passes through the Anthropic Batch API for `anthropic/claude-*`. If it does, add a per-route `batch`
field (`status`, `executorBuilt`) to `config/routes.ts` through eng-contracts, with a version bump, and build the executor. Until
then this branch changes nothing there.

## E6 load test: what it asserts, and its risks (all unrun)

- 100 requests, 10 formats, 3 brand pages (brands are Meridian's `brands` rows; the Bible calls them pages). Every fifth request
  asks for one music variant (20 variants). Every tenth is a `batch` priority request (planned as normal calls).
- Four requests fail their deliver stage on every attempt. Each dead job is recorded, the request pauses, and the test replays
  three after clearing the fault. The fourth stays paused: it must show as a page alert an hour later, and nothing else alerts.
- Asserted: all requests are delivered or paused, none running, rejected or with a live engine job left; metrics counts; no
  negative stage samples; every gate passes except the take gate (one take fails on purpose); cost reconciles for 99 requests.
- Risks I could not check without running:
  - `test/chain.ts` renames every prefixed ULID in the chain fixtures per request. A handler that compares a value derived from the
    fixtures' fixed ids with a fixed string would fail. The single-request scenario tests do not exercise this.
  - The variant branch runs compose, pre-render, render and post-render through deliver for 20 requests. The scenario tests only go
    as far as compose for a variant.
  - Durations are PGlite durations, not production ones. The test prints them as diagnostics and does not assert a budget.
  - Upstream stages are answered, so no provider call goes through the router. Provider success rates are therefore not measured in
    this run (the test asserts `providers` is empty). They are covered by the pure tests with fixed rows.

## Owner live run (E6 acceptance, Bible 19)

Agents hold no live keys, so the owner runs this and attaches the output to the phase PR:

1. Against a real Postgres with the worker running (`npm run worker`), start 100 requests through the production API across 10
   formats and 3 brand pages, with a mix of rush, normal and batch priorities.
2. When the queue is empty, read `readStageMetrics` for the workspace and record: p50 and p95 per stage, the request wall time
   p95, the cost p50 and p95 per master and per variant, the gate pass rates, the provider success and rate-limit shares, and the
   dead letters.
3. Record the artifact ids and costs of at least three delivered requests (`engine_manifests`, `engine_ledger`).
4. Write the measured p95 time and cost per master and variant back into Bible sections 15.1 and 14.2 and 14.3.
5. Confirm at least 90 per cent of requests are delivered without a human step.

## Not built

- Replay of a stage that succeeded (hook point 3).
- Saturation sampling (hook point 2).
- A batch executor (the route request above).
- Pagination beyond the 1000-row dead-job limit; the API should page.
