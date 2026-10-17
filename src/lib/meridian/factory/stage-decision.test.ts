import test from "node:test";
import assert from "node:assert/strict";
import { capStopReason, stageDecision, type StageDecisionInput } from "./stage-decision.ts";

test("capStopReason refuses spend at or over a set cap, and is null while spend is inside every cap", () => {
  assert.equal(capStopReason({ capCents: 40, spentCents: 39 }), null, "under the total cap");
  assert.equal(capStopReason({ capCents: 40, spentCents: 40 }), "The spend cap for this run is reached.", "at the total cap");
  assert.equal(capStopReason({ capCents: 40, spentCents: 41 }), "The spend cap for this run is reached.", "over the total cap");
  assert.equal(capStopReason({ capCents: null, spentCents: 10_000 }), null, "no total cap is set, so no total is refused");
  assert.equal(capStopReason({ capCents: 0, spentCents: 10_000 }), null, "a zero cap is not set");
  assert.equal(
    capStopReason({ capCents: null, spentCents: 0, dailyCapCents: 30, dailySpentCents: 30 }),
    "The daily spend cap for this run is reached.",
    "at the run's daily cap",
  );
  assert.equal(
    capStopReason({ capCents: 100, spentCents: 10, dailyCapCents: 30, dailySpentCents: 29 }),
    null,
    "inside both caps",
  );
  assert.equal(
    capStopReason({ capCents: 100, spentCents: 10, dailyCapCents: 30, dailySpentCents: 0 }),
    null,
    "a daily cap is read only from the daily spend, not the total",
  );
});

test("stageDecision refuses a spend stage with the reason capStopReason gives", () => {
  const input = { automation: "manual" as const, stage: "factory.produce" as const, approved: true, killSwitchEngaged: false };
  const reached = { capCents: 40, spentCents: 40 };
  const decision = stageDecision({ ...input, ...reached });
  assert.deepEqual(decision, { action: "stop", reason: capStopReason(reached) });
});

const base: StageDecisionInput = {
  automation: "manual",
  stage: "factory.produce",
  approved: false,
  killSwitchEngaged: false,
  capCents: 10_000,
  spentCents: 0,
};

test("manual: a spend or publish stage waits for a person, and runs once approved", () => {
  for (const stage of ["factory.produce", "factory.launch", "factory.test", "factory.review"] as const) {
    assert.equal(stageDecision({ ...base, stage }).action, "await_approval", `${stage} waits`);
    assert.equal(stageDecision({ ...base, stage, approved: true }).action, "run", `${stage} runs once approved`);
  }
});

test("manual review runs without a person when the saved line says so, and spend or publish still waits", () => {
  assert.equal(stageDecision({ ...base, stage: "factory.review", autoApproveReview: true }).action, "run");
  assert.equal(stageDecision({ ...base, stage: "factory.produce", autoApproveReview: true }).action, "await_approval");
  assert.equal(stageDecision({ ...base, stage: "factory.launch", autoApproveReview: true }).action, "await_approval");
  assert.equal(stageDecision({ ...base, stage: "factory.test", autoApproveReview: true }).action, "await_approval");
});

test("manual: stages that neither spend nor publish run without approval", () => {
  assert.equal(stageDecision({ ...base, stage: "factory.discover" }).action, "run");
  assert.equal(stageDecision({ ...base, stage: "factory.grade" }).action, "run");
  assert.equal(stageDecision({ ...base, stage: "factory.gate" }).action, "run", "the gate stage checks, and blocks through its own result");
});

test("semi: spend and publish wait once, and review runs on its own", () => {
  assert.equal(stageDecision({ ...base, automation: "semi", stage: "factory.produce" }).action, "await_approval");
  assert.equal(stageDecision({ ...base, automation: "semi", stage: "factory.launch", approved: true }).action, "run");
  assert.equal(stageDecision({ ...base, automation: "semi", stage: "factory.review" }).action, "run", "semi does not stop at review");
});

test("full: runs without a person while a spend cap is set and not reached", () => {
  assert.equal(stageDecision({ ...base, automation: "full", stage: "factory.produce" }).action, "run");
  assert.equal(stageDecision({ ...base, automation: "full", stage: "factory.launch", spentCents: 9_999 }).action, "run");
});

test("full: stops with a reason when there is no cap, or the cap is reached", () => {
  const noCap = stageDecision({ ...base, automation: "full", stage: "factory.launch", capCents: null });
  assert.equal(noCap.action, "stop");
  if (noCap.action === "stop") assert.match(noCap.reason, /needs a spend cap/);

  const zeroCap = stageDecision({ ...base, automation: "full", stage: "factory.produce", capCents: 0 });
  assert.equal(zeroCap.action, "stop");

  const reached = stageDecision({ ...base, automation: "full", stage: "factory.produce", spentCents: 10_000 });
  assert.equal(reached.action, "stop");
  if (reached.action === "stop") assert.match(reached.reason, /cap for this run is reached/);
});

test("the kill switch stops every stage in every mode, approved or not", () => {
  for (const automation of ["manual", "semi", "full"] as const) {
    for (const stage of ["factory.discover", "factory.grade", "factory.produce", "factory.launch"] as const) {
      const decision = stageDecision({ ...base, automation, stage, approved: true, killSwitchEngaged: true });
      assert.equal(decision.action, "stop", `${automation} ${stage} is stopped by the kill switch`);
    }
  }
});

test("a reached total cap stops a spend stage before it runs, in every mode, even once approved", () => {
  for (const automation of ["manual", "semi", "full"] as const) {
    const decision = stageDecision({ ...base, automation, stage: "factory.produce", approved: true, spentCents: 10_000 });
    assert.equal(decision.action, "stop", `${automation} stops at a reached cap`);
    if (decision.action === "stop") assert.equal(decision.reason, "The spend cap for this run is reached.");
  }
  // A stage that spends nothing is not held by the cap.
  assert.equal(stageDecision({ ...base, automation: "manual", stage: "factory.grade", spentCents: 10_000 }).action, "run");
});

test("a reached daily cap stops a spend stage, and a daily cap alone lets a full run spend inside it", () => {
  const daily = stageDecision({ ...base, automation: "manual", stage: "factory.produce", approved: true, capCents: null, dailyCapCents: 500, dailySpentCents: 500 });
  assert.equal(daily.action, "stop");
  if (daily.action === "stop") assert.match(daily.reason, /daily spend cap/);
  assert.equal(
    stageDecision({ ...base, automation: "full", stage: "factory.produce", capCents: null, dailyCapCents: 500, dailySpentCents: 499 }).action,
    "run",
    "a daily cap alone is a cap for full automation",
  );
});

test("a stage that waits is not a failure: the decision never fails the run", () => {
  const waiting = stageDecision({ ...base, automation: "manual", stage: "factory.launch" });
  assert.equal(waiting.action, "await_approval");
  if (waiting.action === "await_approval") assert.match(waiting.reason, /waits for a person's approval/);
});
