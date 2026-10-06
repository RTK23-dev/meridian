import assert from "node:assert/strict";
import test from "node:test";
import { storeWebhookEvent } from "./receive-store.ts";
import type { Sql } from "../learning/store.ts";

test("concurrent duplicate webhook insert is reported as already stored", async () => {
  let existing = false;
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    assert.match(query, /on conflict \(provider, event_id\) do nothing/);
    assert.match(query, /returning id/);
    if (existing) return [];
    existing = true;
    return [{ id: "event-row-1" }];
  }) as unknown as Sql;
  const input = { organizationId: "org-1", provider: "meta", eventId: "event-1" };
  assert.equal(await storeWebhookEvent(sql, input), true);
  assert.equal(await storeWebhookEvent(sql, input), false);
});
