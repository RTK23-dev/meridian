-- The transport JEV decisions use for one workspace (src/lib/meridian/decisions/jev-engine.ts).
--
-- JEV is Meridian's semantic decision layer. This setting chooses only the backend that answers it:
--   typesafe_direct  TypeSafe System One, with the workspace's TypeSafe key (the default when no row exists)
--   openrouter       OpenRouter's Decisions API, with the workspace's OpenRouter key and its selected decision model
--
-- Switching requires the chosen backend to report READY (the server enforces it). An unreadable row fails closed: JEV does not
-- fall back to another backend. The OpenRouter model stays in decision_engine_openrouter_config (migration 0132), so this table
-- records the backend only.

create table if not exists decision_engine_jev_config (
  organization_id text primary key references organizations (id) on delete cascade,
  backend text not null check (backend in ('typesafe_direct', 'openrouter')),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
