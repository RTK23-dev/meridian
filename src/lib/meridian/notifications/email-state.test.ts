import assert from "node:assert/strict";
import test from "node:test";
import { emailDeliveryState, isoOrNull } from "./email-state.ts";

test("email delivery is configured only when both email variables are set, and no value is returned", () => {
  const missing = emailDeliveryState({});
  assert.equal(missing.status, "NOT_CONFIGURED");
  assert.match(missing.detail, /EMAIL_API_URL and EMAIL_API_KEY/);
  assert.equal(emailDeliveryState({ url: "https://mail.example/send" }).status, "NOT_CONFIGURED");
  const set = emailDeliveryState({ url: "https://mail.example/send", key: "super-secret-value" });
  assert.equal(set.status, "CONFIGURED");
  assert.equal(JSON.stringify(set).includes("super-secret-value"), false, "the key value never appears in the state");
  assert.equal(JSON.stringify(set).includes("mail.example"), false, "the URL value never appears in the state");
});

test("a stored time becomes an ISO string, and an unreadable one becomes null", () => {
  assert.equal(isoOrNull("2026-03-01T10:00:00Z"), "2026-03-01T10:00:00.000Z");
  assert.equal(isoOrNull(new Date("2026-03-01T10:00:00Z")), "2026-03-01T10:00:00.000Z");
  assert.equal(isoOrNull(null), null);
  assert.equal(isoOrNull(""), null);
  assert.equal(isoOrNull("not a time"), null, "an unreadable time is unknown, not now");
});
