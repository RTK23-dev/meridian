-- 0156: Meridian's MCP connector (owner direction 2026-11-09). A Claude chat (claude.ai, Settings, Connectors, custom connector) reaches
-- one workspace through a secret connector link. Claude writes the scripts and the coded video itself; Meridian answers only what a chat
-- cannot do: voice, images, decisions and storage, each under the workspace's own limits.
--
-- mcp_connectors: one link per row. Only the SHA-256 of the secret is kept, and its last four characters to tell links apart. A link acts
-- as the person who made it, with that person's role in the workspace read at every call, so a member who leaves takes their links' access
-- with them. A revoked link answers nothing.
--
-- mcp_files: what a connector made (a voiceover, an image) or was given (a finished video): stored through Meridian's storage layer under
-- the brand, with the cost the provider reported, or null when it reported none.

create table if not exists mcp_connectors (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  created_by text not null,
  name text not null check (char_length(name) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text not null check (char_length(token_hint) = 4),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text
);

create index if not exists mcp_connectors_org_idx on mcp_connectors (organization_id, created_at desc);

create table if not exists mcp_files (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null,
  connector_id text not null references mcp_connectors (id) on delete cascade,
  kind text not null check (kind in ('voiceover', 'image', 'video')),
  storage_key text not null,
  storage_object_id text,
  media_type text not null,
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  details jsonb not null default '{}'::jsonb,
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  created_at timestamptz not null default now(),
  constraint mcp_files_brand_fkey foreign key (organization_id, brand_id) references brands (organization_id, id) on delete cascade
);

create index if not exists mcp_files_org_idx on mcp_files (organization_id, created_at desc);
