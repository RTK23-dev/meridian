import assert from "node:assert/strict";
import test from "node:test";
import { auditFilterSchema, connectAccountSchema, deliveryTargetSchema, providerFieldsSchema, queueScheduleSchema, webhookFilterSchema } from "./client-schemas.ts";

const messageOf = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.success ? null : result.error?.issues[0]?.message ?? null;

test("a delivery target accepts https, localhost http, and a blank that clears it", () => {
  assert.equal(deliveryTargetSchema.safeParse({ url: "https://hooks.example.com/meridian" }).success, true);
  assert.equal(deliveryTargetSchema.safeParse({ url: "http://localhost:3000/hook" }).success, true);
  assert.equal(deliveryTargetSchema.safeParse({ url: "http://127.0.0.1/hook" }).success, true);
  assert.equal(deliveryTargetSchema.safeParse({ url: "   " }).success, true, "a blank URL clears the target");
  assert.equal(deliveryTargetSchema.safeParse({ url: "  https://hooks.example.com/x  " }).data?.url, "https://hooks.example.com/x", "the URL is trimmed");
});

test("a delivery target refuses plain http, other schemes and embedded credentials, with the saved-nothing message", () => {
  const refusal = "A delivery target must be https, or http on localhost. Nothing was saved.";
  for (const url of ["http://hooks.example.com/x", "ftp://example.com/x", "javascript:alert(1)", "https://user:pass@example.com/x", "not a url"]) {
    assert.equal(messageOf(deliveryTargetSchema.safeParse({ url })), refusal, url);
  }
});

test("an audit filter accepts a YYYY-MM-DD date or a blank one, and refuses any other shape", () => {
  assert.equal(auditFilterSchema.safeParse({ actor: "", action: "", brandId: "", from: "2026-01-31", to: "" }).success, true);
  assert.equal(messageOf(auditFilterSchema.safeParse({ actor: "", action: "", brandId: "", from: "31/01/2026", to: "" })), "Use a date like 2026-01-31.");
  assert.equal(messageOf(auditFilterSchema.safeParse({ actor: "", action: "", brandId: "", from: "", to: "2026-1-5" })), "Use a date like 2026-01-31.");
});

test("audit actor and action are trimmed and capped at 100 characters", () => {
  const long = "x".repeat(100);
  assert.equal(auditFilterSchema.safeParse({ actor: long, action: long, brandId: "", from: "", to: "" }).success, true);
  assert.equal(messageOf(auditFilterSchema.safeParse({ actor: `${long}x`, action: "", brandId: "", from: "", to: "" })), "Use 100 characters or fewer.");
  assert.equal(auditFilterSchema.safeParse({ actor: `  ${long}  `, action: "", brandId: "", from: "", to: "" }).success, true, "padding does not count");
});

test("the webhook provider filter is capped at 80 characters", () => {
  assert.equal(webhookFilterSchema.safeParse({ provider: "x".repeat(80) }).success, true);
  assert.equal(messageOf(webhookFilterSchema.safeParse({ provider: "x".repeat(81) })), "Use 80 characters or fewer.");
});

test("a connected account needs a display name and an account ID, and its fields are capped", () => {
  const base = { platform: "meta", name: "Studio", handle: "", externalAccountId: "123", token: "" };
  assert.equal(connectAccountSchema.safeParse(base).success, true);
  assert.equal(messageOf(connectAccountSchema.safeParse({ ...base, name: "   " })), "Enter the account display name.");
  assert.equal(messageOf(connectAccountSchema.safeParse({ ...base, externalAccountId: "" })), "Enter the account ID.");
  assert.equal(messageOf(connectAccountSchema.safeParse({ ...base, name: "x".repeat(121) })), "Use 120 characters or fewer.");
  assert.equal(messageOf(connectAccountSchema.safeParse({ ...base, platform: "" })), "Choose a platform.");
  assert.equal(connectAccountSchema.safeParse({ ...base, name: "x".repeat(120) }).success, true);
});

test("the provider panel accepts a known cost mode and a whole page limit", () => {
  const base = { jevKey: "", productionKey: "", perceptionKey: "", gatewayUrl: "", costPreference: "BALANCED", maxPages: "12" };
  assert.equal(providerFieldsSchema.safeParse(base).success, true);
  assert.equal(providerFieldsSchema.safeParse({ ...base, maxPages: " 3 " }).success, true);
  assert.equal(providerFieldsSchema.safeParse({ ...base, costPreference: "FAST" }).success, false);
});

test("a blank or non-numeric page limit is refused instead of being stored as 0 or NaN", () => {
  const base = { jevKey: "", productionKey: "", perceptionKey: "", gatewayUrl: "", costPreference: "BALANCED", maxPages: "" };
  assert.equal(messageOf(providerFieldsSchema.safeParse(base)), "Enter the number of pages, as a number.");
  assert.equal(messageOf(providerFieldsSchema.safeParse({ ...base, maxPages: "ten" })), "Enter the number of pages, as a number.");
  assert.equal(messageOf(providerFieldsSchema.safeParse({ ...base, maxPages: "   " })), "Enter the number of pages, as a number.");
});

test("a queue schedule needs a creative and at least one account, and a blank time means publish now", () => {
  const base = { creativeId: "variant-1", targetType: "organic", targetAccountIds: ["acc-1"], scheduledTime: "" };
  assert.equal(queueScheduleSchema.safeParse(base).success, true);
  assert.equal(queueScheduleSchema.safeParse({ ...base, scheduledTime: "2026-10-12T09:00" }).success, true);
  assert.equal(messageOf(queueScheduleSchema.safeParse({ ...base, creativeId: "" })), "Select a creative variant.");
  assert.equal(messageOf(queueScheduleSchema.safeParse({ ...base, targetAccountIds: [] })), "Select at least one destination account.");
  assert.equal(messageOf(queueScheduleSchema.safeParse({ ...base, scheduledTime: "next Tuesday" })), "Enter a valid date and time, or leave the field blank to publish now.");
  assert.equal(queueScheduleSchema.safeParse({ ...base, targetType: "broadcast" }).success, false);
});
