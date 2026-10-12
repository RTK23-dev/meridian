-- A metric a source does not report is unknown, not zero. Zero reads as a real measurement in learning and in the creator
-- snapshots. The paid rows follow the organic rows (0062). Existing rows keep their values; only the constraints and the
-- defaults change.
alter table performance_observations
  alter column impressions drop not null,
  alter column clicks drop not null,
  alter column conversions drop not null,
  alter column spend_cents drop not null,
  alter column reach drop not null,
  alter column reach drop default;

alter table organic_observations
  alter column reach drop not null,
  alter column reach drop default,
  alter column average_watch_time_seconds drop not null,
  alter column average_watch_time_seconds drop default;
