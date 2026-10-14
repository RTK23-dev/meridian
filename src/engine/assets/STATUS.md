# Asset router and adapters (W5): E3 asynchronous submit and settle

Branch `eng-e3-router-async`, cut from `origin/code/beautiful-cori-1zfk11` at `c0767f2`. Fixture-tested only. No live call has
been made: agents hold no keys (North Star decision 1). The owner's live run is listed at the end of this section.

## What changed (E3)

The router was synchronous: `produce` submitted and polled inside one paid call, so a generated take blocked a worker for the
length of the render. It is now three entry points over one state machine (Bible 15.2):

- **`submit(input)`** chooses the target (scored, cached, connected, breaker-checked), authorizes the submit on the ledger, sends
  it, and returns `{ step: { status: "submitted", job, runAfterMs: 0 }, decisions, alerts, attempts }`. A cache hit or a refusal
  returns the terminal `ProduceOutcome` instead. The job holds one concurrency slot on its target until it is settled.
- **`settle(job, poll, input)`** takes the poller's finished answer (`done` or `failed`; a `pending` answer is refused). It
  downloads and checks the take when `takes` is set, reconciles the submit's ledger entry to its bill (or its list estimate when
  the provider reported none), records the attempt in stats and the breaker, and returns one of: `done` (the asset, cost summed
  over the winning target's submits), `failed` (content_policy or invalid_input, to the planner), `submitted` (a retry on the same
  target, with `runAfterMs` = the backoff, or the next target), or the terminal `unavailable`, `refused`, `queued` or `duplicate`.
- **`produce(input)`** is `submit`, then poll each job with the backoff and the deadline, then `settle`, until the step is terminal.
  Synchronous callers and the existing tests use it. Its behaviour is unchanged except where the ledger notes below say so.
- **Idempotent settle (Bible 5.1).** Each settled submit is recorded under `workspaceId + idempotencyKey` in a `SettlementStore`
  (`job.ts`). A second settle returns the first result with no provider call, no ledger write, no stats record and no cache write.
  A settle that is running in another call is refused as retryable (`conflict`), so two polls of one job cannot both retry the
  same submit. A claim whose lease (`thresholds.jobs.leaseMs.generation`) has expired is taken over.
- **The job reference** (`job.ts`, `meridian.asset_job/v1`) is plain JSON, validated with zod on every parse: the provider's job
  id, the submit's ledger key (also the idempotency key sent with it), the scored targets with their cache keys and estimates,
  the target index, the attempt on the target, the submit number across the asset, the bills reconciled so far, and a carry of
  the reasons the targets so far failed, were refused, or were queued. A job that names another request, workspace or reservation,
  or a spec other than the one it was submitted with, is refused before any side effect.

### Ledger (one entry per submit)

Each submit is its own ledger entry (Bible 14.1). The first submit of a target is keyed by its cache key, as before. A retry on
the same target is keyed `<cacheKey>|attempt<n>`, so it is authorized before it is sent and holds its own estimate. The asset's
cost is the sum over the winning target's submits, as before. In `router.test.ts` the assertion for Kling changed: the three
refused submits are three entries that sum to 1.89 (the first alone is 0.63). The total is the same; the books now show each
submit.

### Retries and the slot

| Event | Next step | Slot |
| --- | --- | --- |
| Submit-time rate_limit or server (or retryable unknown) | Retry inside `submit`, with the backoff slept (1 s, 2 s, ... capped), up to `thresholds.jobs.maxAttempts` submits | held |
| Settle: failed with a retryable error, attempts left | New submit on the same target, returned as `submitted` with `runAfterMs` = backoff | held, passed to the new job |
| Settle: timeout, or non-retryable unknown, or retries used up | Next target (a `Decision` names the failed target), or `unavailable` | released before the next target |
| Settle: content_policy or invalid_input | `failed` for the planner, no fallback | released |

A poll deadline is a timeout. Cancel is best effort and is the caller's job before settle (see the open items).

### Takes (opt-in)

