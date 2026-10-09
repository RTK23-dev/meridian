# Database

Migrations are applied in filename order from `migrations/`, including `0016_jev_research.sql`.

## Tenant root

`user` → `memberships` → `organizations` → `brands`.

Every machine table below also stores `organization_id` and `brand_id`. Server functions resolve the brand, check membership, and pass both ids into queries. The ranker and learner throw if a row's brand id does not match.

## Brand knowledge

- `brand_brains`, `brand_brain_versions` — current brain and history
- `brain_suggestions` — pending, accepted, or dismissed model proposals
- `products` — soft-deleted, with allowed and prohibited claims

## Evidence

- `competitors` — confirmed or dismissed. Never seeded
- `source_documents` — public page fetch, stored or failed, excerpt marked untrusted by the application
- `creative_records` — competitor observations and this brand's creatives, with attributes, workflow JSON, optional asset URL, links to opportunity and brief
- Unique `(brand_id, source_identifier)` when the identifier is set, for dedupe
- `research_collection_runs`, `research_ads`, `research_transcript_cache`, `research_analysis_runs`, `research_analysis_fields`, `research_segments`, `research_patterns` — tenant-scoped public ad provenance, verified media references/checksums, content-hash transcript reuse, typed confidence/evidence, and observed cross-ad patterns
- Organization-level research patterns contain aggregate counts only; a brand uses them only when `use_organization_learning` is enabled

## Decisions and production

- `opportunities` — ranked drafts and their evidence JSON
- `briefs` — context pack, why, learning notes, failure notes, workflow
- `jev_decisions` — the gate log described in `JEV.md`
- `reviews` — open, approved, rejected
- `rejections` — reason code, note, actor (`jev` or a user id)
- `generation_jobs`, `model_runs`, `prompt_versions`

## Results & Telemetry

- `experiments` — opened when performance is recorded
- `performance_observations` — manual & synced rows: impressions, clicks, conversions, spend, revenue, date, source
- `organic_observations` — views, 3s views, completion rate, shares, likes, comments
- `unified_performance_telemetry` — (`0024`) multi-channel continuous performance stream with decay weights, hook retention, completion rates, conversions, and metadata
- `learned_patterns` — one row per brand, attribute, value, and metric with Bayesian credible intervals and FDR q-values

## Content Factory & pgvector (`0018`, `0019`)

- `creative_dna` — scene decomposition, OCR text, and 384-dimensional vector embeddings (`vector(384)`) with cosine index
- `factory_runs`, `factory_timeline_compositions`, `factory_variants` — multi-aspect production states and timeline assets

## Multi-Account & Encrypted Vault (`0021`)

- `credential_vault` — AES-256-GCM encrypted tokens, IVs, tags, and key versioning
- `platform_accounts` — connected Instagram, TikTok, YouTube, Meta, and Google accounts with status tracking

## JEV Account Intelligence (`0022`)

- `jev_account_profiles` — rolling 30/60/90-day profiles, decile creative differentiators, brand archetypes
- `jev_content_analyses` — per-post multimodal creative DNA, 6-beat breakdown, objection clusters
- `jev_whitespace_opportunities` — category-level competitor whitespace angles, saturation scores, win probabilities

## Publishing Orchestration (`0023`)

- `publishing_queues` — scheduled multi-account jobs with minute-normalized idempotency keys and exponential backoff
- `publishing_receipts` — immutable execution receipts with verified platform post IDs and URLs

## Production Jobs & Storage Objects (`0028`)

- `production_jobs` — asynchronous rendering jobs with provider URLs, poll timestamps, spec hashes, and retry counters
- `storage_objects` — authoritative Google Drive object repository linking provider file IDs, byte checksums, and mime types

## Budget Ledger & Discovery Frontier (`0031`)

- `budget_accounts` — tenant budget caps, spent micros, and reserved micros in micro-units (`bigint`)
- `budget_reservations` — active, reconciled, or released budget reservations tied to plans and jobs
- `budget_ledger_entries` — double-entry immutable audit trail of all balance changes
- `discovery_frontier` — durable crawl queue with lease worker IDs, heartbeat expiration, and attempt counts

Organization columns `brand_fit` through `risk` are scoring weights, not results.

No migration inserts sample brands, ads, or metrics. Production fails closed without valid credentials.
