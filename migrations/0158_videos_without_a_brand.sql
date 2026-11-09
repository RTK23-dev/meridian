-- 0158: a video does not have to belong to a brand (owner direction 2026-11-09). A video made without one belongs to the workspace: its
-- files are kept in the workspace's own space and its paid calls draw on the workspace's monthly budget. Files can also be kept without
-- Google Drive: when the workspace has not connected Drive, Meridian keeps the bytes in its own database (storage_blobs).
--
-- 1. storage_objects: brand_id may be null (the workspace's own space). Null counts as one value in the key, so a workspace still has at
--    most one object per name (Postgres 15+, NULLS NOT DISTINCT; Meridian runs on 16).
alter table storage_objects alter column brand_id drop not null;
alter table storage_objects drop constraint if exists storage_objects_organization_id_brand_id_name_key;
alter table storage_objects add constraint storage_objects_organization_id_brand_id_name_key
  unique nulls not distinct (organization_id, brand_id, name);

-- 2. Resumable Drive uploads of a workspace file have no brand either. At most one active upload per key in the workspace's space too.
alter table artifact_upload_sessions alter column brand_id drop not null;
drop index if exists artifact_upload_sessions_one_active;
create unique index if not exists artifact_upload_sessions_one_active
  on artifact_upload_sessions (organization_id, brand_id, storage_key) nulls not distinct where status = 'uploading';

-- 3. The bytes of an object Meridian keeps in its own database (storage_objects.provider = 'database'). One row per object; deleting the
--    object's record deletes its bytes. Drive stays the store when it is connected.
create table if not exists storage_blobs (
  storage_object_id text primary key references storage_objects (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  bytes bytea not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes = octet_length(bytes)),
  created_at timestamptz not null default now()
);

create index if not exists storage_blobs_org_idx on storage_blobs (organization_id);

-- 4. The chat connector's projects and files: a brand is optional. With none, the video is the workspace's.
alter table mcp_projects alter column brand_id drop not null;
alter table mcp_files alter column brand_id drop not null;

-- 5. A decision asked for a video without a brand is recorded with no brand (its request names none). It is in no brand's calibration.
alter table jev_runs alter column brand_id drop not null;
alter table jev_answers alter column brand_id drop not null;
