-- Chain call records (Video Engine Bible 7.1 chains, contract v5; Bible 5.1 retries). One row per call of a chain, keyed by the request,
-- the shot, the produce job's attempt and the call's output name.
--
-- A call is recorded before it is made (its spec, so a retry makes the same call with the same input hash and the same key), and again
-- when it makes its output (the uri the next call reads, its provider, its bill and its ledger entry). A retry of the produce job reads
-- the output and makes no second call. Organization-scoped like every engine table.
--
-- Why a table and not an engine_artifacts row: engine_artifacts.type is checked against the artifact types the contracts name (v1), and
-- no type holds a chain output. Adding one is a contract change for the lead to approve. Until then this table is the store.

create table if not exists engine_chain_calls (
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  shot_id text not null,
  attempt integer not null check (attempt >= 1),
  output_name text not null check (output_name ~ '^[a-z][a-z0-9_]{0,39}$'),
  call_index integer not null check (call_index >= 0),
  spec text not null,
  output text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, request_id, shot_id, attempt, output_name)
);

create index if not exists engine_chain_calls_request_idx on engine_chain_calls (organization_id, request_id);
