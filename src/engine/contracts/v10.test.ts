// Contract v10 (Bible section 4, v10 note): a catalog entry lists the whole-second durations a video model takes, when the catalog
// names them one by one. A range alone cannot say that 6 s is not one of 5 and 10 s. Refusals are in invalid.test.ts; this file checks
// what must be accepted.

import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACTS_VERSION, modelCatalogEntrySchema } from "./index.ts";
import { modelCatalogEntryFixture } from "./fixtures/index.ts";

/** The fixture with its duration range set from a list, as the gateway sets it: the first and last values of the list. */
function withDurations(durationsSeconds: number[] | null) {
  const minSeconds = durationsSeconds === null ? null : (durationsSeconds[0] ?? null);
  const maxSeconds = durationsSeconds === null ? null : (durationsSeconds[durationsSeconds.length - 1] ?? null);
  return { ...modelCatalogEntryFixture, capabilities: { ...modelCatalogEntryFixture.capabilities, minSeconds, maxSeconds, durationsSeconds } };
}

test("the contract set is at least engine-contracts@10 (v11 is pinned in v11.test.ts)", () => {
  assert.ok(Number(CONTRACTS_VERSION.split("@")[1]) >= 10, `the set is ${CONTRACTS_VERSION}`);
});

test("an entry with no list, which gives only a range, is accepted as before", () => {
  assert.equal(modelCatalogEntrySchema.safeParse(withDurations(null)).success, true);
});

test("an entry whose list runs from minSeconds to maxSeconds is accepted, and the list is kept as it is", () => {
  const parsed = modelCatalogEntrySchema.parse(withDurations([5, 10]));
  assert.deepEqual(parsed.capabilities.durationsSeconds, [5, 10]);
  assert.equal(modelCatalogEntrySchema.safeParse(withDurations(Array.from({ length: 29 }, (_, index) => index + 2))).success, true, "every whole second from 2 to 30");
});
