-- Migration 0021: Database-Backed Encrypted Credential Vault & Multi-Account Platform Management
-- Enables multi-account management across Instagram, YouTube, TikTok, Meta Ads, and Google Ads without relying on host environment variables.

create table if not exists credential_vault (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  credential_type text not null, -- 'oauth_token', 'api_key', 'service_account', 'webhook_secret'
  ciphertext text not null,
  iv text not null,
  tag text not null,
  key_version integer not null default 1,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_credential_vault_org on credential_vault (organization_id, credential_type);

create table if not exists platform_accounts (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  platform text not null, -- 'instagram', 'facebook', 'youtube', 'tiktok', 'meta_ads', 'google_ads'
  account_type text not null default 'social_page', -- 'social_page', 'ad_account', 'channel', 'creator_profile'
  external_account_id text not null,
  name text not null,
  handle text not null default '',
  avatar_url text not null default '',
  credential_id text references credential_vault (id) on delete set null,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'expired', 'invalid_permissions')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, brand_id, platform, external_account_id)
);

create index if not exists idx_platform_accounts_brand on platform_accounts (organization_id, brand_id, platform);
create index if not exists idx_platform_accounts_cred on platform_accounts (credential_id);
