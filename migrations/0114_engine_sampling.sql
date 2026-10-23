-- Sampling after delivery (Video Engine Bible 6.14, 12.5). One row per workspace and format: the passes a person has accepted in a row
-- for sampled videos of that format, the threshold version the format last saw, and the end of a reset week. A delivered video that is
-- sampled becomes a review item of kind 'sample'; the item's decision moves this count.
create table if not exists engine_sampling_state (
  organization_id text not null references organizations (id) on delete cascade,
  format_key text not null,
  consecutive_passes integer not null default 0 check (consecutive_passes >= 0),
  threshold_version text,
  reset_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, format_key)
);
