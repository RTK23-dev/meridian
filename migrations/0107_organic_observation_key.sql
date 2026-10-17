-- One organic measurement is one observation. The key lives in its own column so two syncs cannot insert it twice.
-- A row written before this column stays null until it is adopted. Nulls are not unique, so unkeyed history is left as it is.

alter table organic_observations add column if not exists observation_key text;

update organic_observations
set observation_key = raw_metrics->>'observationKey'
where coalesce(observation_key, '') = ''
  and coalesce(raw_metrics->>'observationKey', '') <> '';

-- Keep the earliest row when a race already stored the same key twice.
delete from organic_observations later
where later.observation_key is not null
  and later.observation_key <> ''
  and exists (
    select 1 from organic_observations earlier
    where earlier.organization_id = later.organization_id
      and earlier.brand_id = later.brand_id
      and earlier.organic_post_id = later.organic_post_id
      and earlier.observation_key = later.observation_key
      and (
        earlier.created_at < later.created_at
        or (earlier.created_at = later.created_at and earlier.id < later.id)
      )
  );

create unique index if not exists organic_observations_observation_key_uidx
  on organic_observations (organization_id, brand_id, organic_post_id, observation_key);
