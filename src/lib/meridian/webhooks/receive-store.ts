import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export async function storeWebhookEvent(sql: Sql, input: { organizationId: string; provider: string; eventId: string }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    insert into webhook_events (id, organization_id, provider, event_id)
    values (${randomUUID()}, ${input.organizationId}, ${input.provider}, ${input.eventId})
    on conflict (provider, event_id) do nothing
    returning id
  `;
  return Boolean(rows[0]);
}
