# Gateway status

## Model catalog (Bible 10.5 step 1, contract v7; 2026-10-17)

- `catalog.ts`: `readModelCatalog(gateway, { organizationId, now? }): Promise<CatalogRead>` reads `GET /videos/models`,
  `GET /models?output_modalities=image` and `GET /models?output_modalities=speech` through `gateway.call` (no fetch, key from the
  credential source) and returns `{ readAt, entries: ModelCatalogEntry[], dropped, failed, videoListing }`, or `not_connected` with a
  `NOT_CONNECTED:` reason (no key or a refused key; nothing more is sent). Rows are parsed with zod; a row that does not parse, cannot be
  mapped, or has no positive price the engine can estimate from is dropped with its reason. Video: per-second SKU
  `per-video-second-1080p`, then `per-video-second`. Image: `image_output` (per image), then `request`. Speech: `request`. Token-only,
  zero and `-1` prices are dropped. Video rows serve `video.cinematic` and `video.budget` only (never `video.i2v_pinned`, which needs the
  E2 frame test; never `avatar`, which the listing does not mark). Unknown capabilities stay null.
- `modelCatalogCache({ gateway, ttlMs?, now? })`: per-workspace in-memory cache, TTL `adapters.catalog.ttlMs` (initial 10 min). Only a
  read with no failed listing is kept; concurrent reads share one request set.
- `catalog-fit.ts`: `eligibleCandidates(need: ModelNeed, entries) => { eligible, rejected: { id, reason, detail }[] }` with
  `ModelNeed = { modelClass, durationSeconds, aspect: "9:16", resolution, firstFrame, lastFrame, refCount, audio }` and 16 rejection
  reasons (`REJECTION_REASONS`); `rankCandidates(modelClass, eligible, ranked = modelPreferences.ranked)` (empty table: no reordering).
- Tests: `catalog.test.ts` (12), `catalog-fit.test.ts` (22). Fixtures `test/fixtures/openrouter-catalog-*.json`.
- **Unverified live**: the `pricing_skus` keys, the `/models` pricing field names and units (`image_output` per image), the speech
  modality name, and whether `GET /models` pages (PROVIDER_APIS.md saw 10 of "400+" entries with `has_more: false`). The owner's live run:
  `readModelCatalog` against a real key, compared with the fixtures.

## E3 (branch `eng-e3-pipeline`)

- `download.ts`: `gatewayDownloader(gateway)` fetches a finished provider file (a generated take, a stock clip) through
  `transportFor`. A URL on the provider's host is authenticated; any other URL goes out with no credential. Only https is accepted,
  the byte limit is checked before anything is returned, an empty file and a non-2xx answer are errors (429, 408, 425 and 5xx are
  retryable). Tests: `download.test.ts` (6).
- `paid.ts`: `LockableLedger` (a ledger with an optional `withLock`). `paidCall` runs its authorize and reconcile steps through
  `withLock` when the ledger has one, so a Postgres ledger serializes the budget steps of one reservation. The provider call is never
  inside the lock. A ledger without `withLock` behaves as before.
- The boundary tests still hold: no `fetch` outside `transport.ts`, and only `meridian.ts` reads Meridian's credentials.

Built 2026-10-14 by the lead, from the owner's decision that OpenRouter is the go-to platform and that all API handling
lives in one place.

## Done (fixture-tested)

- `createGateway`: routing from `config/routes.ts`, provider registry, API-key, OAuth (refresh once on 401) and no-auth
  strategies, keys only on the provider's own host, not-connected results that send nothing.
- `transport.ts`: the only `fetch` in `src/engine`. The `fetchTransport` exports in `render/hyperframesCloud.ts` and
  `media/wire-client.ts` were removed; both adapters now take a transport from the gateway.
- `openrouter.ts`: `structuredChat` (json_schema response format, zod validation, `StructuredOutputError` naming paths only),
  `submitVideo` and `pollVideo` (mapped to `ProviderPoll`, `usage.cost` as the actual), and `verifyRoutes` (free models
  listing).
- `paid.ts`: `paidCall` over `authorizeCall` and `reconcileCall`. Refused and duplicate calls are never made.
- `meridian.ts`: the connector to Meridian's credential resolver.
- `boundaries.test.ts`: no `fetch` outside the transport; only `meridian.ts` reads Meridian's credentials; model platform
  hosts appear only in `providers.ts`.

## Not done, and why

- **Credentials.** Meridian knows OpenRouter only as a deployment-wide key (`OPENROUTER_SHARED_DEFAULT=deployment`). A
  per-workspace OpenRouter category, and HeyGen and Anthropic categories, need a change to
  `src/lib/meridian/credentials/contract.ts`. Until then HeyGen and Anthropic are not connected. Owner to approve.
- **Model ids.** The Claude OpenRouter ids (`anthropic/claude-opus-5.5`, `-sonnet-5.5`, `-haiku-5.5`) and the Kling id
  (from Bible 10.1) are unverified; every route is `verified: false`. Ids that are not known at all are null, and the
  gateway refuses those capabilities rather than falling back.
- **First and last frames** are not sent to OpenRouter video yet (Bible 20.3 item 2).
- **Prompt caching and Batch API** through OpenRouter are unknown (Bible 20.3 item 6). The Claude client (W3) decides per
  route.
- **Retries and concurrency** stay with the callers (asset router, poller), as in Bible 10.4.

## Owner's live run

With `OPENROUTER_SHARED_DEFAULT=deployment` and `OPENROUTER_API_KEY` set on the deployment:

1. Run `verifyRoutes(gateway, CAPABILITIES)` and set `verified: true` for each listed id; fix the others.
2. One `structuredChat` on `llm.check` with a small schema. Record the generation id, the model and `usage.cost`.
3. One `submitVideo` on `video.cinematic` (5 s, 9:16), poll to done, and record the job id, the video URL and `usage.cost`.
4. Compare both costs with the OpenRouter activity page.
