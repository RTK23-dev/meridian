-- Whether an ad is still running is known only when the source reported a stop time. Until now every timeline was written as
-- still running, which is a default, not a measurement. Null now means the survival is unknown. Every existing value came from
-- that default, so they are cleared, and the next grade run writes each one from the source's stop time.
alter table ad_timelines
  alter column still_running drop not null,
  alter column still_running drop default;

update ad_timelines set still_running = null;
