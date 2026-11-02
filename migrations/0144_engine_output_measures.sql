-- The measures of each request's published output (round 3, K28, decision Q41), written after its post-render review and read by the
-- cookbook results and their export. One row per request and organization. Each measure is a number or null (unknown): nothing is stored as 0
-- for an unknown value. The rows go with their request.

create table if not exists engine_output_measures (
  organization_id text not null,
  request_id text not null,
  measures jsonb not null check (jsonb_typeof(measures) = 'object'),
  recorded_at text not null,
  primary key (organization_id, request_id),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);
