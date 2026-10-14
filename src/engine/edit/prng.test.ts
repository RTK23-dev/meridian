import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_IDS } from "../contracts/fixtures/index.ts";
import { createRng, pickWeighted, seedFromRequestId } from "./prng.ts";

test("the seed for a request is a stable unsigned 32-bit number, and differs between requests", () => {
  const seed = seedFromRequestId(FIXTURE_IDS.request);
  assert.equal(seed, seedFromRequestId(FIXTURE_IDS.request), "the same request gives the same seed");
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  assert.notEqual(seed, seedFromRequestId(FIXTURE_IDS.dna), "a different request id gives a different seed");
  assert.equal(seed, 1967677434, "the seed is pinned: changing the hash changes every EDL id and every seeded choice");
});

test("a generator with the same seed gives the same numbers, all in [0, 1)", () => {
  const first = createRng(42);
  const second = createRng(42);
  const a = Array.from({ length: 200 }, () => first.next());
  const b = Array.from({ length: 200 }, () => second.next());
  assert.deepEqual(a, b);
  assert.ok(a.every((value) => value >= 0 && value < 1));
  const other = createRng(43);
  const c = Array.from({ length: 200 }, () => other.next());
  assert.notDeepEqual(a, c, "a different seed gives a different sequence");
});

test("a weighted pick follows the weights, and never picks an item of weight zero", () => {
  const rng = createRng(7);
  const picks = Array.from({ length: 2000 }, () =>
    pickWeighted(rng, [
      { value: "hard", weight: 0.8 },
      { value: "whip", weight: 0.2 },
    ]),
  );
  const hard = picks.filter((pick) => pick === "hard").length;
  assert.ok(hard > 1500 && hard < 1700, `about 80% hard, got ${hard} of 2000`);
  const onlyOne = Array.from({ length: 50 }, () =>
    pickWeighted(createRng(9), [
      { value: "a", weight: 1 },
      { value: "b", weight: 0 },
    ]),
  );
  assert.ok(onlyOne.every((pick) => pick === "a"));
});
