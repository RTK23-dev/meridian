-- A workspace's monthly video budget, in US dollars. Null means no budget is set: there is no default, and the video
-- engine reads null as "no budget", never as zero or as unlimited. It is stored with two decimals and is never negative.
-- It lives on organizations, next to the scoring weights, because it is one value per workspace.
alter table organizations add column if not exists monthly_video_budget_usd numeric(12, 2);
alter table organizations drop constraint if exists organizations_monthly_video_budget_usd_check;
alter table organizations add constraint organizations_monthly_video_budget_usd_check
  check (monthly_video_budget_usd is null or monthly_video_budget_usd >= 0);
