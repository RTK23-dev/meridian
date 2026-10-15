// Percentiles and rates (Video Engine Bible 15.3). Pure: fixed samples, fixed answers.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { distributionOf, percentile, rateOf } from "./distribution.ts";

describe("percentile (nearest rank)", () => {
  test("the rank is ceil(p / 100 x n) of the sorted sample", () => {
    const values = [5, 1, 4, 2, 3];
    assert.equal(percentile(values, 50), 3);
    assert.equal(percentile(values, 95), 5);
    assert.equal(percentile(values, 20), 1);
  });

  test("an empty sample has no percentile, never 0", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([Number.NaN], 95), null);
  });

  test("values that are not finite numbers are not samples", () => {
    assert.equal(percentile([Number.NaN, 7, Number.POSITIVE_INFINITY], 50), 7);
  });

  test("a percentile outside (0, 100] is refused", () => {
    assert.throws(() => percentile([1], 0));
    assert.throws(() => percentile([1], 101));
    assert.throws(() => percentile([1], Number.NaN));
  });
});

describe("distribution and rate", () => {
  test("distributionOf counts the finite samples and gives p50 and p95", () => {
    assert.deepEqual(distributionOf([10, 20, 30, 40, Number.NaN]), { count: 4, p50: 20, p95: 40 });
    assert.deepEqual(distributionOf([]), { count: 0, p50: null, p95: null });
  });

  test("rateOf is rounded to four decimals, and null when there is nothing to divide by", () => {
    assert.equal(rateOf(1, 3), 0.3333);
    assert.equal(rateOf(0, 5), 0);
    assert.equal(rateOf(1, 0), null);
    assert.equal(rateOf(1, -2), null);
  });
});
