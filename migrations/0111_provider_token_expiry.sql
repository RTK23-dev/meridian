-- Provider access tokens record when they expire (review 2026-10-22, item 6). A token the provider did not state an expiry for keeps null, and
-- such a token is not treated as expired. Numbered after 0110.
alter table provider_secrets add column if not exists expires_at timestamptz;
