-- The person who starts an OAuth connection is stored on its state, so the callback accepts it only from that person.
-- A state begun before this migration has no user, so it cannot be claimed; the person starts the connection again.
alter table oauth_states add column if not exists user_id text references "user" (id) on delete cascade;
