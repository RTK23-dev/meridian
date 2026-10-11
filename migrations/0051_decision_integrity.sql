-- Migration 0051: one saved provider credential per workspace and type, and an append-only record of each explicit
-- opportunity-direction decision.

-- The credential resolver reads a single row for each provider_config type. Two rows would make the choice of key
-- arbitrary. Older duplicates are removed first, keeping the most recently updated row. Other vault types, such as
-- platform account tokens, may legitimately repeat, so the rule covers provider_config entries only.
delete from credential_vault a
using credential_vault b
where a.organization_id = b.organization_id
  and a.credential_type = b.credential_type
  and a.credential_type like 'provider_config:%'
  and (a.updated_at < b.updated_at or (a.updated_at = b.updated_at and a.id < b.id));

create unique index if not exists credential_vault_one_provider_config
  on credential_vault (organization_id, credential_type)
  where credential_type like 'provider_config:%';

-- Selecting an opportunity's direction is a decision in its own right. It records who decided, when, what, and why. It
-- does not imply that any brief written from the direction passed its engine gate.
create table if not exists opportunity_direction_decisions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  opportunity_id text not null references opportunities (id) on delete cascade,
  actor_id text not null,
  actor_role text not null,
  action text not null check (action in ('approve', 'decline')),
  reason text not null check (length(btrim(reason)) >= 20),
  created_at timestamptz not null default now()
);

create index if not exists opportunity_direction_decisions_opportunity_idx
  on opportunity_direction_decisions (organization_id, opportunity_id, created_at);

create or replace function opportunity_direction_decisions_append_only() returns trigger as $$
begin
  raise exception 'opportunity_direction_decisions is append-only';
end;
$$ language plpgsql;

drop trigger if exists opportunity_direction_decisions_no_update_delete on opportunity_direction_decisions;
create trigger opportunity_direction_decisions_no_update_delete
  before update or delete on opportunity_direction_decisions
  for each row execute function opportunity_direction_decisions_append_only();
