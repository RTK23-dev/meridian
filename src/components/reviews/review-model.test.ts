import assert from "node:assert/strict";
import test from "node:test";
import { reviewCountLine } from "./review-model.ts";

test("the count line states exact totals and names the loaded window when older reviews exist", () => {
  assert.equal(
    reviewCountLine({ openTotal: 3, total: 95, loaded: 40, hasMore: true }),
    "3 open reviews. Showing the newest 40 of 95 reviews.",
  );
  assert.equal(reviewCountLine({ openTotal: 1, total: 1, loaded: 1, hasMore: false }), "1 open review. 1 review in total.");
  assert.equal(reviewCountLine({ openTotal: 2, total: 2, loaded: 2, hasMore: false }), "2 open reviews. 2 reviews in total.");
});
