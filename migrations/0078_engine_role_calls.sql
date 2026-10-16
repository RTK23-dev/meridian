-- Persisted Claude role calls (Video Engine Bible 11 and 14.1, workstreams W2 and W3). Numbered after 0077.
--
-- One row per paid role call that reached the budget, keyed by the call's idempotency key within its request. A row is
-- written in steps: pending when the call is authorized and before the gateway is asked; answered or invalid_answer once the
-- answer is in; or refused when the reservation did not cover the call (no ledger row, no money). A row never moves back to
-- pending or refused once it holds an answer.
--
-- Why it exists: before this table, a billed call whose answer was not kept could not be resumed. A resumed job now reads
-- its stored answer (answered), sends only the retry when the first answer was invalid (invalid_answer), and reads every
-- RoleCall for the manifest. A pending row with no answer means the call was started and its answer was not kept.
--
-- Tenancy: organization_id on every row, and composite foreign keys to the request and the reservation of the same workspace.
-- The stored answer is model output: it is data, read back only through the role's answer contract (Bible 1, untrusted outputs).

create table if not exists engine_role_calls (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  reservation_id text not null,
  seq bigint generated always as identity,
  stage text not null,
  role text not null,
  prompt_version text not null,
  model text not null,
  idempotency_key text not null,
  retry_of_key text,
  status text not null check (status in ('pending', 'answered', 'invalid_answer', 'refused')),
  ledger_entry_id text,
  answer text,
  answered_by text,
  generation_id text,
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  cost_usd numeric(14, 4) check (cost_usd is null or cost_usd >= 0),
  actual_is_estimate boolean not null default false,
  issues text not null default '[]',
  refused_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engine_role_calls_org_id_key unique (organization_id, id),
  constraint engine_role_calls_call_key unique (organization_id, request_id, idempotency_key),
  constraint engine_role_calls_answer_check check (status <> 'answered' or answer is not null),
  constraint engine_role_calls_ledger_check check (status not in ('answered', 'invalid_answer') or ledger_entry_id is not null),
  constraint engine_role_calls_refusal_check check (status <> 'refused' or refused_reason is not null),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade,
  foreign key (organization_id, reservation_id) references engine_reservations (organization_id, id) on delete cascade
);

create index if not exists engine_role_calls_request_idx on engine_role_calls (organization_id, request_id, seq);
