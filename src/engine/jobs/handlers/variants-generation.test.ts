// The variants stage with the generation ports wired (Bible 6.13, 14.1), in its phases. The request phase funds the variants that can run and
// hands over their work list. Each phase job then makes one call: the writer (a hook or language line, or a product's prompts), the voice
// (the variant's full script) and the plan (the master's plan with the change). A hook variant calls the writer once and speaks every beat;
// a product variant rewrites only its product shots' prompts and speaks nothing; a caption variant queues no generation; a variant over the
// request budget is refused with its reason; without a connected model a generation variant is NOT_CONNECTED with no call. The writer, the
// voice and the kits are recorded: no call reaches a provider.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { deps, gatewayFor, json } from "../../claude/test/helpers.ts";
import { releaseReservation } from "../../budget/reconcile.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { EngineError, type EditDecisionList, type Persona, type ProductKit, type ProductionRequest, type ScenePlan, type VariantMatrix, type VoiceKit, type VoiceTrack } from "../../contracts/index.ts";
import {
  budgetReservationFixture,
  FIXTURE_IDS,
  personaFixture,
  productKitFixture,
  productionRequestFixture,
  scenePlanFixture,
  voiceKitFixture,
  voiceTrackFixture,
} from "../../contracts/fixtures/index.ts";
import { memoryEventStore, type EventStore, type EventRecord } from "../../events/store.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { VoiceOutcome, VoiceRun } from "../../voice/voice.ts";
import type { VoiceRunner } from "../../variants/speak.ts";
import { generationWorkOf, variantSubjectOf, type VariantPhase, type VariantWorkItem } from "../../variants/work.ts";
import { expandVariants } from "../../variants/expand.ts";
import type { EnginePayload, StageContext, StageOutput, VariantPlanOutcome, VariantVoiceOutcome, VariantWriterOutcome } from "../types.ts";
import { captionVariantMaster } from "../test/caption-variant.ts";
import { assetSpecFor, takeIdFor } from "./produce-shot.ts";
import { createVariantsHandler, type VariantConnection, type VariantPorts } from "./variants.ts";
import { budgets } from "../../config/budgets.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_ANSWER = JSON.parse(readFileSync(join(HERE, "..", "..", "variants", "test", "fixtures", "openrouter-variant-writer-hook.json"), "utf8")) as unknown;

const WS = "ws_variants_gen";
const REQ = FIXTURE_IDS.request;
const RESERVATION = FIXTURE_IDS.reservation;
const CREATED = "2026-10-13T09:00:05.000Z";
const AT = "2026-10-13T09:30:00.000Z";
const SHOT_HOOK = FIXTURE_IDS.shot1;
const SHOT_PRODUCT = FIXTURE_IDS.shot3;

const ALT_PRODUCT_FRONT = "store://products/variant-blender-front.png";
const ALT_PORTRAIT = "store://personas/variant/portrait-1.png";
const ALT_VOICE_ID = "voice_variant";
const NOT_CONNECTED_WRITER = "NOT_CONNECTED: the writer's route has no key for this workspace";
const NOT_CONNECTED_VOICE = "NOT_CONNECTED: the voice stage's ports are not wired";
const CONNECTED: VariantConnection = { writer: null, voice: null };

let db: TestDatabase;

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

const master = scenePlanFixture as ScenePlan;

function requestWith(matrix: VariantMatrix, budgetUsd = 4): ProductionRequest {
  const request = structuredClone(productionRequestFixture as ProductionRequest);
  request.constraints = { ...request.constraints, budgetUsd };
  request.output = { master: true, variants: matrix };
  return request;
}

const altProductKit: ProductKit = {
  ...(productKitFixture as ProductKit),
  productKitId: "pk_variant",
  sku: "SKU-FIX-002",
  name: "Corner Toaster",
  heroImages: [{ uri: ALT_PRODUCT_FRONT, angle: "front" }],
};

