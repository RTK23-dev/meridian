import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type GateResult } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { validateStageOutput } from "./validate.ts";
import type { EnginePayload, StageOutput } from "./types.ts";

const REQ = FIXTURE_IDS.request;

function payload(overrides: Partial<EnginePayload> = {}): EnginePayload {
  return {
    organizationId: "ws_fixture",
    requestId: REQ,
    stage: "intake",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: null,
    inputArtifactIds: [],
    hints: [],
    details: {},
    ...overrides,
  };
}

function gate(name: GateResult["gate"]): GateResult {
  return { gate: name, subjectId: REQ, pass: true, checks: [{ rule: "ok", pass: true }] };
}

function refused(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && pattern.test(error.message));
}

test("an output that answers the job for its subject and parses is returned unchanged", () => {
  const output: StageOutput = {
    stage: "intake",
    subjectId: REQ,
    gate: gate("request"),
    budgetReservationId: FIXTURE_IDS.reservation,
    artifacts: { validated: fixtureId("art_", 40) },
  };
  assert.equal(validateStageOutput(output, payload()), output);
});

test("an output for another stage, another subject, or a malformed id is refused", () => {
  refused(
    () => validateStageOutput({ stage: "voice", subjectId: REQ, gate: gate("voice"), artifacts: {} }, payload()),
    /the result is for voice, but the job is for intake/,
  );
  refused(
    () => validateStageOutput({ stage: "intake", subjectId: fixtureId("req_", 9), gate: gate("request"), budgetReservationId: null, artifacts: {} }, payload()),
    /for req_/,
  );
  refused(
    () => validateStageOutput({ stage: "intake", subjectId: REQ, gate: gate("request"), budgetReservationId: "not-a-reservation", artifacts: {} }, payload()),
    /reservation id/,
  );
  refused(
    () => validateStageOutput({ stage: "intake", subjectId: REQ, gate: gate("request"), budgetReservationId: null, artifacts: { validated: "art-1" } }, payload()),
    /artifact map/,
  );
});

test("a gate that does not parse against the gate contract is refused, so no unknown result reaches the graph", () => {
  const broken = { gate: "request", subjectId: REQ, pass: true, checks: [] } as unknown as GateResult;
  refused(
    () => validateStageOutput({ stage: "intake", subjectId: REQ, gate: broken, budgetReservationId: null, artifacts: {} }, payload()),
    /request gate/,
  );
});

test("a plan's shots must parse, and a shot id of the wrong prefix is refused", () => {
  const plan = (shotId: string): StageOutput => ({
    stage: "plan",
    subjectId: REQ,
    gate: gate("plan"),
    shots: [{ shotId, visualType: "product_hero", downgradeTo: null, sourceKind: "asset", modelClass: null, takesWanted: 1 }],
    artifacts: {},
  });
  assert.equal(validateStageOutput(plan(fixtureId("shot_", 51)), payload({ stage: "plan" })).stage, "plan");
  refused(() => validateStageOutput(plan(fixtureId("take_", 51)), payload({ stage: "plan" })), /plan's shots/);
});
