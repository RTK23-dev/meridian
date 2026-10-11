-- One record per gate decision. A gate is a production decision point: research claim safety, creative image QA, and
-- any other question set routed through decisions/gate.ts. The record names exactly what was decided, by which engine,
-- against which question and policy versions, with which evidence, and what action followed. Engine answers are also
-- in jev_runs and jev_answers, linked by run_id.
create table if not exists decision_gate_records (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  gate text not null,
  subject_type text not null,
  subject_id text not null,
  engine_called boolean not null default false,
  engine_id text check (engine_id is null or engine_id in ('jev', 'openai-decisions')),
  adapter_version text,
  requested_model text,
  returned_model text,
  run_id text,
  policy_version text not null,
  question_versions jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  votes jsonb not null default '[]'::jsonb,
  unresolved jsonb not null default '[]'::jsonb,
  deterministic_rejections jsonb not null default '[]'::jsonb,
  action text not null check (action in ('AUTO_APPROVE', 'HUMAN_REVIEW', 'REJECT')),
  reason text not null,
  latency_ms integer,
  usage jsonb,
  failure_kind text,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_decision_gate_records_subject
  on decision_gate_records (organization_id, subject_type, subject_id, created_at desc);
