-- Invitation tokens are stored as hashes. The raw token is only in the email.

alter table invites add column if not exists token_hash text not null default '';
alter table invites add column if not exists expires_at timestamptz;
alter table invites add column if not exists sent_at timestamptz;
alter table invites add column if not exists send_count integer not null default 0;
alter table invites add column if not exists last_error text not null default '';

alter table invites drop constraint if exists invites_status_check;
alter table invites add constraint invites_status_check
  check (status in ('recorded', 'pending', 'sent', 'accepted', 'expired'));

create unique index if not exists invites_token_hash_idx on invites (token_hash) where token_hash <> '';
