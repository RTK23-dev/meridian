-- An invitation email is recorded as 'sending' before the provider is called, so a crash or a timeout leaves a trace, and as 'uncertain'
-- when the provider's answer was lost (timeout, network error, 5xx): the email may have been sent. send_count is the attempt number,
-- and the provider receives "<invite id>:<attempt>" as its idempotency key.

alter table invites drop constraint if exists invites_status_check;
alter table invites add constraint invites_status_check
  check (status in ('recorded', 'pending', 'sending', 'uncertain', 'sent', 'accepted', 'expired'));
