import assert from "node:assert/strict";
import test from "node:test";
import { registerAliases } from "../../test-support/register-aliases.ts";

// factory-forms.ts imports the server's level parser through the @/ alias. Plain Node has no such alias, so
// the test registers a resolver for it. The module itself is not changed.
await registerAliases();
const { factoryControlsPayload, factoryControlsSchema } = await import("../factory/factory-forms.ts");

const saved = { dailyCents: 2550, totalCents: 10000 };

test("a blank cap keeps the saved cap, in cents", () => {
  const payload = factoryControlsPayload({ level: "1", ceiling: "2", daily: "", total: "" }, saved);
  assert.equal(payload.dailyCents, 2550);
  assert.equal(payload.totalCents, 10000);
  assert.equal(payload.level, 1);
  assert.equal(payload.ceiling, 2);
});

test("a typed cap is turned into whole cents, rounding away floating point error", () => {
  const payload = factoryControlsPayload({ level: "0", ceiling: "3", daily: "0.29", total: "100.5" }, saved);
  assert.equal(payload.dailyCents, 29, "0.29 * 100 is 28.999... in floating point, and must round to 29");
  assert.equal(payload.totalCents, 10050);
});

test("a typed zero is a real cap of zero, not a blank that keeps the saved cap", () => {
  const payload = factoryControlsPayload({ level: "0", ceiling: "0", daily: "0", total: "0" }, saved);
  assert.equal(payload.dailyCents, 0);
  assert.equal(payload.totalCents, 0);
});

test("the schema accepts a blank cap and refuses a negative or non-numeric one", () => {
  const base = { level: "1", ceiling: "2", daily: "", total: "" };
  assert.equal(factoryControlsSchema.safeParse(base).success, true);
  assert.equal(factoryControlsSchema.safeParse({ ...base, daily: "-5" }).success, false);
  assert.equal(factoryControlsSchema.safeParse({ ...base, total: "lots" }).success, false);
});

test("a running level above the ceiling is refused on the level field", () => {
  const result = factoryControlsSchema.safeParse({ level: "3", ceiling: "1", daily: "", total: "" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, "The running level cannot exceed the ceiling.");
    assert.deepEqual(result.error.issues[0]?.path, ["level"]);
  }
});
