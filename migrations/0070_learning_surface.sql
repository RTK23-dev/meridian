-- Learning per surface (NORTH_STAR section 8, item 10).
--
-- A learned pattern belongs to one surface: `organic` (organic_observations, and the organic metrics of unified telemetry) or `paid`
-- (performance_observations, and the paid metrics of unified telemetry). It may also belong to one channel (a platform, such as
-- tiktok), or to every channel of its surface when the channel is ''. Pick reads a pattern only for the surface, and the channel, of
-- the run that asks, so a pattern learned on one surface is never applied to another.
--
-- The surface of each existing row is read from its metric, which already names the surface: ctr, cvr and roas are paid, and
-- retention_3s, completion_rate and shares are organic. Rows whose metric names neither stay `unassigned`. Those rows are replaced the
-- next time the brand's patterns are recomputed, and Pick never reads them. Every existing row covers every channel, so its channel is ''.

alter table learned_patterns
  add column if not exists surface text not null default 'unassigned'
    check (surface in ('organic', 'paid', 'unassigned'));

alter table learned_patterns
  add column if not exists channel text not null default '';

update learned_patterns set surface = 'paid'
  where surface = 'unassigned' and metric in ('ctr', 'cvr', 'roas');

update learned_patterns set surface = 'organic'
  where surface = 'unassigned' and metric in ('retention_3s', 'completion_rate', 'shares');

drop index if exists learned_patterns_scope_identity;

create unique index if not exists learned_patterns_surface_identity
  on learned_patterns (brand_id, surface, channel, attribute, value, metric, scope);