const altPersona: Persona = { ...(personaFixture as Persona), personaId: "persona_variant", voiceId: ALT_VOICE_ID, portraits: [ALT_PORTRAIT, ALT_PORTRAIT, ALT_PORTRAIT] };

const altVoiceKit: VoiceKit = { ...(voiceKitFixture as VoiceKit), voiceId: ALT_VOICE_ID, providerVoiceId: "variant-voice-id" };

const PASS_TRACK: VoiceTrack = voiceTrackFixture as VoiceTrack;

/** A chat answer in the shape the gateway parses, whose content is the given object. */
function chat(content: unknown) {
  return json(200, {
    id: "gen-recorded-variant-writer-0002",
    model: "recorded/variant-writer",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 1180, completion_tokens: 46, total_tokens: 1226, cost: 0.0021 },
  });
}

/** Records every voice call. It answers with a passing track, or not connected when the test asks for it. */
function recordedSpeaker(status: "done" | "not_connected" = "done") {
  const calls: VoiceRun[] = [];
  const runner: VoiceRunner = async (run): Promise<VoiceOutcome> => {
    calls.push(run);
    if (status === "not_connected") return { status: "not_connected", reason: "no speech-to-text key" };
    return { status: "done", gate: { gate: "voice", subjectId: run.subjectId, pass: true, checks: [{ rule: "length_within_max", pass: true }] }, track: PASS_TRACK };
  };
  return { runner, calls };
}

type Harness = {
  ledger: LedgerStore;
  events: EventStore;
  writerRequests: () => number;
  calls: VoiceRun[];
  ports: VariantPorts;
  setConnection: (connection: VariantConnection) => void;
};

/**
 * Fresh ports for one test. The reservation holds `reservedUsd`. The generation ports are wired unless the test passes `generation: false`;
 * `monthBudgetUsd` is the workspace month, and `undefined` leaves it not connected.
 */
async function harness(options: {
  reservedUsd?: number;
  generation?: boolean;
  monthBudgetUsd?: number;
  speaker?: "done" | "not_connected";
  writerAnswers?: ReturnType<typeof json>[];
}): Promise<Harness> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation({ ...budgetReservationFixture, workspaceId: WS, requestId: REQ, reservedUsd: options.reservedUsd ?? 5, state: "reserved" });
  const events = memoryEventStore();
  const answers = options.writerAnswers ?? [json(200, HOOK_ANSWER), json(200, HOOK_ANSWER), json(200, HOOK_ANSWER)];
  const recorded = gatewayFor(answers);
  const speaker = recordedSpeaker(options.speaker);
  let connection: VariantConnection = CONNECTED;
  const generation =
    options.generation === false
      ? undefined
      : {
          roles: () => deps(recorded.gateway, ledger),
          connection: async () => connection,
          speak: speaker.runner,
          loadProductKit: async ({ sku }: { sku: string }) =>
            sku === productKitFixture.sku ? (productKitFixture as ProductKit) : sku === altProductKit.sku || sku.startsWith("SKU-FIX-") ? { ...altProductKit, sku } : undefined,
          loadPersona: async ({ personaId }: { personaId: string }) =>
            personaId === altPersona.personaId ? altPersona : personaId === personaFixture.personaId ? (personaFixture as Persona) : undefined,
          loadVoiceKit: async ({ voiceId }: { voiceId: string }) =>
            voiceId === ALT_VOICE_ID ? altVoiceKit : voiceId === voiceKitFixture.voiceId ? (voiceKitFixture as VoiceKit) : undefined,
        };
  const ports: VariantPorts = {
    loadMusicTrack: async () => undefined,
    withLedger: (_scope, fn) => fn(ledger),
    events,
    now: () => AT,
    workspaceMonthBudget: async () => options.monthBudgetUsd ?? null,
    ...(generation === undefined ? {} : { generation }),
  };
  return {
    ledger,
    events,
    writerRequests: () => recorded.requests.length,
    calls: speaker.calls,
    ports,
    setConnection: (next) => {
      connection = next;
    },
  };
}

