-- Shared auth and generation limits. One row per bucket and window, so every
-- process that uses DATABASE_URL counts the same hits. A single web process
-- with no DATABASE_URL keeps the in-memory limiter.

create table if not exists rate_limit_windows (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  primary key (bucket, window_start)
);

create index if not exists rate_limit_windows_start_idx on rate_limit_windows (window_start);
