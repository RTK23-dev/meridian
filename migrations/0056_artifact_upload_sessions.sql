-- 0055: Artifact upload sessions. A resumable upload of artifact bytes to Google Drive is recorded here, so it survives a
-- process restart: the session URI, the offset Drive has confirmed, the attempt count and the outcome. Postgres is the
-- system of record. Drive holds the bytes only. The Drive access token is never written to this table. Every read and
-- write is scoped by organization_id and brand_id.
--
-- At most one upload is active per storage key in a brand, so a retry resumes the session instead of starting a second
-- Drive object. A failed session stays in the table as failed and visible; the next attempt starts a new row.
create table if not exists artifact_upload_sessions (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  provider text not null default 'google_drive' check (provider = 'google_drive'),
  storage_key text not null,
  mime_type text not null,
  total_bytes bigint not null check (total_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Empty until Drive accepts the session start. The URI identifies one Drive upload session.
  session_uri text not null default '',
  confirmed_offset bigint not null default 0 check (confirmed_offset >= 0 and confirmed_offset <= total_bytes),
  status text not null default 'uploading' check (status in ('uploading', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  provider_file_id text,
  storage_object_id text references storage_objects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'completed' or (confirmed_offset = total_bytes and provider_file_id is not null))
);

create unique index if not exists artifact_upload_sessions_one_active
  on artifact_upload_sessions (organization_id, brand_id, storage_key) where status = 'uploading';

create index if not exists artifact_upload_sessions_tenant
  on artifact_upload_sessions (organization_id, brand_id, status, updated_at);
