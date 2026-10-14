# Asset router and provider adapters (W5)

Implements Video Engine Bible **section 10** (asset router, adapters, scoring, concurrency, caching and failures) and the
stock licence rule of **section 19 (E2)**. Status and the owner's live checks are in `STATUS.md`.

## Files

- `router.ts`: `createAssetRouter(deps).produce(input)`. Filters the routed targets of a model class, scores them, serves a
  cache hit at $0, and runs each candidate under one `paidCall` keyed by `assetCacheKey(spec, adapter.id)`.
- `score.ts`: the seven provider dimensions (10.2) with weights from `config/weights.ts`. Unknowns are left out of the mean.
- `breaker.ts`, `buckets.ts`, `cache.ts`, `stats.ts`: small store interfaces, each with an in-memory implementation.
- `normalise.ts`: validates what providers return (image and speech type and magic bytes, size, https URLs, base64).
- `classify.ts`: maps HTTP statuses, thrown errors and failed jobs to `ProviderError`.
- `adapter.ts`: `RoutedAdapter` (the 10.1 interface plus `providerId`, `connection` and `detailsFor`), `MediaStore`,
  `listPriceUsd` (unknown price throws `unknown_price`).
- `providers/`: one file per vendor surface (`openrouterVideo`, `openrouterImage`, `openrouterSpeech`, `avatarIv`, `pexels`,
  `pixabay`), and `index.ts`, which maps a route to its adapter.
- `stock.ts`: the stock search across the `stock` route (free; not a `ProviderAdapter`, see STATUS.md).
- `firstLastFrame.ts`: the first-and-last-frame test (Bible 20.3 item 2): a table from `GET /videos/models`, and a live run
  that submits one test per model whose listing shows both frames.

## Rules the router follows

- Every call goes through an adapter, and every adapter calls only the gateway. The router never sends a request.
- Targets come from `gateway.routes(modelClass)`; no provider or model is chosen in code.
- A paid submit is authorized before it is sent (`paidCall`); a refused call is never sent; a duplicate key is never sent.
- Retries (10.4) happen inside one paid call. `rate_limit` and `server` retry on the same provider with backoff, up to
  `thresholds.jobs.maxAttempts` submits. `timeout` does not retry. `content_policy` and `invalid_input` do not retry and do
  not fall back: they return `failed` for the planner. Any other error moves to the next target.
- The circuit breaker and the concurrency buckets read `config/thresholds.ts`.
- A cache hit is per workspace, costs $0, writes no ledger row, and is recorded with `recordHit`.

## Tests

`*.test.ts` next to the code, with recorded fixtures in `test/fixtures/` shaped to `docs/engine/PROVIDER_APIS.md`. The
transport is scripted (`test/recorded.ts`) and fails on any request it was not told to expect, so a test that calls a
provider by mistake fails. No test calls a live API.
