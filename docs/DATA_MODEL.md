# Data model

Schema: `migrations/0001_auth.sql` (sessions) and `migrations/0002_meridian.sql`.

## Tenant hierarchy

`user` → `memberships` → `organizations` → `brands` → `brand_brains` / `products`.

A user may belong to several organizations. A brand belongs to one organization. Queries for brand data start from the brand’s organization and require a membership for the session user.

## Brand Brain

`brand_brains` holds the current audience, positioning, voice, advertising preferences, compliance notes, and automation preference.

`provenance` is JSON. Allowed values: `user_defined`, `ai_inferred`, `imported`, `learned_from_performance`, `learned_from_review`. This version only writes `user_defined`, and only on fields a person changed.

`brand_brain_versions` stores a snapshot each time the brain is saved. User edits do not overwrite history.

## Other records

- `products` — soft-deleted.
- `brands` — soft-deleted.
- `invites` — `recorded` means stored, not delivered.
- `audit_log` — actor, action, object, metadata.
- Organization columns `brand_fit` through `risk` — scoring weights, not results.

Automation level is a preference. No job runner reads it yet.
