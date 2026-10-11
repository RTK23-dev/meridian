-- The origin an OAuth attempt started from is stored with its state. The token exchange then uses that same redirect URI,
-- and a callback from any other origin cannot consume the state. Rows created before this migration have no origin and
-- cannot be claimed, so their users start the connection again.
alter table oauth_states add column if not exists redirect_origin text;
