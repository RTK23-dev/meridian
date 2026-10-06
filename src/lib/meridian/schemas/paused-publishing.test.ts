import assert from "node:assert/strict";
import test from "node:test";
import { pausedPublishingSchema } from "./paused-publishing.ts";

test("paused publishing parses budget and comma-separated provider fields", () => {
  const parsed = pausedPublishingSchema.parse({ provider: "meta", creativeId: "creative-1", name: "Spring", dailyBudgetCents: "1000.4", countries: "US, CA", locationIds: "", pageId: "page", link: "", message: "", scheduleStart: "", imageIds: "img-1, img-2", videoId: "", headlines: "", descriptions: "", cpcBidCents: "0" });
  assert.equal(parsed.dailyBudgetCents, 1000);
  assert.deepEqual(parsed.countries, ["US", "CA"]);
  assert.deepEqual(parsed.imageIds, ["img-1", "img-2"]);
});

test("paused publishing rejects an absent creative, campaign name, provider, or positive budget", () => {
  const base = { provider: "meta", creativeId: "creative-1", name: "Spring", dailyBudgetCents: "1000" };
  assert.equal(pausedPublishingSchema.safeParse({ ...base, creativeId: "" }).success, false);
  assert.equal(pausedPublishingSchema.safeParse({ ...base, name: "" }).success, false);
  assert.equal(pausedPublishingSchema.safeParse({ ...base, provider: "other" }).success, false);
  assert.equal(pausedPublishingSchema.safeParse({ ...base, dailyBudgetCents: "0" }).success, false);
});
