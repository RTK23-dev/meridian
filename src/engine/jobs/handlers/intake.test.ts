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
import { gatewayFor } from "../../claude/test/helpers.ts";
import { recordedAnswer } from "../../plan/test/helpers.ts";
import type { VisualClassification } from "../../review/gates/request.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { scopedLedgerStore } from "../asset-stores-sql.ts";
import { sqlRoleCallJournal } from "../role-call-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import type { WorkspaceBudgetSource, WorkspaceMonthBudget } from "./estimate-reserve.ts";
import {
  createIntakeHandler,
  decideIntake,
  preflightReservationId,
  type IntakeDecisionInput,
  type IntakePorts,
  type ResolvedKits,
} from "./intake.ts";

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

// --- The pure decision (no money, no store). ---

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
  assert.equal(checkOf(decision.gate, "budget_covers_fixed_lines").pass, true);
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

test("a budget below the fixed per-master lines is refused before any hold, and says the fixed cost is part of the minimum", () => {
  const decision = decideIntake(decisionInput({ request: fixtureRequest(0.4) }));
  const fixed = checkOf(decision.gate, "budget_covers_fixed_lines");
  assert.equal(fixed.pass, false);
  assert.match(fixed.detail ?? "", /below the fixed per-master cost of 0\.52 USD, which is part of the minimum/);
});

test("a budget at the exact minimum passes the budget check", () => {
  const decision = decideIntake(decisionInput({ request: fixtureRequest(0.52) }));
  assert.equal(checkOf(decision.gate, "budget_above_format_minimum").pass, true);
  assert.equal(decision.gate.pass, true);
});

test("with neither a persona nor a voice rate, the speech length is unknown: the gate fails, and builds nothing it cannot know", () => {
  const kits = { ...fixtureKits(), persona: undefined, voice: { ...voiceKitFixture, wordsPerMinute: undefined } };
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

test("with no persona on the page, the voice kit's words per minute estimate the speech (Bible 6.1 step 4, contract v2)", () => {
  const request = fixtureRequest() as { page: Record<string, unknown> };
  delete request.page.personaId;
  const decision = decideIntake(decisionInput({ request, kits: { ...fixtureKits(), persona: undefined } }));
  assert.equal(decision.estimatedSpeechMs, 16800);
  assert.equal(decision.gate.pass, true, JSON.stringify(decision.gate.checks.filter((item) => !item.pass)));
});

test("a must with no classification fails the minimum and the must check, and the reason says why", () => {
  const decision = decideIntake(decisionInput({ classifications: [] }));
  assert.equal(decision.gate.pass, false);
  assert.equal(decision.minimum, null);
  assert.match(checkOf(decision.gate, "format_minimum_computed").detail ?? "", /has no classification/);
  assert.equal(checkOf(decision.gate, "every_must_deliverable").pass, false);
});

test("a must the classifier could not run for is named as such, and fails its check", () => {
  const decision = decideIntake(decisionInput({ classifications: [], classifierProblem: "the request classifier is not connected" }));
  assert.equal(decision.gate.pass, false);
  assert.equal(checkOf(decision.gate, "requests_classified").pass, false);
  assert.match(checkOf(decision.gate, "requests_classified").detail ?? "", /not connected/);
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

// --- The stage handler, against PostgreSQL (PGlite): holds the budget, classifies the must on the hold, and writes the artifact. ---

let db: TestDatabase;
const WS = "ws_intake";
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-13T09:00:05.000Z";
const NOW = "2026-10-13T09:00:06.000Z";

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

/** A workspace monthly budget the test sets. */
function monthSource(usd: number): WorkspaceBudgetSource {
  return { monthBudget: async (): Promise<WorkspaceMonthBudget> => ({ status: "known", usd }) };
}

/** The classifier's recorded answer (index 0 is real_product), on the reservation the handler names. One answer per call. */
function classifierPorts(): Pick<IntakePorts, "roleDeps"> {
  const { gateway } = gatewayFor([recordedAnswer("openrouter-request-classifier-ok")]);
  return {
    roleDeps: ({ organizationId, requestId, reservationId }) => ({
      gateway,
      ledger: scopedLedgerStore(db.sql, organizationId, reservationId),
      now: () => NOW,
      journal: sqlRoleCallJournal(db.sql, { organizationId, requestId }),
    }),
  };
}

function portsWith(overrides: Partial<IntakePorts> = {}): IntakePorts {
  return {
    loadKits: async () => fixtureKits(),
    lookupDna: async () => null,
    workspaceBudget: monthSource(100),
    ...classifierPorts(),
    ...overrides,
  };
}

function contextFor(inputArtifactIds: string[], attempt = "1"): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    subjectId: REQ,
    attempt,
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
    attempt,
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
async function runIntake(
  ports: IntakePorts,
  inputArtifactId: string,
  attempt = "1",
): Promise<{ output: Extract<StageOutput, { stage: "intake" }>; ctx: StageContext }> {
  const ctx = contextFor([inputArtifactId], attempt);
  const result = await createIntakeHandler(ports).run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "intake") assert.fail("expected an intake output");
  return { output: result.output, ctx };
}

async function reservationRow(id: string): Promise<{ state: string; reservedUsd: number } | null> {
  const rows = await db.sql<{ state: string; reserved: string }>`
    select state, reserved_usd::text as reserved from engine_reservations where id = ${id}
  `;
  const row = rows[0];
  return row ? { state: row.state, reservedUsd: Number(row.reserved) } : null;
}

async function ledgerCount(reservationId: string): Promise<number> {
  const rows = await db.sql<{ n: number | string }>`select count(*) as n from engine_ledger where reservation_id = ${reservationId}`;
  return Number(rows[0]?.n ?? 0);
}

test("a passing request holds the pre-flight hold, classifies its must on it, and writes the validated request", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest());
  const { output, ctx } = await runIntake(portsWith(), requestArtifactId, "1");
  const holdId = preflightReservationId(REQ, "1");

  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((item) => !item.pass)));
  assert.equal(output.budgetPause, null);
  assert.equal(output.budgetReservationId, holdId, "the request keeps the hold it made");
  assert.deepEqual(await reservationRow(holdId), { state: "reserved", reservedUsd: 0.52 });
  assert.equal(await ledgerCount(holdId), 1, "the classifier's one call is on the hold");

  const validatedId = output.artifacts.validated;
  assert.ok(validatedId?.startsWith("art_"), "the validated request artifact is named");
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: validatedId });
  assert.equal(stored.envelope.type, "validated_request");
  assert.deepEqual(stored.envelope.parentIds, [requestArtifactId]);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("a budget below the fixed per-master lines is refused before any hold: nothing is reserved, and the minimum is named", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest(0.4));
  const { output, ctx } = await runIntake(portsWith(), requestArtifactId, "2");

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.equal(output.budgetPause, null, "a refusal rejects the request; it does not pause it");
  assert.deepEqual(output.artifacts, {}, "nothing is written for a refused request");
  assert.match(checkOf(output.gate, "budget_covers_fixed_lines").detail ?? "", /0\.52 USD/);
  assert.equal(await reservationRow(preflightReservationId(REQ, "2")), null);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("with no monthly budget source the request pauses on budget: nothing is held, and nothing is classified", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest());
  const { output, ctx } = await runIntake(portsWith({ workspaceBudget: undefined }), requestArtifactId, "3");

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.match(output.budgetPause ?? "", /monthly video budget|not connected/);
  assert.equal(await reservationRow(preflightReservationId(REQ, "3")), null);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("a month that the hold would exceed is held with a note, not paused: calls are gated by their line (D12)", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest());
  const { output, ctx } = await runIntake(portsWith({ workspaceBudget: monthSource(0.1) }), requestArtifactId, "4");

  assert.equal(output.budgetPause, null, "a hold above the month is a note, not a pause");
  assert.equal(output.budgetReservationId, preflightReservationId(REQ, "4"));
  assert.deepEqual(await reservationRow(preflightReservationId(REQ, "4")), { state: "reserved", reservedUsd: 0.52 });
  assert.equal(await ledgerCount(preflightReservationId(REQ, "4")), 0, "intake itself makes no paid call");
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("a must request with no classifier wired is refused, and no hold is made (fail closed)", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest());
  const { output } = await runIntake(portsWith({ roleDeps: undefined }), requestArtifactId, "5");

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetPause, null);
  assert.equal(output.budgetReservationId, null);
  assert.match(checkOf(output.gate, "requests_classified").detail ?? "", /classifier is not connected/);
  assert.equal(await reservationRow(preflightReservationId(REQ, "5")), null);
});

