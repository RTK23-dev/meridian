-- 0023: Multi-Account Social Publishing & Orchestrated Scheduling
-- Adds tables for orchestrated multi-account publishing queues, rate limiting,
-- idempotency tracking, and immutable publishing receipts.

-- Publishing Queue: Staged and scheduled items per target social account
create table if not exists publishing_queues (
  id                 text primary key,
  organization_id    text not null,
  brand_id           text not null,
  creative_id        text not null,
  target_account_id  text not null,
  platform           text not null,
  target_type        text not null default 'organic', -- 'organic' or 'paid_campaign'
  scheduled_time     timestamptz not null default now(),
  status             text not null default 'queued',  -- 'queued', 'processing', 'published', 'failed', 'cancelled'
  idempotency_key    text not null,
  attempts           integer not null default 0,
  max_attempts       integer not null default 3,
  next_retry_at      timestamptz,
  receipt_id         text,
  error              text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists idx_publishing_queues_idempotency
  on publishing_queues (organization_id, brand_id, idempotency_key);

create index if not exists idx_publishing_queues_worker
  on publishing_queues (status, scheduled_time)
  where status in ('queued', 'failed');

create index if not exists idx_publishing_queues_account
  on publishing_queues (target_account_id, created_at desc);

create index if not exists idx_publishing_queues_tenant
  on publishing_queues (organization_id, brand_id, status);

-- Publishing Receipts: Immutable proof of live execution on the external platform
create table if not exists publishing_receipts (
  id                 text primary key,
  organization_id    text not null,
  brand_id           text not null,
  queue_id           text,
  platform           text not null,
  account_id         text not null,
  external_post_id   text not null default '',
  external_url       text not null default '',
  status             text not null default 'live',
  published_at       timestamptz not null default now(),
  raw_response       jsonb not null default '{}'
);

create index if not exists idx_publishing_receipts_tenant
  on publishing_receipts (organization_id, brand_id, published_at desc);

create index if not exists idx_publishing_receipts_queue
  on publishing_receipts (queue_id);
