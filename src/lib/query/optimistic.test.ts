import assert from "node:assert/strict";
import test from "node:test";
import { markAlertAcknowledged, markOpportunitiesDismissed, markReviewResolved } from "./optimistic.ts";

test("approving or rejecting a review changes only that row", () => {
  const before = { reviews: [{ id: "r1", status: "open", title: "A" }, { id: "r2", status: "open", title: "B" }], counts: 2 };
  const approved = markReviewResolved(before, "r1", "approve");
  assert.deepEqual(approved?.reviews, [{ id: "r1", status: "approved", title: "A" }, { id: "r2", status: "open", title: "B" }]);
  assert.equal(approved?.counts, 2, "the rest of the payload is kept");
  assert.equal(before.reviews[0]?.status, "open", "the cached value is not mutated");
  assert.equal(markReviewResolved(before, "r1", "reject")?.reviews[0]?.status, "rejected");
});

test("a review update with no cached list stays absent, and an unknown id changes nothing", () => {
  assert.equal(markReviewResolved(undefined, "r1", "approve"), undefined);
  const before = { reviews: [{ id: "r1", status: "open" }] };
  const after = markReviewResolved(before, "missing", "approve");
  assert.deepEqual(after, { reviews: [{ id: "r1", status: "open" }] });
});

test("dismissing opportunities marks each named row and leaves the others", () => {
  const before = { opportunities: [{ id: "o1", status: "proposed" }, { id: "o2", status: "proposed" }, { id: "o3", status: "accepted" }] };
  const after = markOpportunitiesDismissed(before, ["o1", "o3"]);
  assert.deepEqual(after?.opportunities, [{ id: "o1", status: "dismissed" }, { id: "o2", status: "proposed" }, { id: "o3", status: "dismissed" }]);
  assert.equal(markOpportunitiesDismissed(undefined, ["o1"]), undefined);
  assert.deepEqual(markOpportunitiesDismissed(before, []), before, "no ids means no change");
});

test("acknowledging an alert marks only that alert", () => {
  const before = { alerts: [{ id: "a1", acknowledged: false }, { id: "a2", acknowledged: false }] };
  const after = markAlertAcknowledged(before, "a2");
  assert.deepEqual(after?.alerts, [{ id: "a1", acknowledged: false }, { id: "a2", acknowledged: true }]);
  assert.equal(markAlertAcknowledged(undefined, "a2"), undefined);
});