async function storeJson(type: "production_request" | "scene_plan" | "edl", stage: string, body: unknown): Promise<string> {
  const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage, type, body, createdAt: CREATED });
  return stored.artifactId;
}

function requestPhaseContext(inputArtifactIds: string[], reservationId: string | null = RESERVATION): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "variants",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds,
    hints: [],
    details: { masterEdlId: FIXTURE_IDS.edl, variantCount: 1 },
  };
  return { sql: db.sql, jobId: "job_variants_gen", organizationId: WS, requestId: REQ, stage: "variants", subjectId: REQ, attempt: "1", payload, signal: new AbortController().signal };
}

/** A phase job's context: its work item, its inputs (the request and the master's plan), and the data the orchestrator carries. */
function phaseContext(inputArtifactIds: string[], item: VariantWorkItem, phase: VariantPhase, carried: { text?: unknown; voiceTrackId?: string | null } = {}): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "variants",
    subjectId: item.subject,
    attempt: "1",
    priority: "normal",
    budgetReservationId: RESERVATION,
    inputArtifactIds,
    hints: [],
    details: { phase, variantKey: item.key, masterEdlId: FIXTURE_IDS.edl, work: item, text: carried.text ?? null, voiceTrackId: carried.voiceTrackId ?? null },
  };
  return { sql: db.sql, jobId: `job_variant_${phase}`, organizationId: WS, requestId: REQ, stage: "variants", subjectId: item.subject, attempt: "1", payload, signal: new AbortController().signal };
}

type RequestOutput = Extract<StageOutput, { stage: "variants"; phase: "request" }>;

/** Stores the request, the plan and the master, and runs the request phase. */
async function runRequestPhase(h: Harness, request: ProductionRequest, plan: ScenePlan = master): Promise<{ output: RequestOutput; inputIds: string[] }> {
  const requestId = await storeJson("production_request", "intake", request);
  const planId = await storeJson("scene_plan", "plan", plan);
  const masterId = await storeJson("edl", "edit", captionVariantMaster() as EditDecisionList);
  const result = await createVariantsHandler(h.ports).run(requestPhaseContext([requestId, planId, masterId]));
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "variants" || result.output.phase !== "request") throw new Error("the request phase did not finish");
  return { output: result.output, inputIds: [requestId, planId] };
}

function workOf(output: RequestOutput, key: string): VariantWorkItem {
  const item = output.work.find((candidate) => candidate.key === key);
  assert.ok(item, `the work list holds ${key}`);
  return item;
}

async function planOf(artifactId: string): Promise<ScenePlan> {
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId });
  return stored.envelope.body as ScenePlan;
}

function plannedOf(rows: EventRecord[], key: string): Record<string, unknown> {
  const row = rows.find((candidate) => candidate.kind === "variant.planned" && (candidate.body as { key: string }).key === key);
  assert.ok(row, `a variant.planned event for ${key}`);
  return row.body as Record<string, unknown>;
}

/** Runs the writer phase and returns its outcome. */
async function runWriter(h: Harness, inputIds: string[], item: VariantWorkItem): Promise<VariantWriterOutcome> {
  const result = await createVariantsHandler(h.ports).run(phaseContext(inputIds, item, "writer"));
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "variants" || result.output.phase !== "writer") throw new Error("the writer phase did not finish");
  return result.output.outcome;
}

async function runVoice(h: Harness, inputIds: string[], item: VariantWorkItem, text: unknown): Promise<{ outcome: VariantVoiceOutcome; artifacts: Record<string, string> }> {
  const result = await createVariantsHandler(h.ports).run(phaseContext(inputIds, item, "voice", { text }));
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "variants" || result.output.phase !== "voice") throw new Error("the voice phase did not finish");
  return { outcome: result.output.outcome, artifacts: result.output.artifacts };
}

