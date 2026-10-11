-- A platform that does not report a metric stores it as unknown, not zero. Zero would read as a real measurement in
-- learning and creator snapshots. Existing rows keep their values; only the constraint and the default change.
alter table organic_observations
  alter column views drop not null,
  alter column views drop default,
  alter column three_second_views drop not null,
  alter column three_second_views drop default,
  alter column completion_rate drop not null,
  alter column completion_rate drop default,
  alter column likes drop not null,
  alter column likes drop default,
  alter column comments drop not null,
  alter column comments drop default,
  alter column shares drop not null,
  alter column shares drop default,
  alter column saves drop not null,
  alter column saves drop default;
