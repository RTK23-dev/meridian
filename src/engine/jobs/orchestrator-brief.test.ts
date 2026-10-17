// The orchestrator's routing of a brief request (contract v8): write_script runs after analyze_reference and before voice, a script request
// skips it as done, and voice and plan read the written script through their inputs (the "script" slot). Pure: advance() with the stage
// outputs a test gives it, so no store or provider is involved.

import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type GateResult } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { advance, type OrchestratorState } from "./orchestrator.ts";
import type { EngineEvent, QueuedJob, StageOutput } from "./types.ts";

const REQ = FIXTURE_IDS.request;
const ORG = "org_brief_routing";
const REQUEST_ART = fixtureId("art_", 40);
const VALIDATED = fixtureId("art_", 41);
const DNA = fixtureId("art_", 42);
const SCRIPT = fixtureId("art_", 43);
const VOICE = fixtureId("art_", 44);
const RES = FIXTURE_IDS.reservation;

function gate(name: GateResult["gate"]): GateResult {
  return { gate: name, subjectId: REQ, pass: true, checks: [{ rule: `${name}.ok`, pass: true, value: 1 }] };
}

function start(brief: boolean, cachedDna = false): EngineEvent {
  return {
    type: "start",
    organizationId: ORG,
    requestId: REQ,
    priority: "normal",
    cachedDna,
    variantCount: 0,
    requestArtifactId: REQUEST_ART,
    ...(brief ? { brief: true } : {}),
    ...(cachedDna ? { cachedDnaArtifactId: DNA } : {}),
  };
}

/** A small driver over advance(): applies each event, and keeps the state and the jobs it queued. */
class Flow {
  state: OrchestratorState | null = null;
  jobs: QueuedJob[] = [];

  apply(event: EngineEvent): this {
    const result = advance(this.state, event);
    this.state = result.state;
    this.jobs = result.jobs;
    return this;
  }

  succeed(output: StageOutput): this {
    return this.apply({ type: "succeeded", output });
  }

  get current(): OrchestratorState {
    if (this.state === null) throw new Error("the flow has not started");
    return this.state;
  }

  stages(): string[] {
    return this.jobs.map((job) => job.stage);
  }

  job(stage: string): QueuedJob {
    const found = this.jobs.find((job) => job.stage === stage);
    if (!found) throw new Error(`no ${stage} job is queued: ${this.stages().join(", ")}`);
    return found;
  }
}

function passIntake(flow: Flow): Flow {
  return flow.succeed({ stage: "intake", subjectId: REQ, gate: gate("request"), budgetReservationId: RES, budgetPause: null, artifacts: { validated: VALIDATED } });
}

test("a script request skips write_script as done: after intake, analysis and voice are queued and no script is awaited", () => {
  const flow = passIntake(new Flow().apply(start(false)));
  assert.equal(flow.current.nodes.write_script.status, "passed");
  assert.deepEqual(flow.stages().sort(), ["analyze_reference", "voice"]);
  assert.deepEqual(flow.job("voice").payload.inputArtifactIds, [REQUEST_ART], "voice reads only the request for a script request");
});

test("a brief waits for its reference: after intake only analysis is queued, and write_script and voice are not", () => {
  const flow = passIntake(new Flow().apply(start(true)));
  assert.equal(flow.current.nodes.write_script.status, "idle");
  assert.deepEqual(flow.stages(), ["analyze_reference"]);
});

test("a brief's write_script is queued after its analysis, with the brief and the DNA as its inputs", () => {
  const flow = passIntake(new Flow().apply(start(true))).succeed({
    stage: "analyze_reference",
    subjectId: REQ,
    gate: gate("dna"),
    artifacts: { dna: DNA },
  });
  assert.deepEqual(flow.stages(), ["write_script"]);
  assert.deepEqual(flow.job("write_script").payload.inputArtifactIds, [REQUEST_ART, DNA]);
  assert.equal(flow.job("write_script").paid, true, "the scriptwriter is a paid call, on the request's reservation");
  assert.equal(flow.job("write_script").payload.budgetReservationId, RES);
});

test("a cached DNA lets a brief's write_script run right after intake", () => {
  const flow = passIntake(new Flow().apply(start(true, true)));
  assert.deepEqual(flow.stages(), ["write_script"]);
  assert.deepEqual(flow.job("write_script").payload.inputArtifactIds, [REQUEST_ART, DNA]);
});

test("a written script opens voice, and voice reads the script through its inputs", () => {
  const flow = passIntake(new Flow().apply(start(true)))
    .succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna"), artifacts: { dna: DNA } })
    .succeed({ stage: "write_script", subjectId: REQ, artifacts: { script: SCRIPT } });
  assert.equal(flow.current.nodes.write_script.status, "passed");
  assert.deepEqual(flow.stages(), ["voice"]);
  assert.deepEqual(flow.job("voice").payload.inputArtifactIds, [REQUEST_ART, SCRIPT]);
});

test("a voice that passes opens plan, and plan reads the written script with the voice and the DNA", () => {
  const flow = passIntake(new Flow().apply(start(true)))
    .succeed({ stage: "analyze_reference", subjectId: REQ, gate: gate("dna"), artifacts: { dna: DNA } })
    .succeed({ stage: "write_script", subjectId: REQ, artifacts: { script: SCRIPT } })
    .succeed({ stage: "voice", subjectId: REQ, gate: gate("voice"), artifacts: { voice: VOICE } });
  assert.deepEqual(flow.stages(), ["plan"]);
  const inputs = flow.job("plan").payload.inputArtifactIds;
  for (const id of [VALIDATED, DNA, VOICE, SCRIPT]) assert.ok(inputs.includes(id), `plan reads ${id}`);
});

test("a write_script that passes without its written script artifact is refused: it names no script to read", () => {
  const flow = passIntake(new Flow().apply(start(true))).succeed({
    stage: "analyze_reference",
    subjectId: REQ,
    gate: gate("dna"),
    artifacts: { dna: DNA },
  });
  assert.throws(
    () => flow.succeed({ stage: "write_script", subjectId: REQ, artifacts: {} }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("a dead write_script pauses the request with a dead letter naming the stage, and keeps its artifacts", () => {
  const flow = passIntake(new Flow().apply(start(true))).succeed({
    stage: "analyze_reference",
    subjectId: REQ,
    gate: gate("dna"),
    artifacts: { dna: DNA },
  });
  flow.apply({ type: "dead", stage: "write_script", subjectId: REQ, reason: "the scriptwriter answer did not match its contract" });
  assert.equal(flow.current.status, "paused");
  assert.equal(flow.current.pause?.kind, "dead_letter");
  assert.equal(flow.current.pause?.stage, "write_script");
  assert.equal(flow.current.artifacts.dna, DNA, "the analysed reference is kept");
  assert.deepEqual(flow.jobs, [], "nothing else is queued while the request is paused");
});