async function runPlan(h: Harness, inputIds: string[], item: VariantWorkItem, carried: { text?: unknown; voiceTrackId?: string | null }): Promise<VariantPlanOutcome & { artifacts: Record<string, string> }> {
  const result = await createVariantsHandler(h.ports).run(phaseContext(inputIds, item, "plan", carried));
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "variants" || result.output.phase !== "plan") throw new Error("the plan phase did not finish");
  return { ...result.output.outcome, artifacts: result.output.artifacts };
}

test("a hook variant calls the writer once for its hook line, speaks every beat of its script, and plans its hook shot only", async () => {
  const h = await harness({});
  const { output, inputIds } = await runRequestPhase(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }));
  const item = workOf(output, "hook:1");
  assert.equal(h.writerRequests(), 0, "the request phase calls nothing");

  const writer = await runWriter(h, inputIds, item);
  assert.equal(writer.status, "done");
  assert.equal(h.writerRequests(), 1, "the writer is called once for the one hook line");
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 1, "one ledger entry: the writer's call");
  assert.equal((await h.ledger.listEntries(RESERVATION))[0]?.role, "variant_writer");
  assert.equal((await h.ledger.listEntries(RESERVATION))[0]?.promptVersion, "variant_writer@2");
  if (writer.status !== "done") return;

  const { outcome, artifacts } = await runVoice(h, inputIds, item, writer.text);
  assert.equal(outcome.status, "done");
  assert.equal(h.calls.length, 1, "the voice is called once");
  assert.deepEqual(h.calls[0]?.request.script.beats.map((beat) => beat.beatId), ["b1", "b2", "b3", "b4", "b5"], "every beat is spoken: a full re-speak");
  assert.equal(h.calls[0]?.request.script.beats[0]?.text, writer.text.kind === "lines" ? writer.text.lines[0]?.text : "", "the hook beat is the writer's line");
  assert.equal(h.calls[0]?.subjectId, item.subject, "the gate names the variant");
  assert.ok(artifacts[`voice:${item.key}`], "the spoken track is stored as the variant's voice");

  const plan = await runPlan(h, inputIds, item, { text: writer.text, voiceTrackId: PASS_TRACK.voiceTrackId });
  assert.equal(plan.status, "done");
  if (plan.status !== "done") return;
  assert.deepEqual(plan.produce.map((shot) => shot.shotId), [SHOT_HOOK], "its produce list is the hook shot");
  const variantPlan = await planOf(plan.artifacts[`plan:${item.key}`] ?? "");
  assert.deepEqual(variantPlan.shots, master.shots, "a hook keeps every shot's references and prompt: the take is made again, the person is not swapped");
  assert.equal(variantPlan.voiceTrackId, PASS_TRACK.voiceTrackId, "the plan names the variant's voice track");
  assert.equal(plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "hook:1").status, "deferred", "planned: its takes are queued");
});

test("a hook variant whose hook beat has no generated shot plans no produce", async () => {
  const h = await harness({});
  const coded = structuredClone(master);
  coded.shots = coded.shots.map((shot) =>
    shot.shotId === SHOT_HOOK ? { ...shot, visualType: "kinetic_type", layer: "graphics", source: { kind: "component", component: "kinetic.punchline", props: { text: "Lying." } } } : shot,
  );
  const { output, inputIds } = await runRequestPhase(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }), coded);
  const item = workOf(output, "hook:1");
  assert.deepEqual(item.produceShotIds, [], "a coded hook beat has no generated shot");
  const writer = await runWriter(h, inputIds, item);
  if (writer.status !== "done") throw new Error("the writer did not answer");
  await runVoice(h, inputIds, item, writer.text);
  const plan = await runPlan(h, inputIds, item, { text: writer.text, voiceTrackId: PASS_TRACK.voiceTrackId });
  assert.equal(plan.status, "done");
  if (plan.status === "done") assert.deepEqual(plan.produce, []);
});

