import assert from "node:assert/strict";
import test from "node:test";
import { capStopReason, stageDecision } from "./stage-decision.ts";

// A brand cap is held against the brand's spend across all of its runs. A run with little spend of its own must still stop when the
// brand has spent its cap, so starting another run cannot reset the brand's cap.

test("a brand total cap stops a run whose own spend is small, once the brand has spent the cap", () => {
  assert.equal(
    capStopReason({ capCents: null, spentCents: 0, brandCapCents: 40, brandSpentCents: 40 }),
    "The spend cap for this brand is reached.",
  );
});

test("a brand daily cap stops a run that has spent nothing today, once the brand has spent its daily cap", () => {
  assert.equal(
    capStopReason({ capCents: null, spentCents: 0, brandDailyCapCents: 30, brandDailySpentCents: 30 }),
    "The daily spend cap for this brand is reached.",
  );
});

test("a brand cap below the brand's spend is not checked against this run's spend alone", () => {
  assert.equal(capStopReason({ capCents: null, spentCents: 10, brandCapCents: 40, brandSpentCents: 39 }), null);
});

test("a full run is allowed only while a brand cap is set, even with no run cap", () => {
  const onlyBrandCap = stageDecision({
    automation: "full",
    stage: "factory.produce",
    approved: false,
    killSwitchEngaged: false,
    capCents: null,
    spentCents: 0,
    brandCapCents: 40,
    brandSpentCents: 0,
  });
  assert.deepEqual(onlyBrandCap, { action: "run" });
  const noCap = stageDecision({
    automation: "full",
    stage: "factory.produce",
    approved: false,
    killSwitchEngaged: false,
    capCents: null,
    spentCents: 0,
  });
  assert.equal(noCap.action, "stop");
});
