-- Publish and measure both paths (NORTH_STAR section 8, items 8 and 9).
--
-- Every publish receipt names its surface: `organic` or `paid`. The two receipt tables already exist, so nothing new is created:
-- organic posts are organic_posts rows, and paid objects are provider_objects rows. Neither table carried the surface, so a metric
-- row could not be checked against the kind of receipt it belongs to. The existing rows are read as they were: every organic_posts
-- row is an organic post, and every provider_objects row is a paid object, because no organic path wrote one.
--
-- The surface is the metric row's surface too (unified_performance_telemetry.source_type), so a paid metric cannot be linked to an
-- organic receipt, and the reverse, without the mismatch being visible in the row.

alter table organic_posts
  add column if not exists surface text not null default 'organic' check (surface in ('organic', 'paid'));

alter table provider_objects
  add column if not exists surface text not null default 'paid' check (surface in ('organic', 'paid'));

-- A creative's receipts are looked up by its id in the idempotency key, in every tenant that holds it.
create index if not exists provider_objects_creative_idx
  on provider_objects (organization_id, brand_id, idempotency_key);