test("a must that names a beat the script does not have: the hold is released and the request is rejected", async () => {
  const request = fixtureRequest() as { visualRequests: Array<{ beatId: string }> };
  request.visualRequests[0] = { ...request.visualRequests[0], beatId: "b9" } as { beatId: string };
  const requestArtifactId = await storeRequest(request);
  const { output } = await runIntake(portsWith(), requestArtifactId, "6");
  const holdId = preflightReservationId(REQ, "6");

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null, "a rejected request keeps no hold");
  assert.equal(output.budgetPause, null);
  assert.match(checkOf(output.gate, "every_must_deliverable").detail ?? "", /beat b9/);
  const released = await reservationRow(holdId);
  assert.ok(released, "the hold was made, then released");
  assert.notEqual(released.state, "reserved");
  assert.ok(released.reservedUsd < 0.52, "the released hold shrinks to what was committed (the classifier call)");
});

test("the same job attempt makes one hold: a retry reuses it and stores no second reservation", async () => {
  const requestArtifactId = await storeRequest(fixtureRequest());
  const first = await runIntake(portsWith(), requestArtifactId, "7");
  const second = await runIntake(portsWith(), requestArtifactId, "7");
  assert.equal(second.output.budgetReservationId, first.output.budgetReservationId);
  const rows = await db.sql<{ n: number | string }>`select count(*) as n from engine_reservations where id = ${preflightReservationId(REQ, "7")}`;
  assert.equal(Number(rows[0]?.n ?? 0), 1);
});

test("a stage with no production_request among its inputs is refused, not guessed", async () => {
  await assert.rejects(
    () => createIntakeHandler(portsWith()).run(contextFor([])),
    (error: unknown) => error instanceof Error && /production_request input artifact/.test(error.message),
  );
});
