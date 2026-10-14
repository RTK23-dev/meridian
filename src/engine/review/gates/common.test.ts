import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, edlSchema, gateResultSchema } from "../../contracts/index.ts";
import { check, EDL_FPS, gateResult, notEvaluated, stringsIn } from "./common.ts";

test("EDL_FPS is the EDL contract's fps literal (edl.ts fps: z.literal(30))", () => {
  assert.equal(edlSchema.shape.fps.safeParse(EDL_FPS).success, true);
  assert.equal(edlSchema.shape.fps.safeParse(EDL_FPS - 1).success, false);
});

test("check() keeps only finite numbers and non-empty details", () => {
  assert.deepEqual(check("r", true), { rule: "r", pass: true });
  assert.deepEqual(check("r", false, { value: Number.NaN, limit: 3, detail: "" }), { rule: "r", pass: false, limit: 3 });
  assert.deepEqual(check("r", false, { value: 2, detail: "why" }), { rule: "r", pass: false, value: 2, detail: "why" });
});

test("notEvaluated() is a failing check that says why", () => {
  const result = notEvaluated("some_rule", "the input is missing");
  assert.equal(result.pass, false);
  assert.equal(result.detail, "not evaluated: the input is missing");
});

test("gateResult() passes only when every check passes, and never with no checks", () => {
  assert.equal(gateResult("budget", "res_x", [check("a", true)]).pass, true);
  assert.equal(gateResult("budget", "res_x", [check("a", true), check("b", false)]).pass, false);
  assert.throws(
    () => gateResult("budget", "res_x", []),
    (error: unknown) => error instanceof EngineError && error.kind === "internal",
  );
});

test("gateResult() de-duplicates failing shot ids in the order given, and omits them when empty", () => {
  const shotId = "shot_01KA0000000000000000000000";
  const other = "shot_01KB0000000000000000000000";
  const result = gateResult("plan", "plan_x", [check("a", false)], [shotId, other, shotId]);
  assert.deepEqual(result.failingShotIds, [shotId, other]);
  assert.equal(gateResult("plan", "plan_x", [check("a", true)], []).failingShotIds, undefined);
  assert.equal(gateResultSchema.safeParse(result).success, true);
});

test("stringsIn() finds every string inside a props object, and stops at a sane depth", () => {
  assert.deepEqual(stringsIn({ a: "x", b: ["y", { c: "z" }], d: 3 }).sort(), ["x", "y", "z"]);
  let deep: unknown = "bottom";
  for (let index = 0; index < 20; index++) {
    deep = { next: deep };
  }
  assert.deepEqual(stringsIn(deep), []);
});
