import assert from "node:assert/strict";
import test from "node:test";
import { LEARN_RECHECK_SECONDS, learnRecheckPayload } from "./learn.ts";

test("a waiting learn stage is rechecked on the measurement cadence, with the run it belongs to", () => {
  assert.equal(LEARN_RECHECK_SECONDS, 6 * 60 * 60);
  assert.deepEqual(
    learnRecheckPayload({ organizationId: "org", brandId: "brand", runId: "run", niche: "skincare" }),
    { organizationId: "org", brandId: "brand", runId: "run", niche: "skincare", stage: "factory.learn" },
  );
});
