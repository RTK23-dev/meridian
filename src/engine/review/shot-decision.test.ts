import { test } from "node:test";
import assert from "node:assert/strict";
import { shotSpecSchema } from "../contracts/plan.ts";
import { shotChangeFor, shotDecisionSchema, SHOT_DECISION_TEXT_MAX } from "./shot-decision.ts";

const generated = shotSpecSchema.parse({
  shotId: "shot_01M4T7V8BR00000000000AFP71",
  beatId: "beat_1",
  startMs: 0,
  endMs: 4000,
  visualType: "cinematic",
  layer: "base",
  source: { kind: "generate", modelClass: "video.cinematic", prompt: "A quiet kitchen at dawn", refs: [], takes: 2 },
});
const stock = shotSpecSchema.parse({ ...generated, visualType: "stock_footage", source: { kind: "stock", query: "kitchen", minMs: 4000 } });

test("a decision is one of the two actions, with bounded text", () => {
  assert.ok(shotDecisionSchema.safeParse({ action: "edit_prompt", prompt: "A kitchen at noon" }).success);
  assert.ok(shotDecisionSchema.safeParse({ action: "change_visual_type", visualType: "stock_footage", query: "kitchen" }).success);
  assert.equal(shotDecisionSchema.safeParse({ action: "change_visual_type", visualType: "hologram" }).success, false, "an unknown type is refused");
  assert.equal(shotDecisionSchema.safeParse({ action: "edit_prompt", prompt: "x".repeat(SHOT_DECISION_TEXT_MAX + 1) }).success, false);
  assert.equal(shotDecisionSchema.safeParse({ action: "edit_prompt", prompt: "   " }).success, false, "a blank prompt is refused");
  assert.equal(shotDecisionSchema.safeParse({ action: "edit_prompt", prompt: "ok", extra: 1 }).success, false, "unknown fields are refused");
});

test("editing a generated shot's prompt keeps its type and changes only the prompt", () => {
  const outcome = shotChangeFor(generated, { action: "edit_prompt", prompt: "A kitchen at noon" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.change.visualType, "cinematic");
  assert.deepEqual(outcome.change.source, { kind: "generate", modelClass: "video.cinematic", prompt: "A kitchen at noon", refs: [], takes: 2 });
});

test("only a generated shot has a prompt to edit", () => {
  const outcome = shotChangeFor(stock, { action: "edit_prompt", prompt: "anything" });
  assert.deepEqual(outcome, { ok: false, reason: "only a generated shot has a prompt to edit" });
});

test("changing to stock footage needs a query and keeps the shot's length", () => {
  assert.deepEqual(shotChangeFor(generated, { action: "change_visual_type", visualType: "stock_footage" }), {
    ok: false,
    reason: "write the search query for the stock footage",
  });
  const outcome = shotChangeFor(generated, { action: "change_visual_type", visualType: "stock_footage", query: "morning kitchen" });
  assert.ok(outcome.ok);
  if (outcome.ok) assert.deepEqual(outcome.change, { visualType: "stock_footage", source: { kind: "stock", query: "morning kitchen", minMs: 4000 } });
});

test("changing to cinematic reuses the shot's prompt when it has one, or takes a new one", () => {
  const reused = shotChangeFor(stock, { action: "change_visual_type", visualType: "cinematic" });
  assert.deepEqual(reused, { ok: false, reason: "write the prompt for the cinematic shot" });
  const written = shotChangeFor(stock, { action: "change_visual_type", visualType: "cinematic", prompt: "Dawn light on a counter" });
  assert.ok(written.ok);
  if (written.ok) assert.equal(written.change.source.kind, "generate");
  const kept = shotChangeFor(generated, { action: "change_visual_type", visualType: "cinematic" });
  assert.ok(kept.ok);
  if (kept.ok) assert.equal(kept.change.source.kind === "generate" ? kept.change.source.prompt : "", "A quiet kitchen at dawn");
});
