-- 0027: Unified Schema Reconciliation
-- Reconciles model_parameters, nullable JEV confidence and abstentions,
-- nullable telemetry and creator metrics, and storage_objects unique key.

-- 1. Storage Objects unique logical key
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'storage_objects_org_brand_name_key'
  ) then
    alter table storage_objects
      add constraint storage_objects_org_brand_name_key unique (organization_id, brand_id, name);
  end if;
exception
  when others then null;
end $$;

-- 2. JEV Answers nullable answer and confidence
alter table jev_answers
  alter column answer drop not null,
  alter column confidence drop not null,
  alter column confidence drop default;

-- 3. Telemetry nullable metrology
alter table unified_performance_telemetry
  alter column views drop not null,
  alter column views drop default,
  alter column impressions drop not null,
  alter column impressions drop default,
  alter column reach drop not null,
  alter column reach drop default,
  alter column clicks drop not null,
  alter column clicks drop default,
  alter column engagements drop not null,
  alter column engagements drop default,
  alter column shares drop not null,
  alter column shares drop default,
  alter column saves drop not null,
  alter column saves drop default,
  alter column conversions drop not null,
  alter column conversions drop default,
  alter column spend_cents drop not null,
  alter column spend_cents drop default,
  alter column revenue_cents drop not null,
  alter column revenue_cents drop default,
  alter column watch_time_seconds drop not null,
  alter column watch_time_seconds drop default,
  alter column hook_retention_3s drop not null,
  alter column hook_retention_3s drop default,
  alter column completion_rate drop not null,
  alter column completion_rate drop default;

-- 4. Creator nullable metrology
alter table creators
  alter column followers_count drop not null,
  alter column followers_count drop default,
  alter column following_count drop not null,
  alter column following_count drop default,
  alter column posts_count drop not null,
  alter column posts_count drop default,
  alter column median_views drop not null,
  alter column median_views drop default,
  alter column average_views drop not null,
  alter column average_views drop default,
  alter column outlier_rate drop not null,
  alter column outlier_rate drop default;
