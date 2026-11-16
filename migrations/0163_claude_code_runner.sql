-- 0163: the Claude Code runner. A request made in Meridian is now a job in a queue. A runner on the person's own computer takes the
-- oldest open job under a lease, starts a fresh Claude Code session for it with the model the person chose, sends a heartbeat while it
-- works, and reports the end: done (Meridian checks that a video was really saved) or failed with the reason. A runner that stops
-- mid-job loses its lease; the job is queued again, up to a limit, and then marked failed. Nothing here calls a provider.

alter table claude_code_requests add column if not exists model text not null default 'auto';
alter table claude_code_requests add column if not exists attempt integer not null default 0;
alter table claude_code_requests add column if not exists lease_token text;
alter table claude_code_requests add column if not exists lease_expires_at timestamptz;
alter table claude_code_requests add column if not exists runner_name text not null default '';
alter table claude_code_requests add column if not exists session_id text not null default '';
alter table claude_code_requests add column if not exists last_error text not null default '';
alter table claude_code_requests add column if not exists started_at timestamptz;
alter table claude_code_requests add column if not exists finished_at timestamptz;

alter table claude_code_requests drop constraint if exists claude_code_requests_status_check;
alter table claude_code_requests add constraint claude_code_requests_status_check
  check (status in ('open', 'claimed', 'running', 'done', 'failed', 'cancelled'));

create index if not exists claude_code_requests_queue_idx on claude_code_requests (organization_id, status, created_at);

-- One row per runner that has checked in: which computer, when it was last seen, and what its own checks found.
create table if not exists claude_code_runners (
  organization_id text not null references organizations (id) on delete cascade,
  connector_id text not null references mcp_connectors (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  last_seen_at timestamptz not null default now(),
  checks jsonb not null default '{}'::jsonb,
  primary key (organization_id, connector_id, name)
);
