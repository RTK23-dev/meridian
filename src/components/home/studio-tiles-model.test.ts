import assert from "node:assert/strict";
import test from "node:test";
import { studioCounts } from "./studio-tiles-model.ts";

test("the studio row counts videos being made, delivered and stopped, and each mode", () => {
  const counts = studioCounts([
    { mode: "studio", status: "active" },
    { mode: "orchestrator", status: "active" },
    { mode: "orchestrator", status: "delivered" },
    { mode: "guided", status: "abandoned" },
  ]);
  assert.deepEqual(counts, { active: 2, delivered: 1, stopped: 1, byMode: { studio: 1, guided: 1, orchestrator: 2 } });
  assert.deepEqual(studioCounts([]), { active: 0, delivered: 0, stopped: 0, byMode: { studio: 0, guided: 0, orchestrator: 0 } });
});
