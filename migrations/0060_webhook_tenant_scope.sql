-- Webhook deduplication is scoped to the organization that stores the event.
--
-- 0009 made (provider, event_id) unique across every organization, so one tenant's stored
-- event blocked the same provider event for another tenant: the second delivery was reported
-- as already stored and was never queued. The receiver now stores each delivery under exactly
-- one organization (src/lib/meridian/webhooks/receive-store.ts), so uniqueness is per organization.
--
-- Safe on existing rows: the new constraint is implied by the old one. Two rows that share
-- (organization_id, provider, event_id) would also share (provider, event_id), which the old
-- constraint already forbids, so adding it cannot fail on data. Dropping the old constraint
-- only relaxes uniqueness.

alter table webhook_events
  add constraint webhook_events_organization_provider_event_id_key unique (organization_id, provider, event_id);

-- The name is the one Postgres generates for the inline unique in 0009_completion.sql.
alter table webhook_events drop constraint webhook_events_provider_event_id_key;
