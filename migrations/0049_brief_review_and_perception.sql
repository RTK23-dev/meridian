-- A brief the engine could not judge waits for an explicit review. Creation never approves it.
alter table briefs drop constraint if exists briefs_status_check;
alter table briefs add constraint briefs_status_check
  check (status in ('ready', 'rejected', 'used', 'awaiting_review'));

-- Append-only record of every human review of a decision: who, when, what they decided, why, and the original engine
-- outcome they were shown. Rows are never updated or deleted.
create table if not exists decision_reviews (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  decision_id text not null references jev_decisions (id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  reviewer_id text not null,
  reviewer_role text not null,
  reviewer_is_creator boolean not null,
  action text not null check (action in ('approve', 'reject')),
  reason text not null check (length(trim(reason)) > 0),
  original_action text not null check (original_action in ('AUTO_APPROVE', 'HUMAN_REVIEW', 'REJECT')),
  original_outcome jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_decision_reviews_decision on decision_reviews (decision_id, created_at desc);

create or replace function decision_reviews_append_only() returns trigger as $$
begin
  raise exception 'decision_reviews is append-only';
end;
$$ language plpgsql;

drop trigger if exists decision_reviews_no_update_delete on decision_reviews;
create trigger decision_reviews_no_update_delete
  before update or delete on decision_reviews
  for each row execute function decision_reviews_append_only();

-- One row per perception run: which media was analysed, its real timestamps and hashes, the perception model and prompt
-- version, what it observed, and how much of the subject it covered. A reused run is not written twice.
create table if not exists perception_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  request_key text not null,
  status text not null check (status in ('observed', 'failed')),
  failure_kind text,
  failure_message text,
  media jsonb not null default '[]'::jsonb,
  observations jsonb not null default '[]'::jsonb,
  coverage jsonb not null default '{}'::jsonb,
  latency_ms integer,
  usage jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_perception_runs_key on perception_runs (organization_id, request_key, status);
