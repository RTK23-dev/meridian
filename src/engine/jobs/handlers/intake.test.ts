import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { GateResult } from "../../contracts/index.ts";
import {
  characterSheetFixture,
  FIXTURE_IDS,
  personaFixture,
  productKitFixture,
  productionRequestFixture,
  styleKitFixture,
  voiceKitFixture,
} from "../../contracts/fixtures/index.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createIntakeHandler, decideIntake, type IntakeDecisionInput, type IntakePorts, type ResolvedKits } from "./intake.ts";
import type { VisualClassification } from "../../review/gates/request.ts";

const BLENDER = "the blender on a clean kitchen counter";
const blender: VisualClassification = { beatId: "b3", want: BLENDER, properties: ["real_product"] };

/** The kits the fixture request names, as the kit store would return them. */
function fixtureKits(): ResolvedKits {
  return {
    styleKit: structuredClone(styleKitFixture),
    persona: structuredClone(personaFixture),
    voice: structuredClone(voiceKitFixture),
    characters: [structuredClone(characterSheetFixture)],
    productKit: structuredClone(productKitFixture),
  };
}

function fixtureRequest(budgetUsd?: number): Record<string, unknown> {
  const request = structuredClone(productionRequestFixture) as unknown as { constraints: { budgetUsd: number } } & Record<string, unknown>;
  if (budgetUsd !== undefined) request.constraints.budgetUsd = budgetUsd;
  return request;
}

function decisionInput(overrides: Partial<IntakeDecisionInput> = {}): IntakeDecisionInput {
  return { request: fixtureRequest(), kits: fixtureKits(), videoDnaId: null, classifications: [blender], ...overrides };
}

/** The named check on a gate, or a test failure if the gate did not emit it. */
function checkOf(gate: GateResult, rule: string) {
  const found = gate.checks.find((item) => item.rule === rule);
  assert.ok(found, `check ${rule} is present`);
  return found;
}

test("the fixture request passes the request gate; the minimum and the validated request are built", () => {
  const decision = decideIntake(decisionInput());
  assert.equal(decision.gate.gate, "request");
  assert.equal(decision.gate.pass, true, JSON.stringify(decision.gate.checks.filter((item) => !item.pass)));
  assert.equal(decision.minimum?.minimumUsd, 0.52);
  assert.equal(decision.estimatedSpeechMs, 16800, "42 words at 150 words a minute");
  assert.equal(decision.validated?.estimatedSpeechMs, 16800);
  assert.deepEqual(decision.validated?.kits.styleKit, { id: "sk_fixture", version: 3 });
  assert.equal(decision.validated?.cachedVideoDnaId, undefined, "a miss stores no VideoDNA id");
  assert.equal(checkOf(decision.gate, "format_minimum_computed").pass, true);
});

test("a budget below the format minimum fails the gate, and the reason names the minimum", () => {
  const decision = decideIntake(decisionInput({ request: fixtureRequest(0.4) }));
  assert.equal(decision.gate.pass, false);
  const budget = checkOf(decision.gate, "budget_above_format_minimum");
  assert.equal(budget.pass, false);
  assert.match(budget.detail ?? "", /below the minimum 0\.52 USD/);
  assert.match(budget.detail ?? "", /budget 0\.4 USD/);
  assert.equal(decision.minimum?.minimumUsd, 0.52, "the minimum is still reported, so the user can be told it");
});

test("a budget at the exact minimum passes the budget check", () => {
  const decision = decideIntake(decisionInput({ request: fixtureRequest(0.52) }));
  assert.equal(checkOf(decision.gate, "budget_above_format_minimum").pass, true);
  assert.equal(decision.gate.pass, true);
});

test("a persona that did not load leaves the speech length unknown: the gate fails, and builds nothing it cannot know", () => {
  const kits = { ...fixtureKits(), persona: undefined };
  const decision = decideIntake(decisionInput({ kits }));
  assert.equal(decision.gate.pass, false);
  assert.equal(decision.estimatedSpeechMs, null);
  assert.equal(decision.validated, null);
  assert.equal(decision.minimum, null);
  assert.match(checkOf(decision.gate, "speech_length_estimated").detail ?? "", /no words per minute/);
  assert.equal(checkOf(decision.gate, "format_minimum_computed").pass, false);
  assert.equal(checkOf(decision.gate, "budget_above_format_minimum").pass, false, "the minimum is not computed");
  assert.equal(checkOf(decision.gate, "validated_request_built").pass, false);
});

