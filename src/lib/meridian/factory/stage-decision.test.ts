import test from "node:test";
import assert from "node:assert/strict";
import { stageDecision, type StageDecisionInput } from "./stage-decision.ts";

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
