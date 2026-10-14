import assert from "node:assert/strict";
import test from "node:test";
import { weights } from "../config/weights.ts";
import type { VisualType } from "../contracts/index.ts";
import { PROPOSALS } from "./tables.ts";
import { proposeCandidates } from "./propose.ts";
import { referenceMatchOf } from "./score.ts";

test("the proposals follow the 7.4 table order, with the reference match by position", () => {
  const pool = proposeCandidates({ refShot: "broll_montage", requests: [], mustAllowed: null });
  assert.deepEqual(
    pool.slice(0, 3).map((item) => item.visualType),
    ["stock_footage", "product_hero", "cinematic"],
  );
  assert.equal(referenceMatchOf(pool[0].proposalIndex), weights.referenceMatchByOrder.first);
  assert.equal(referenceMatchOf(pool[1].proposalIndex), weights.referenceMatchByOrder.second);
  assert.equal(referenceMatchOf(pool[2].proposalIndex), weights.referenceMatchByOrder.other);
});

test("every reference shot type has its 7.4 proposals in the table", () => {
  for (const [refShot, types] of Object.entries(PROPOSALS)) {
    assert.ok(types.length > 0, `${refShot} proposes something`);
  }
  assert.deepEqual(PROPOSALS.talking_head, ["ugc_presenter", "react_clip"]);
  assert.deepEqual(PROPOSALS.text_only, ["kinetic_type"]);
});

test("may requests add their types after the proposals", () => {
  const pool = proposeCandidates({
    refShot: "onscreen_list",
    requests: [{ strength: "may", want: "a sketch of the product", properties: ["cartoon_style"] }],
    mustAllowed: null,
  });
  const types = pool.map((item) => item.visualType);
  assert.equal(types[0], "coded_graphics");
  assert.ok(types.includes("cartoon_rigged"));
  const may = pool.find((item) => item.visualType === "cartoon_rigged");
  assert.equal(may?.origin, "may");
  assert.equal(may?.proposalIndex, null, "may types are beyond the proposals");
});

test("a must's allowed types join the pool, so a must is always reachable", () => {
  const pool = proposeCandidates({
    refShot: "talking_head",
    requests: [{ strength: "must", want: "the blender", properties: ["real_product"] }],
    mustAllowed: ["product_hero", "coded_graphics", "stop_motion", "cinematic"],
  });
  const types = pool.map((item) => item.visualType);
  assert.ok(types.includes("coded_graphics"), "a type that is not a talking-head proposal is still a candidate");
  assert.equal(pool.find((item) => item.visualType === "coded_graphics")?.origin, "must");
});

test("downgrade chains are followed transitively and each type appears once", () => {
  const pool = proposeCandidates({ refShot: "spectacle", requests: [], mustAllowed: null });
  const types = pool.map((item) => item.visualType);
  // spectacle proposes cinematic and product_hero. cinematic downgrades to product_hero and stock_footage; product_hero
  // downgrades to coded_graphics. So the pool reaches the zero-cost route.
  assert.ok(types.includes("stock_footage"));
  assert.ok(types.includes("coded_graphics"));
  assert.equal(new Set(types).size, types.length, "no duplicates");
  assert.equal(pool.find((item) => item.visualType === "coded_graphics")?.origin, "downgrade");
});

test("a talking head reaches a zero-cost route through its downgrade, so a budget of nothing still fills the shot", () => {
  const pool = proposeCandidates({ refShot: "talking_head", requests: [], mustAllowed: null });
  const types: VisualType[] = pool.map((item) => item.visualType);
  assert.ok(types.includes("kinetic_type"));
});