test("a must with no classification fails the minimum and the must check, and the reason says why", () => {
  const decision = decideIntake(decisionInput({ classifications: [] }));
  assert.equal(decision.gate.pass, false);
  assert.equal(decision.minimum, null);
  assert.match(checkOf(decision.gate, "format_minimum_computed").detail ?? "", /has no classification/);
  assert.equal(checkOf(decision.gate, "every_must_deliverable").pass, false);
});

test("the VideoDNA lookup must run; a cached id is carried into the validated request", () => {
  const notRun = decideIntake(decisionInput({ videoDnaId: undefined }));
  assert.equal(checkOf(notRun.gate, "dna_lookup_resolved").pass, false);
  assert.equal(notRun.gate.pass, false);

  const cached = decideIntake(decisionInput({ videoDnaId: FIXTURE_IDS.dna }));
  assert.equal(checkOf(cached.gate, "dna_lookup_resolved").pass, true);
  assert.equal(cached.validated?.cachedVideoDnaId, FIXTURE_IDS.dna);
  assert.equal(cached.gate.pass, true);
});

test("a request that does not parse fails the schema check and builds nothing", () => {
  const request = fixtureRequest() as Record<string, unknown>;
  delete request.schema;
  const decision = decideIntake(decisionInput({ request }));
  assert.equal(decision.gate.pass, false);
  assert.equal(checkOf(decision.gate, "schema_valid").pass, false);
  assert.equal(decision.validated, null);
  assert.equal(decision.minimum, null);
  assert.equal(decision.estimatedSpeechMs, null);
});

test("a style kit that did not load: the validated request cannot be built, and the gate says which kit", () => {
  const kits = { ...fixtureKits(), styleKit: undefined };
  const decision = decideIntake(decisionInput({ kits }));
  assert.equal(decision.validated, null);
  assert.equal(decision.gate.pass, false);
  assert.match(checkOf(decision.gate, "validated_request_built").detail ?? "", /style kit sk_fixture did not load/);
});

// --- The stage handler, against PostgreSQL (PGlite): reads the request artifact, writes the validated request artifact. ---

let db: TestDatabase;
const WS = "ws_intake";
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-13T09:00:05.000Z";

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

const ports: IntakePorts = {
  loadKits: async () => fixtureKits(),
  lookupDna: async () => null,
  classify: async () => [blender],
};

function contextFor(inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: null,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_intake_test",
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function storeRequest(request: Record<string, unknown>): Promise<string> {
  const stored = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "production_request",
    body: request,
    createdAt: CREATED,
  });
  return stored.artifactId;
}

/** The intake output of a run, or a test failure if the handler returned anything else. */
async function runIntake(inputArtifactId: string): Promise<{ output: Extract<StageOutput, { stage: "intake" }>; ctx: StageContext }> {
  const ctx = contextFor([inputArtifactId]);
  const result = await createIntakeHandler(ports).run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "intake") assert.fail("expected an intake output");
  return { output: result.output, ctx };
}

test("the handler writes the validated request on a pass, with the request as its parent, and the output passes the job boundary", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest());
  const { output, ctx } = await runIntake(requestArtifactId);

  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((item) => !item.pass)));
  assert.equal(output.budgetReservationId, null, "no reservation on a pass: the pre-flight reservation is open (handlers/STATUS.md)");
  const validatedId = output.artifacts.validated;
  assert.ok(validatedId?.startsWith("art_"), "the validated request artifact is named");

  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: validatedId });
  assert.equal(stored.envelope.type, "validated_request");
  assert.deepEqual(stored.envelope.parentIds, [requestArtifactId]);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("a budget below the minimum writes no validated request, and the gate's reason names the minimum", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest(0.4));
  const { output, ctx } = await runIntake(requestArtifactId);

  assert.equal(output.gate.pass, false);
  assert.deepEqual(output.artifacts, {}, "nothing is written for a refused request");
  const budget = output.gate.checks.find((item) => item.rule === "budget_above_format_minimum");
  assert.match(budget?.detail ?? "", /minimum 0\.52 USD/);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("a stage with no production_request among its inputs is refused, not guessed", async () => {
  await assert.rejects(
    () => createIntakeHandler(ports).run(contextFor([])),
    (error: unknown) => error instanceof Error && /production_request input artifact/.test(error.message),
  );
});
