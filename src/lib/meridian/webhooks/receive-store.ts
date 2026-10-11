import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";

/**
 * Stores one delivery under one organization. Uniqueness is per organization (migration 0060), so the same provider
 * event id can be stored once for each tenant. Returns false when this organization already has the event, which also
 * covers a concurrent duplicate that lost the insert race.
 */
export async function storeWebhookEvent(sql: Sql, input: { organizationId: string; provider: string; eventId: string }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    insert into webhook_events (id, organization_id, provider, event_id)
    values (${randomUUID()}, ${input.organizationId}, ${input.provider}, ${input.eventId})
    on conflict (organization_id, provider, event_id) do nothing
    returning id
  `;
  return Boolean(rows[0]);
}

/**
 * The event ids this organization has already stored for the provider that match `eventId`. Scoped to the organization,
 * so another tenant's copy of the same event does not count as a duplicate.
 */
export async function findStoredWebhookEventIds(
  sql: Sql,
  input: { organizationId: string; provider: string; eventId: string },
): Promise<string[]> {
  const rows = await sql<{ event_id: string }>`
    select event_id from webhook_events
    where organization_id = ${input.organizationId} and provider = ${input.provider} and event_id = ${input.eventId}
    limit 1
  `;
  return rows.map((row) => row.event_id);
}

/**
 * The organizations holding an active (not disconnected) connection for this provider account. Two rows are enough to
 * tell none, one and several apart, which is all routing needs.
 */
export async function activeWebhookOrganizations(sql: Sql, input: { provider: string; accountId: string }): Promise<string[]> {
  const rows = await sql<{ organization_id: string }>`
    select distinct organization_id from provider_connections
    where provider = ${input.provider} and account_id = ${input.accountId} and disconnected_at is null
    limit 2
  `;
  return rows.map((row) => row.organization_id);
}
