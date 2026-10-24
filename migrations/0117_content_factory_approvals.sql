-- The approval of a delivered video (prompt 16). A person approves or rejects the video the engine delivered. Each decision names the engine
-- request it was made on, so a revision (a new request) starts with no decision and the earlier decisions stay in the history. Rows are
-- written once and never updated or deleted by the application.
create table if not exists content_factory_approvals (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  session_id text not null references content_factory_sessions (id) on delete cascade,
  engine_request_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  reason text not null default '',
  actor_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists content_factory_approvals_session_idx
  on content_factory_approvals (organization_id, session_id, created_at);