test("a product variant rewrites the prompts of its product shots only, speaks nothing, and plans the new reference", async () => {
  const answer = chat({ prompts: [{ shotId: SHOT_PRODUCT, text: "Slow push-in on a clean kitchen counter, the Corner Toaster in the centre, no text in frame." }] });
  const h = await harness({ writerAnswers: [answer] });
  const { output, inputIds } = await runRequestPhase(h, requestWith({ products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 1 }));
  const item = workOf(output, "product:SKU-FIX-002");
  assert.deepEqual(item.produceShotIds, [SHOT_PRODUCT]);
  assert.equal(h.writerRequests(), 0, "the request phase writes nothing");

  const writer = await runWriter(h, inputIds, item);
  assert.equal(writer.status, "done", writer.status === "not_built" ? writer.reason : "");
  assert.equal(h.writerRequests(), 1, "one writer call for the product's prompts");
  if (writer.status !== "done") return;
  assert.deepEqual(writer.text, { kind: "prompts", prompts: [{ shotId: SHOT_PRODUCT, text: "Slow push-in on a clean kitchen counter, the Corner Toaster in the centre, no text in frame." }] });
  assert.equal(h.calls.length, 0, "a product change speaks nothing");

  const plan = await runPlan(h, inputIds, item, { text: writer.text, voiceTrackId: null });
  assert.equal(plan.status, "done");
  if (plan.status !== "done") return;
  const variantPlan = await planOf(plan.artifacts[`plan:${item.key}`] ?? "");
  master.shots.forEach((shot, index) => {
    const changed = variantPlan.shots[index];
    if (shot.shotId === SHOT_PRODUCT) {
      assert.deepEqual(changed?.source.kind === "generate" ? [changed.source.refs, changed.source.prompt] : null, [[ALT_PRODUCT_FRONT], "Slow push-in on a clean kitchen counter, the Corner Toaster in the centre, no text in frame."]);
    } else {
      assert.deepEqual(changed, shot, `shot ${shot.shotId} is unchanged`);
    }
  });
  assert.deepEqual(plan.produce.map((shot) => shot.shotId), [SHOT_PRODUCT]);
  assert.equal(plan.artifacts[`voice:${item.key}`], undefined, "no voice is stored for a product change");
});

