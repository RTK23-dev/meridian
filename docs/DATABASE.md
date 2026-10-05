# Database

Migrations: `migrations/0001_auth.sql`, `migrations/0002_meridian.sql`, `migrations/0003_machine.sql`.

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

## Decisions and production

- `opportunities` — ranked drafts and their evidence JSON
- `briefs` — context pack, why, learning notes, failure notes, workflow
- `jev_decisions` — the gate log described in `JEV.md`
- `reviews` — open, approved, rejected
- `rejections` — reason code, note, actor (`jev` or a user id)
- `generation_jobs`, `model_runs`, `prompt_versions`

## Results

- `experiments` — opened when performance is recorded
- `performance_observations` — manual rows: impressions, clicks, conversions, spend, revenue, date, source
- `learned_patterns` — one row per brand, attribute, value, and metric

Organization columns `brand_fit` through `risk` are scoring weights, not results.

No migration inserts sample brands, ads, or metrics.
