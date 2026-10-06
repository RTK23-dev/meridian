create table if not exists notification_preferences (
  organization_id text not null references organizations (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  kind text not null check (kind in ('learning.update', 'performance.recorded', 'review.required', 'integration.unavailable')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, kind)
);
