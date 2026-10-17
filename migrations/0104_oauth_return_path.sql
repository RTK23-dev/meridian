-- Where to send the person after the workspace OAuth login is stored.
-- Only a path this app checked is written. Older rows have none and return to Integrations.

alter table oauth_states add column if not exists return_path text;
