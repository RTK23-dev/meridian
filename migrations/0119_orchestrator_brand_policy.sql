-- A brand's policy may only switch model families off (owner direction 2026-10-23, decision D16). Numbered after 0118. Additive only.
--
-- 1. orchestrator_brand_policies keeps, for each brand of a workspace, the model families the brand switches off. The effective set of a plan
--    is the workspace's disabled families plus the brand's (brand-policy.ts), so a brand cannot switch on a family the workspace has switched
--    off. One row per brand, keyed by the organization too.
-- 2. A plan records its brand. The column is nullable: a plan with no brand uses the workspace set alone, and no stored plan changes.

create table if not exists orchestrator_brand_policies (
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null check (length(brand_id) between 1 and 200),
  disabled_model_families jsonb not null default '[]'::jsonb check (jsonb_typeof(disabled_model_families) = 'array'),
  updated_by text not null check (length(updated_by) between 1 and 200),
  updated_at timestamptz not null default now(),
  primary key (organization_id, brand_id)
);

alter table orchestrator_plans
  add column if not exists brand_id text check (brand_id is null or length(brand_id) between 1 and 200);

create index if not exists orchestrator_plans_org_brand on orchestrator_plans (organization_id, brand_id);
