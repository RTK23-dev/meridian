-- An alert webhook attempt is recorded as 'sending' before the request, so a crash or a timeout leaves a trace. The answer settles it:
-- 'sent' (2xx), 'failed' (4xx: the endpoint did not take it, and a later attempt may try again) or 'uncertain' (no answer, or 5xx: the
-- endpoint may have received it). An uncertain attempt is not sent again until a person has checked the receiving system. The attempt id
-- is "<alert id>:<attempt>", and the webhook receives the same value as its Idempotency-Key. Earlier rows hold only 'sent' and 'failed'.

alter table delivery_attempts drop constraint if exists delivery_attempts_status_check;
alter table delivery_attempts add constraint delivery_attempts_status_check
  check (status in ('sending', 'sent', 'failed', 'uncertain'));
