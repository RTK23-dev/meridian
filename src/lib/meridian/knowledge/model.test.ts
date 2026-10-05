import assert from "node:assert/strict";
import test from "node:test";
import type { AttributeBag } from "../domain.ts";
import { findSimilar, queryCreatives } from "./model.ts";

function item(id: string, patch: Partial<AttributeBag> = {}): AttributeBag & { id: string } {
  return {
    id,
    angle: "demonstration",
    hookType: "problem",
    format: "short_ugc",
    proofType: "demonstration",
    offer: "",
    cta: "Shop",
    visualStyle: "natural",
    platform: "paid_social",
    emotion: "relief",
    productName: "Soap",
    ...patch,
  };
}

test("attribute queries find demonstration plus a problem hook plus product proof", () => {
  const rows = [
    item("a"),
    item("b", { hookType: "curiosity", proofType: "testimonial" }),
    item("c", { angle: "offer", hookType: "offer", proofType: "offer", format: "static" }),
  ];
  const found = queryCreatives(rows, { angle: "demonstration", hookType: "problem", proofType: "demonstration" });
  assert.deepEqual(found.map((row) => row.id), ["a"]);
});

test("similar concepts stay below a near-duplicate", () => {
  const target = item("target");
  const corpus = [
    item("same"),
    item("close", { emotion: "calm", cta: "Learn" }),
    item("far", { angle: "offer", hookType: "offer", format: "static", proofType: "offer", visualStyle: "bold", emotion: "urgency" }),
  ];
  const similar = findSimilar(target, corpus);
  assert.ok(similar.some((row) => row.item.id === "close"));
  assert.equal(similar.some((row) => row.item.id === "same"), false);
});