`createAssetRouter({ takes: {} })` makes settle download the finished video through the gateway (`gatewayDownloader`, 150 MiB
limit), check it is an mp4 (`normaliseVideo`: an `ftyp` box at byte 4, between 4 KiB and the media functions' input limit), and
store the bytes through the `MediaStore`. The asset then names the stored copy. A download that fails with a retryable error throws,
so the poll job retries the settle with nothing recorded. A file that fails the checks is a failed take and the next target runs.
Without `takes` (the default, and what `produce-shot` uses today) settle returns the provider's own https uri, and the take stage
downloads it as before. Only one of the two should download: see the produce-shot change below.

## Test results (real output, this branch)

- `NODE_ENV=development node --experimental-strip-types --test src/engine/assets/*.test.ts src/engine/assets/providers/*.test.ts src/engine/jobs/handlers/produce-shot.test.ts src/engine/jobs/e3-pipeline.test.ts`
  gives `# tests 163`, `# suites 45`, `# pass 163`, `# fail 0`, `# skipped 0`. The 125 before this change plus 38 new.
- New tests: `submit-settle.test.ts` (15: submit then settle done, with the slot and the ledger; settle failed then next target;
  rate-limited retry on the same target with the summed cost; settle twice; two settles at once; timeout moves to the next target
  with no retry; planner refusal; pending refused; another workspace refused; another spec refused; takes stored; takes download
  503 retried with nothing recorded; a non-mp4 take moves on; a submit answer with no job id is a failed submit and frees its slot), `job.test.ts` (schema and settlement store, 14), `ledger-steps.test.ts`
  (lock use, 3), `normalise-take.test.ts` (video and uri checks, 6).
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing UI files under `src/components/` (none in this change). ESLint on
  `src/engine/assets` and `src/engine/jobs` alone: exit 0, no output.

## Changes needed outside this folder (reported, not made: src/engine/jobs is not this workstream)

These are for the handler owner. `produce-shot.ts` currently calls `router.produce` and treats `submitted` as an error.

1. **Submit.** `routerGenerator` calls `router.submit(input)` instead of `produce`, and returns `submitted` with the whole
   `AssetJob` and `runAfterMs`. `run()` must accept `submitted` from the generator (it throws for it today, in `fromProduction`).
   The job goes in the poll payload (a new `job` field next to `provider`, `jobRef` and `submittedAt`); `scheduleProviderPoll`
   takes the job's first-poll delay from `runAfterMs`, not from `jobSettings.poll.initialMs`.
2. **Settle.** `ShotGenerator.settle` takes the `AssetJob` (not `{providerId, jobRef, submittedAt}`) and calls
   `router.settle(job, polled, input)`. Its `StepReport.step` maps like `ProduceOutcome`, except:
   - `submitted`: `finish` must schedule the next poll for the new `job` (through `scheduleProviderPoll`) and return without
     `applyEngineEvent(succeeded)`. Today `finishPoll` always stores the output as the stage's result.
   - Routers are built with a durable `settlements` store (Postgres). The memory store is not shared across workers, so a
     settle run on another worker would repeat a retry submit. This is the blocking item for production.
3. **Timeout.** The poller's `timed_out` branch throws today. It should call `adapter.cancel` (as it does) and then settle the job
   with `{ state: "failed", error: { kind: "timeout", retryable: true, message } }`, so the next target runs (Bible 10.4).
4. **Download, one place.** Either `produce-shot` keeps `storeTake`'s download and the router is built without `takes` (today's
   behaviour), or the router is built with `takes` and `storeTake` uses the stored uri and skips its own download. Doing both
   downloads twice. The lead to choose.
5. **Bucket leases.** A slot is held from submit until settle. A poll job that dies without settling keeps its slot. The Postgres
   bucket store needs a lease, so a slot expires with its job's lease.

## Open items and risks (owner or lead to decide)

- **Image results are in process.** `openRouterImageAdapter` keeps its job's result in memory, so its poll must run in the process
  that submitted it. `produce` does. A poller on another worker gets "no result" (a failure that is not retryable, so the next
  target runs). Image jobs need durable results, or their submit and poll must stay in one job. Video jobs poll the provider and
  are unaffected.
- **Cancel.** Settle does not cancel. `awaitTerminal` cancels on its own deadline; the poller must do the same before it settles a
  timeout (change 3).
- **Crash between submit and record.** A worker that crashes after the provider accepts a submit and before the job is recorded
  leaves an unknown provider job. OpenRouter documents no idempotency header, so a retry can bill twice. The ledger holds one
  estimate per submit, so the books show the risk. This is the open risk the jobs STATUS already names. A crash between a side
  effect and `settlements.complete` runs that settle again: the reconcile is idempotent, but a stats record can repeat.
- **Retry of a submit that was authorized but never sent.** If a crash falls between `authorizeSubmit` and the provider call, the
  next run finds the key authorized and returns `duplicate`. The job then fails closed (conflict) and nothing is sent twice.
