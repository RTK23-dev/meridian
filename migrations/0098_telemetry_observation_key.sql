-- 0098: one stored row per observation of a creative on a surface (NORTH_STAR section 8, item 9, measurement linkage).
--
-- An observation is one ad-day of a paid creative, or one post-day of an organic post. Its identity is the creative, the surface
-- (unified_performance_telemetry.source_type) and the observation key in metadata (metadata->>'observationKey'), which
-- measurement/creative-linkage.ts writes as `paid:<event>` or `organic:<post>:<day>`. The link used to check for an observation and
-- then insert it, with no unique key, so two writers could store the same ad-day twice.
--
-- A row with no observation key is not keyed: a NULL key does not conflict with another NULL, so those rows are left as they are.
--
-- Existing duplicates are removed first, keeping the earliest stored row (created_at, then id) of each observation. No foreign key in the
-- migrations, and no column in the source, names a telemetry row by its id, so no dependant row is moved.

with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id, brand_id, creative_id, source_type, (metadata->>'observationKey')
           order by created_at asc, id asc
         ) as keep_id
  from unified_performance_telemetry
  where metadata->>'observationKey' is not null
)
delete from unified_performance_telemetry t
using ranked
where t.id = ranked.id and ranked.id <> ranked.keep_id;

create unique index if not exists unified_performance_telemetry_observation_uidx
  on unified_performance_telemetry (organization_id, brand_id, creative_id, source_type, (metadata->>'observationKey'));
