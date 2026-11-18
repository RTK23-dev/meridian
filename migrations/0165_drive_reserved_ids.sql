-- The Drive file id reserved for a small-file write, recorded BEFORE the create call. Every writer of the same file (workspace, scope,
-- storage key and bytes) creates under this one id, and Drive refuses a second create with a taken id (409). So two concurrent writers,
-- or a retry after a lost response, leave one file in Drive; a 409 counts as success only once the file and its sha256 are read back.

create table if not exists drive_reserved_ids (
  organization_id text not null references organizations (id) on delete cascade,
  scope text not null,
  storage_key_hash text not null,
  sha256 text not null,
  file_id text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, scope, storage_key_hash, sha256)
);
