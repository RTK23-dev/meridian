-- 0157: video projects for the chat connector (owner direction 2026-11-09). A chat (Claude or ChatGPT) that receives the connector link
-- first runs a short intake Q&A, then makes the video as a project: concept, script, storyboard, assets, build, render, deliver. The
-- project keeps the person's answers, how involved they chose to be (studio: they choose at every checkpoint; guided: the script and the
-- final cut; orchestrator: hands-off), every checkpoint with the options shown and what was chosen and by whom, and an optional budget for
-- this one video on top of the brand budget. Meridian enforces the order and who decides; the chat cannot skip a person's checkpoint.

create table if not exists mcp_projects (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null,
  connector_id text not null references mcp_connectors (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  mode text not null check (mode in ('studio', 'guided', 'orchestrator')),
  brief jsonb not null default '{}'::jsonb,
  checkpoints jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'delivered', 'abandoned')),
  budget_usd numeric check (budget_usd is null or budget_usd >= 0),
  spent_usd numeric not null default 0 check (spent_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_projects_brand_fkey foreign key (organization_id, brand_id) references brands (organization_id, id) on delete cascade
);

create index if not exists mcp_projects_org_idx on mcp_projects (organization_id, updated_at desc);

alter table mcp_files add column if not exists project_id text references mcp_projects (id) on delete set null;