- **Memory stores.** `memorySettlementStore`, `memoryBucketStore`, `memoryProviderStats`, `memoryBreakerStore` and
  `memoryAssetCache` are for tests and single-process use. None of them is shared across workers.

## Owner's live run (E3, in addition to the E2 steps below)

1. Build the router with the Postgres stores and `takes: {}` (or without `takes`, per change 4).
2. `submit` one `video.cinematic` spec (5 s, 9:16). Record `job.providerId`, `job.jobRef`, `job.idempotencyKey`, the ledger
   estimate, and the activity-page cost before any poll.
3. Poll the job once with the adapter's `poll`, then `settle`. Record `asset.costUsd`, `costIsEstimate`, `ledgerEntryId`, and the
   ledger's actual. Settle the same job a second time and confirm no request is sent (count the provider's GET and POST calls).
4. Force a rate limit on the same spec if the provider allows it, or a timeout with a short `pollTimeoutMs`, and record that the
   next step is the same target (rate limit) or the next target (timeout), with each submit's own ledger entry.

## E2 status (retained below)

The text that follows is the E2 status. It is unchanged except where the E3 section above says otherwise (notably the
ledger count for Kling's refused submits, which is now one entry per submit).

## Done (fixture-tested)

- `router.ts`: `createAssetRouter(deps).produce(input)`. Targets from `gateway.routes(modelClass)`. Filters: connection,
  capabilities (duration, aspect, frames, references), a known price, a closed breaker. Scores with the 10.2 weights. Cache
  hit at $0 (per workspace). Otherwise each candidate runs under one `paidCall` keyed by `assetCacheKey(spec, adapter.id)`,
  with its concurrency bucket held for the whole call. Retries and fallback follow 10.4 (see the table below).
- `score.ts`, `breaker.ts`, `buckets.ts`, `cache.ts`, `stats.ts`: pure logic and store interfaces, with in-memory implementations.
- `normalise.ts`: image (PNG, JPEG, WEBP only; type and magic bytes must match; SVG refused), speech (MP3 magic), https URLs,
  strict base64. `classify.ts`: HTTP status, thrown error and failed job to `ProviderError`.
- Adapters (`providers/`): OpenRouter video (one per model, profiles from `GET /videos/models`, 9:16, 1080p, voice off,
  first and last frame), OpenRouter image (`POST /images`), OpenRouter speech (`POST /audio/speech`), HeyGen Avatar IV
  (NOT_CONNECTED, sends nothing), Pexels and Pixabay (stock search with attribution, in `stock.ts`).
- `firstLastFrame.ts`: the 20.3 item 2 harness. Pure table from a listing; live run that submits one test per model whose
  listing shows both frames, under the reservation. Output: rows, a markdown table, and `pinned` for `video.i2v_pinned`.

## Retry and failure rules (as tested)

| Error | Retry on the same provider | Then |
| --- | --- | --- |
| rate_limit, server (and unknown retryable) | yes, backoff 1 s, 2 s, ... up to 3 submits | next target |
| timeout (poll deadline) | no | next target (no cancel: OpenRouter documents none) |
| content_policy, invalid_input | no | `failed` returned to the planner, no fallback |
| unknown (not retryable), including credential refusals | no | next target |

## Test results (real output, head of this branch)

- `NODE_ENV=development node --experimental-strip-types --test src/engine/assets/*.test.ts src/engine/assets/providers/*.test.ts`
  gives `# tests 103`, `# suites 32`, `# pass 103`, `# fail 0`, `# skipped 0`.
- `NODE_ENV=development node --experimental-strip-types --test src/engine/gateway/boundaries.test.ts`: `# pass 3`, `# fail 0`.
  The boundary rules hold: no `fetch`, no credential reads, no model platform host outside `providers.ts`.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors, 4 warnings, all in existing UI files (`src/components/...`), none in this change.

## Decisions for the lead to review

1. **Unknown scores.** A dimension with no value (no pass rate, no gold-set score, no latency comparison, no price difference,
   no continuity provider) is left out of the weighted mean. It is neither 0 nor 1. Ties go to more known weight, then to the
   route's priority. Every decision names the unknown dimensions. In E2 the known dimensions are control (from capabilities),
   cost (when the eligible prices differ) and continuity (when there is an earlier shot). Reliability and latency become
   known after 7 days of attempts.
2. **Retries inside one paid call.** A retry under the same key would be refused as a duplicate, so the whole retry loop for a
   candidate runs inside one `paidCall`. The key is the cache key, which includes the provider, so each provider has its own.
3. **The ledger actual is conservative.** The router reports the sum over submits of the bill the provider reported, or the
   list estimate where none was reported. A retried 429 therefore holds its estimate: the test asserts $1.89 for three refused
   Kling submits at $0.63 each. If OpenRouter does not bill a refused submit, the lead should decide how a known non-billing
   error reconciles to $0 (needs `paid.ts`, see below).
4. **Breaker, literal.** A trip is over 30% provider failures in the last 10 minutes, with no minimum sample size. So one
   failure in an empty window trips it and skips the provider for 10 minutes. A minimum sample needs a config value; not
   added here. After a skip the window starts when the skip ends, so the recovered provider starts clean (a bug found by
   test and fixed: in-flight retries that failed during the skip re-tripped it).
5. **Connection is checked first**, before capabilities and price. A target that is not connected is reported as NOT_CONNECTED
   whatever its capabilities are.
6. **Cache.** Per workspace (Bible 5.2), keyed by `assetCacheKey(spec, adapter.id)`. A hit writes no ledger row (nothing was
   paid) and is recorded through `recordHit`. The first write wins.
7. **Duplicate key.** A call already authorized under the same key is never sent again. The router moves on to other targets
   and returns `duplicate` if none is left.
8. **Stock is not a `ProviderAdapter`.** `ModelClass` has no `stock`, and a stock search returns many clips. `stock.ts`
   searches the `stock` route in order (Pexels, then Pixabay), free (price 0), with no ledger row. Lead: add `stock` to the
   contract, or keep this shape.
9. **Video submit goes through `gateway.call`, not `submitVideo`.** `submitVideo` sends the capability's first target model
   and has no `frame_images` field, so a fallback target would be sent with the wrong model. The adapter builds the same
   request with its own model and frames, through the gateway's authenticated call. Polling uses `pollVideo`.
10. **Image takes.** One image per call (`n: 1`). A take of 2 is the caller's second call with a new seed.
11. **Frames** must be public https URLs (OpenRouter fetches them). A Meridian storage URI cannot be sent.
12. **First-and-last-frame test.** A model whose listing lacks either frame is not submitted to (the listing answers the
    question; no spend). The live run submits to the models whose listing shows both frames. The pinned value is the first
    row that passes on a live submit.

## Needs a change outside this folder (reported, not made)

- **Gateway (eng-pipeline):** `submitVideo` should take an optional `model` and `frameImages`, so the adapter can use it.
  Until then the adapter's direct `gateway.call` is the workaround in decision 9.
- **Ledger (eng-pipeline / `paid.ts`):** `paidCall` marks any reported actual as a bill, but the router can report a sum that
  includes estimates for unbilled submits. A `LedgerEntry` flag for "partly estimated", or a way to reconcile a known
  non-billing error to $0, is needed.
- **Config (eng-contracts):** these values sit in the adapters and the router. Move them to `src/engine/config/`:
  `ROUTER_CONSTANTS` (poll interval 5 s, backoff 1 s base, 30 s cap, 7-day reliability window), the submit, image, speech and
  stock timeouts (60 s, 120 s, 120 s, 30 s), `OUTPUT_LIMITS` in `normalise.ts`, and the stock sizes in `pexels.ts` and
  `pixabay.ts` (1080 px minimum width and 1920 px height for Pixabay's search).
- **Artifact storage (W2):** `MediaStore` is an interface. The image and speech adapters need a real implementation (the
  artifact store over Meridian's object store). Video URLs are the provider's, and the cache stores whatever uri the router
  returns. Before a cached video URL is reused, the artifact store must copy it into storage and point the cache at the copy.
- **Contracts (eng-contracts):** `ModelClass` lacks `stock` (decision 8).
- **Video checks (W4 and W11):** the router validates the video URL only. Duration, codec and size must be probed by the
  media functions after storage and before the take gate. Bible section 19's rule to validate type, size, duration and codec
  before storing is met here for images (type, magic bytes, size) and speech (type, magic bytes, size; duration is probed
  later). For video it is met only for the URL.
- **Routes (lead):** after the live run, set `video.i2v_pinned` in `config/routes.ts` from `FrameTestRun.pinned`, and set the
  verified flags. `tts` and `image.edit` have null models, so they report not connected. `image.keyframe` is routed.
- **Persistence:** the router takes store interfaces. The memory stores are for tests. A live run needs the Postgres ledger,
  and Postgres or durable versions of the cache, stats, breaker and bucket stores. Without them the budget and cache are not
  shared across processes.

## Not verified (no live API; PROVIDER_APIS.md is the only source)

- The OpenRouter video policy-refusal body. PROVIDER_APIS.md has no refusal shape. `classify.ts` matches
  `moderat|content policy|policy|safety|unsafe` in a 400 body or a failed job's text. The fixtures for that are synthetic.
- The 400 "unsupported value" body. PROVIDER_APIS.md says the body lists the supported values, not its shape. The fixture is
  representative.
- Whether OpenRouter video takes an idempotency header. None is documented, so none is sent. A 5xx after the job was created
  may bill twice. The ledger holds one estimate per submit, so the books show the risk, but the provider does not dedupe.
- The `GET /videos/models` field types (durations as numbers, frame names as strings). An entry that does not match is
  rejected by id, not guessed.
- Pexels and Pixabay licence terms for commercial social use (E2.6, owner). Clips are `licence.status: "unverified"` with a
  null licence page. The licence page URL is not in PROVIDER_APIS.md, so it is not recorded. Nothing ships on a stock clip
  until the owner records the check in the rights rules.
- Speech and image-edit model ids. They are null in `config/routes.ts` (speech is set with the voice stage, W6; image.edit is
  set in E2 and is not built here, since it needs reference images). `image.keyframe` routes to `bytedance-seed/seedream-4.5`,
  the id PROVIDER_APIS.md gives as an example, not a verified one.
- Avatar IV via OpenRouter (Bible 20.3 item 3). There is no verified API, so the adapter reports NOT_CONNECTED.

## The owner's live run (exact steps)

Use the Postgres ledger and stores (see Persistence). Keep each run under a reservation that caps it. Record each result
below in the PR: ids, costs, and the activity-page figure beside each.

1. **Routes.** Run `verifyRoutes(gateway, ["video.cinematic", "video.budget", "image.keyframe"])` (gateway/openrouter.ts). Set
   `verified: true` in `config/routes.ts` for each id it lists.
2. **Listing.** `listVideoModels(gateway, orgId)`, then `videoProfilesFromListing(listing)`. Record `profiles` and `rejected`.
3. **First-and-last-frame run (Bible 20.3 item 2).** `runFirstLastFrameTest({ gateway, organizationId, workspaceId, ledger,
   reservationId, frames: { first, last }, durationSeconds: 5, at })` with two public https frame images and a reservation of
   $3 or less. Record `table`, the job ids, and the ledger estimates. Set `video.i2v_pinned` in `routes.ts` from `pinned` (or
   leave it null if `pinned` is null).
4. **One video.** `createAssetRouter(...).produce(...)` with `video.cinematic`, 5 s, 9:16, and no frames. Record `asset.uri`,
   `costUsd`, `costIsEstimate`, `submits`, `ledgerEntryId`, and the activity-page cost. Download the file through the gateway
   and probe it (media functions): confirm 1080 x 1920, duration within 0.1 s, H.264.
5. **One image.** `produce` with `image.keyframe` (`bytedance-seed/seedream-4.5`). Record the `uri`, `costUsd` (from
   `usage.cost`), the media type and the activity-page cost. Confirm the PNG opens.
6. **Speech.** Not run until the speech model id and a voice id are set (`tts`, Bible 20.2 and W6). Then `produce` with
   `tts` and the voice of a page. Record the generation id from `detailsFor`, and the estimated cost (speech reports none).
7. **Stock.** `searchStock` with Pexels and Pixabay keys and a query. Record the clip ids, `sourceUrl`, `author` and
   `downloadUrl`. Owner: read both licence terms for commercial short-form posts and record the decision (E2.6). Until then
   the clips stay `unverified`.
8. **Policy refusal.** Send one prompt the video model refuses. Record the exact 400 body or failed job, and confirm or change
   `POLICY_PATTERN` in `classify.ts`.
9. **Idempotency.** Owner decision whether to spend up to $1 to test whether an identical submit creates a second billed job.
   Record the result.
10. **Refused submits.** Check on the activity page whether a 429 submit is billed. Record it. This decides decision 3.
11. **Avatar.** Verify Avatar IV via OpenRouter (Bible 20.3 item 3) before any route is set. Until then it stays NOT_CONNECTED.

Bible section 19 E2 is not met by this work alone. The acceptance is one shot each for `ugc_presenter`, `product_hero`,
`stock_footage` and `coded_graphics` that passes the take gate, and a deliberately bad take that fails it. That needs the
planner, the take gate (W11) and the live run above.