test("a caption variant queues no generation: no work, no writer, no voice, and no ledger entry", async () => {
  const h = await harness({});
  const { output } = await runRequestPhase(h, requestWith({ captionStyles: ["lower"], maxVariants: 4, budgetUsd: 1 }));
  assert.equal(output.variants.length, 1);
  assert.deepEqual(output.work, []);
  assert.equal(h.writerRequests(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});

test("the reservation is raised for the variants it funds at the request phase, and released at deliver to what was committed", async () => {
  const h = await harness({ reservedUsd: 0.1, monthBudgetUsd: 100 });
  await runRequestPhase(h, requestWith({ products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 5 }));

  const raised = await h.ledger.getReservation(RESERVATION);
  assert.ok(raised);
  assert.equal(raised.reservedUsd, budgets.variantCostUsd.productSwap.high, "held at the product swap's estimate, raised from 0.1");
  assert.equal(raised.state, "reserved");

  const released = await releaseReservation(h.ledger, RESERVATION);
  assert.equal(released.reservation.state, "released");
  assert.equal(released.reservation.reservedUsd, 0, "nothing was committed, so the variant money goes back");
  assert.equal(released.releasedUsd, budgets.variantCostUsd.productSwap.high);
});

test("a variant over the request budget is refused with the reason, and the variants that fit are funded", async () => {
  const h = await harness({ reservedUsd: 0.9, monthBudgetUsd: 100 });
  const { output } = await runRequestPhase(h, requestWith({ products: ["SKU-FIX-002", "SKU-FIX-003", "SKU-FIX-004"], maxVariants: 4, budgetUsd: 5 }, 1));

  const rows = await h.events.list({ organizationId: WS, requestId: REQ });
  const refused = plannedOf(rows, "product:SKU-FIX-004");
  assert.equal(refused.status, "skipped");
  assert.equal(refused.reason, "over_request_budget");
  // The two that fit are funded and queued: their outcome is the event of their plan phase, not of the request phase.
  assert.deepEqual(output.work.map((item) => item.key), ["product:SKU-FIX-002", "product:SKU-FIX-003"]);
  assert.equal((await h.ledger.getReservation(RESERVATION))?.reservedUsd, 0.9, "the two that fit need no raise of the hold");
});

test("without the workspace month budget, a variant that needs the reservation raised is refused with the reason, and nothing is held", async () => {
  const h = await harness({ reservedUsd: 0.3 });
  await runRequestPhase(h, requestWith({ products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 5 }));

  const row = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "product:SKU-FIX-002");
  assert.equal(row.status, "skipped");
  assert.match(String(row.reason), /monthly budget is not connected/);
  assert.equal((await h.ledger.getReservation(RESERVATION))?.reservedUsd, 0.3);
});

test("without a connected model, a generation variant is NOT_CONNECTED at the request phase: no work, no funding and no call", async () => {
  const h = await harness({ reservedUsd: 0.3, monthBudgetUsd: 100 });
  h.setConnection({ writer: NOT_CONNECTED_WRITER, voice: NOT_CONNECTED_VOICE });
  const { output } = await runRequestPhase(h, requestWith({ hooks: 1, products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 5 }));

  assert.deepEqual(output.work, [], "nothing is queued for a variant whose model is not connected");
  const rows = await h.events.list({ organizationId: WS, requestId: REQ });
  assert.equal(plannedOf(rows, "hook:1").status, "deferred");
  assert.equal(plannedOf(rows, "hook:1").reason, NOT_CONNECTED_WRITER, "the hook needs the writer first, so its reason is the writer's");
  assert.equal(plannedOf(rows, "product:SKU-FIX-002").reason, NOT_CONNECTED_WRITER, "the product's reason is the writer's");
  assert.equal(h.writerRequests(), 0);
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0, "nothing is charged");
  assert.equal((await h.ledger.getReservation(RESERVATION))?.reservedUsd, 0.3, "nothing is funded");
});

test("without the generation ports at all, every generation variant is deferred with NOT_CONNECTED", async () => {
  const h = await harness({ generation: false });
  await runRequestPhase(h, requestWith({ hooks: 1, products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 1 }));
  const rows = await h.events.list({ organizationId: WS, requestId: REQ });
  for (const key of ["hook:1", "product:SKU-FIX-002"]) {
    const row = plannedOf(rows, key);
    assert.equal(row.status, "deferred");
    assert.match(String(row.reason), /^NOT_CONNECTED:/);
  }
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});

test("a writer that gives no usable lines fails its variant alone: no voice and no plan are made for it", async () => {
  const bad = chat({ lines: [{ beatId: "b9", text: "Not a beat." }] });
  const h = await harness({ writerAnswers: [bad, bad] });
  const { output, inputIds } = await runRequestPhase(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }));
  const item = workOf(output, "hook:1");
  const writer = await runWriter(h, inputIds, item);
  assert.equal(writer.status, "not_built");
  if (writer.status === "not_built") assert.match(writer.reason, /did not match its contract/);
  assert.equal(h.calls.length, 0, "no voice call");
  const row = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "hook:1");
  assert.equal(row.status, "not_built");
});

