import assert from "node:assert/strict";
import test from "node:test";
import { registerAliases } from "../../test-support/register-aliases.ts";

// factory-forms.ts imports the server's level parser through the @/ alias. Plain Node has no such alias, so
// the test registers a resolver for it. The module itself is not changed.
await registerAliases();
const { factoryControlsPayload, factoryControlsSchema } = await import("../factory/factory-forms.ts");

test("the controls payload is the level and the ceiling: the spend caps are not part of it (they are set on the billing page)", () => {
  assert.deepEqual(factoryControlsPayload({ level: "1", ceiling: "2" }), { level: 1, ceiling: 2 });
});

test("the schema accepts a level and a ceiling, and refuses a level that is not 0 to 3", () => {
  assert.equal(factoryControlsSchema.safeParse({ level: "1", ceiling: "2" }).success, true);
  assert.equal(factoryControlsSchema.safeParse({ level: "7", ceiling: "2" }).success, false);
});

test("a running level above the ceiling is refused on the level field", () => {
  const result = factoryControlsSchema.safeParse({ level: "3", ceiling: "1" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, "The running level cannot exceed the ceiling.");
    assert.deepEqual(result.error.issues[0]?.path, ["level"]);
  }
});
