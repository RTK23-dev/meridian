-- 0160: a request to make a video from Claude Code. One click in Meridian records what the video is for and where its idea comes from
-- (the data Meridian already gathered, the Content Factory's latest plan, or the person's own words) as a snapshot, and gives back one
-- short line to paste into Claude Code. Claude Code reads the request through the connector, makes the video on its own machine, and
-- links the project it creates. A request holds data only: it starts nothing, spends nothing and expires.

create table if not exists claude_code_requests (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text,
  created_by text not null,
  source text not null check (source in ('gathered', 'factory', 'idea')),
  idea text not null check (char_length(idea) between 3 and 2000),
  snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'claimed', 'done', 'cancelled')),
  project_id text references mcp_projects (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint claude_code_requests_brand_fkey foreign key (organization_id, brand_id) references brands (organization_id, id) on delete cascade
);

create index if not exists claude_code_requests_org_idx on claude_code_requests (organization_id, created_at desc);