test("a voice that is not connected stops the hook after its writer call: the variant is not built, and no plan is stored", async () => {
  const h = await harness({ speaker: "not_connected" });
  const { output, inputIds } = await runRequestPhase(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }));
  const item = workOf(output, "hook:1");
  const writer = await runWriter(h, inputIds, item);
  if (writer.status !== "done") throw new Error("the writer did not answer");
  const { outcome, artifacts } = await runVoice(h, inputIds, item, writer.text);
  assert.equal(outcome.status, "not_built");
  if (outcome.status === "not_built") assert.equal(outcome.reason, "NOT_CONNECTED: no speech-to-text key");
  assert.equal(artifacts[`plan:${item.key}`], undefined);
  const row = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "hook:1");
  assert.equal(row.status, "not_built");
  assert.equal(row.reason, "NOT_CONNECTED: no speech-to-text key");
});

test("a persona variant speaks every beat in the persona's voice with no writer call, and plans the presenter shot with the persona's portrait", async () => {
  const h = await harness({});
  const { output, inputIds } = await runRequestPhase(h, requestWith({ personas: ["persona_variant"], maxVariants: 4, budgetUsd: 2 }));
  const item = workOf(output, "persona:persona_variant");
  assert.deepEqual(item.produceShotIds, [SHOT_HOOK]);
  assert.equal(item.writer, null, "a persona change writes no words");
  assert.equal(h.writerRequests(), 0);

  const { outcome } = await runVoice(h, inputIds, item, null);
  assert.equal(outcome.status, "done");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.request.script.beats.length, productionRequestFixture.script.beats.length, "every beat is spoken again");
  assert.equal(h.calls[0]?.voice.voiceId, ALT_VOICE_ID, "in the persona's voice");

  const plan = await runPlan(h, inputIds, item, { text: null, voiceTrackId: PASS_TRACK.voiceTrackId });
  assert.equal(plan.status, "done");
  if (plan.status !== "done") return;
  const variantPlan = await planOf(plan.artifacts[`plan:${item.key}`] ?? "");
  const hookShot = variantPlan.shots.find((shot) => shot.shotId === SHOT_HOOK);
  assert.deepEqual(hookShot?.source.kind === "generate" ? hookShot.source.refs : null, [ALT_PORTRAIT]);
});

test("a stage with no request or plan among its inputs is refused before any call, and charges nothing", async () => {
  const h = await harness({});
  await assert.rejects(createVariantsHandler(h.ports).run(requestPhaseContext([])), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  assert.equal(h.writerRequests(), 0);
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});

test("a variant's produce job names its own take and spec: neither is the master's, even for the same shot and attempt", () => {
  const shot = master.shots.find((candidate) => candidate.shotId === SHOT_HOOK);
  assert.ok(shot?.source.kind === "generate", "the hook shot is generated");
  if (shot?.source.kind !== "generate") return;
  const variantSubject = `${variantSubjectOf("hook:1")}.${SHOT_HOOK}`;
  assert.notEqual(takeIdFor(REQ, variantSubject, 1), takeIdFor(REQ, SHOT_HOOK, 1), "the take is the variant's own");
  const masterSpec = assetSpecFor({ requestId: REQ, shot, attempt: 1, hints: [] });
  const variantSpec = assetSpecFor({ requestId: REQ, shot, attempt: 1, hints: [], subject: variantSubject });
  assert.notEqual(variantSpec.specId, masterSpec.specId);
  assert.notEqual(variantSpec.seed, masterSpec.seed, "the cache entry of the master's call is not the variant's");
});

test("the work item's subject is the one the orchestrator queues, and the generation work is the full re-speak", () => {
  const variants = expandVariants({
    request: requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }),
    plan: master,
    master: captionVariantMaster() as EditDecisionList,
    matrix: { hooks: 1, maxVariants: 4, budgetUsd: 1 },
    tracks: new Map(),
    headroomUsd: 1,
  }).planned;
  const item = variants[0] ? generationWorkOf(variants[0], requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 })) : null;
  assert.equal(item?.subject, variantSubjectOf("hook:1"));
  assert.equal(item?.voiceBeatIds.length, 5);
});
