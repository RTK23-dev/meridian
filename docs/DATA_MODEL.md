# Data model

The current schema is documented in [DATABASE.md](DATABASE.md). This file only keeps the tenant rule:

`user` → `memberships` → `organizations` → `brands` → everything else that brand owns.

A query for brand data starts from the brand’s organization and requires a membership for the session user.
