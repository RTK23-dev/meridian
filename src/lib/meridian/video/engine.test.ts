import assert from "node:assert/strict";
import test from "node:test";
import { hypitVideoEngine, videoEngineById } from "./engine.ts";

test("Hypit is adapter one and an unknown engine is refused", () => {
  const engine = videoEngineById("hypit");
  assert.equal(engine.id, "hypit");
  const status = hypitVideoEngine().status();
  assert.equal(status.provider, "hypit");
  assert.ok(status.status === "NOT_CONNECTED" || status.status === "CONFIGURED");
  assert.throws(() => videoEngineById("runway"), /Unknown video engine/);
});
