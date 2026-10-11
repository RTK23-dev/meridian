-- 0058: A workspace's Google Drive connection, and resumable upload sessions sealed at rest.
--
-- A workspace connects Google Drive from the settings screen (admin only). The grant is the drive.file scope, so Meridian
-- sees the files it creates and not the rest of the account's Drive. The refresh token is stored encrypted in
-- credential_vault under the type storage:google_drive, one row per workspace. Access tokens are minted in memory and are
-- never written.
--
-- drive_oauth_states holds each connection attempt as a hash. A state is single use, expires, and is bound to the person who
-- started it, so a callback from another person's session is refused.

create table if not exists drive_oauth_states (
  state_hash text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  user_id text not null references "user" (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists drive_oauth_states_expiry on drive_oauth_states (expires_at);

-- One Drive connection per workspace. The resolver reads a single row, so a second row would make the choice arbitrary.
create unique index if not exists credential_vault_one_drive_connection
  on credential_vault (organization_id, credential_type)
  where credential_type = 'storage:google_drive';

-- A resumable session URI is a capability to write into one Drive upload. From this migration it is stored sealed with
-- TOKEN_ENCRYPTION_KEY (see storage/session-seal.ts). A raw URI recorded before this change cannot be opened, so it is
-- removed here. A session that was still uploading is marked failed, and the next attempt starts a new Drive upload.
update artifact_upload_sessions
set session_uri = '',
    status = case when status = 'uploading' then 'failed' else status end,
    last_error = case
      when status = 'uploading' then 'The session was recorded before session URIs were sealed, so this upload cannot resume. The next attempt starts a new upload.'
      else last_error
    end,
    updated_at = now()
where session_uri like 'https://%';
