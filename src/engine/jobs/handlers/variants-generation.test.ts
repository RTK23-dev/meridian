// The variants stage with the generation ports wired (Bible 6.13, 14.1): a hook variant calls the writer once and speaks only its hook beat,
// a product variant re-produces only the product shot, a caption variant queues no generation, the reservation is raised for the variants
// it funds and released at deliver, and a variant over the request budget is refused with its reason. The writer, the voice and the kits
// are recorded: no call reaches a provider.

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
import type { VoicePorts, VoiceOutcome, VoiceRun } from "../../voice/voice.ts";
import type { VoiceRunner } from "../../variants/speak.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { captionVariantMaster } from "../test/caption-variant.ts";
import { createVariantsHandler, type VariantPorts } from "./variants.ts";
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

/** The default plan: the hook beat's shot is a presenter, and the product shot is a generated hero shot. */
function planWithCodedHook(): ScenePlan {
  return {
    ...master,
    shots: master.shots.map((shot) =>
      shot.shotId === SHOT_HOOK
        ? { ...shot, visualType: "kinetic_type", layer: "graphics", source: { kind: "component", component: "kinetic.punchline", props: { text: "Lying." } } }
        : shot,
    ),
  };
}

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
  heroImages: [{ uri: ALT_PRODUCT_FRONT, angle: "front" }],
};

const altPersona: Persona = { ...(personaFixture as Persona), personaId: "persona_variant", voiceId: ALT_VOICE_ID, portraits: [ALT_PORTRAIT, ALT_PORTRAIT, ALT_PORTRAIT] };

const altVoiceKit: VoiceKit = { ...(voiceKitFixture as VoiceKit), voiceId: ALT_VOICE_ID, providerVoiceId: "variant-voice-id" };

const PASS_TRACK: VoiceTrack = voiceTrackFixture as VoiceTrack;

/** Records every voice call. It answers with a passing track, or with not connected when the test asks for it. */
function recordedSpeaker(status: "done" | "not_connected" = "done") {
  const calls: VoiceRun[] = [];
  const runner: VoiceRunner = async (run): Promise<VoiceOutcome> => {
    calls.push(run);
    if (status === "not_connected") return { status: "not_connected", reason: "no speech-to-text key" };
    return { status: "done", gate: { gate: "voice", subjectId: REQ, pass: true, checks: [{ rule: "length_within_max", pass: true }] }, track: PASS_TRACK };
  };
  return { runner, calls };
}

type Harness = {
  ledger: LedgerStore;
  events: EventStore;
  writerRequests: () => number;
  calls: VoiceRun[];
  ports: VariantPorts;
  reservationId: string;
};

/**
 * Fresh ports for one test. The reservation holds `reservedUsd`, in the request's workspace and month. The generation ports are wired
 * unless the test passes `generation: false`; `monthBudgetUsd` is the workspace month, and `undefined` leaves it not connected.
 */
async function harness(options: {
  reservedUsd?: number;
  generation?: boolean;
  monthBudgetUsd?: number;
  speaker?: "done" | "not_connected";
  writerAnswers?: number;
}): Promise<Harness> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation({ ...budgetReservationFixture, workspaceId: WS, requestId: REQ, reservedUsd: options.reservedUsd ?? 5, state: "reserved" });
  const events = memoryEventStore();
  const writerAnswers = Array.from({ length: options.writerAnswers ?? 3 }, () => json(200, HOOK_ANSWER));
  const recorded = gatewayFor(writerAnswers);
  const speaker = recordedSpeaker(options.speaker);
  const generation =
    options.generation === false
      ? undefined
      : {
          roles: () => deps(recorded.gateway, ledger),
          voice: {} as VoicePorts,
          speak: speaker.runner,
          loadProductKit: async ({ sku }: { sku: string }) => (sku === productKitFixture.sku ? (productKitFixture as ProductKit) : sku === altProductKit.sku || sku.startsWith("SKU-FIX-") ? { ...altProductKit, sku } : undefined),
          loadPersona: async ({ personaId }: { personaId: string }) => (personaId === altPersona.personaId ? altPersona : personaId === personaFixture.personaId ? (personaFixture as Persona) : undefined),
          loadVoiceKit: async ({ voiceId }: { voiceId: string }) => (voiceId === ALT_VOICE_ID ? altVoiceKit : voiceId === voiceKitFixture.voiceId ? (voiceKitFixture as VoiceKit) : undefined),
        };
  const ports: VariantPorts = {
    loadMusicTrack: async () => undefined,
    withLedger: (_scope, fn) => fn(ledger),
    events,
    now: () => AT,
    ...(options.monthBudgetUsd === undefined ? {} : { workspaceMonthBudgetUsd: options.monthBudgetUsd }),
    ...(generation === undefined ? {} : { generation }),
  };
  return {
    ledger,
    events,
    writerRequests: () => recorded.requests.length,
    calls: speaker.calls,
    ports,
    reservationId: RESERVATION,
  };
}

async function storeJson(type: "production_request" | "scene_plan" | "edl", stage: string, body: unknown): Promise<string> {
  const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage, type, body, createdAt: CREATED });
  return stored.artifactId;
}

function contextFor(inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "variants",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: RESERVATION,
    inputArtifactIds,
    hints: [],
    details: { masterEdlId: FIXTURE_IDS.edl, variantCount: 1 },
  };
  return { sql: db.sql, jobId: "job_variants_gen", organizationId: WS, requestId: REQ, stage: "variants", subjectId: REQ, attempt: "1", payload, signal: new AbortController().signal };
}

/** Stores the request, the plan and the master, and runs the stage. */
async function runStage(h: Harness, request: ProductionRequest, plan: ScenePlan = master) {
  const requestId = await storeJson("production_request", "intake", request);
  const planId = await storeJson("scene_plan", "plan", plan);
  const masterId = await storeJson("edl", "edit", captionVariantMaster() as EditDecisionList);
  const result = await createVariantsHandler(h.ports).run(contextFor([requestId, planId, masterId]));
  assert.equal(result.kind, "done");
  if (result.kind !== "done") throw new Error("the variants stage did not finish");
  return result.output as Extract<StageOutput, { stage: "variants" }>;
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

test("a hook variant calls the writer once, speaks only its hook beat, and queues no produce_shot when its hook beat has no generated shot", async () => {
  const h = await harness({});
  const output = await runStage(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }), planWithCodedHook());

  assert.equal(h.writerRequests(), 1, "the writer is called once for the one hook line");
  assert.equal(h.calls.length, 1, "the voice is called once");
  assert.deepEqual(h.calls[0]?.request.script.beats.map((beat) => beat.beatId), ["b1"], "only the hook beat is spoken");
  assert.equal(h.calls[0]?.request.script.beats[0]?.text, "Your counter has been lying to you all along.", "the spoken line is the writer's");

  const planned = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "hook:1");
  assert.equal(planned.status, "deferred");
  assert.deepEqual(planned.work, { produceShotIds: [], voiceBeatIds: ["b1"], writerBeatIds: ["b1"] });

  const variantPlan = await planOf(output.artifacts["plan:hook:1"] ?? "");
  assert.deepEqual(variantPlan.shots, planWithCodedHook().shots, "no shot of the variant plan differs from the master's");
  assert.equal(variantPlan.voiceTrackId, PASS_TRACK.voiceTrackId, "the plan names the variant's voice track");
  assert.ok(output.artifacts["voice:hook:1"], "the spoken hook is stored as a voice artifact");

  const entries = await h.ledger.listEntries(RESERVATION);
  assert.equal(entries.length, 1, "one ledger entry: the writer's call");
  assert.equal(entries[0]?.role, "variant_writer");
});

test("a hook variant whose hook beat has a presenter re-produces that shot, and no other", async () => {
  const h = await harness({});
  const output = await runStage(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }));
  const planned = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "hook:1");
  assert.deepEqual(planned.work, { produceShotIds: [SHOT_HOOK], voiceBeatIds: ["b1"], writerBeatIds: ["b1"] });
  const variantPlan = await planOf(output.artifacts["plan:hook:1"] ?? "");
  assert.deepEqual(variantPlan.shots, master.shots, "the presenter keeps its references: a hook re-produces the take, it does not swap the person");
});

test("a product variant re-produces only the product shot: its references change, and every other shot is the master's", async () => {
  const h = await harness({});
  const output = await runStage(h, requestWith({ products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 1 }));

  assert.equal(h.writerRequests(), 0, "a product change writes no words");
  assert.equal(h.calls.length, 0, "a product change speaks nothing");
  const planned = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "product:SKU-FIX-002");
  assert.equal(planned.status, "deferred");
  assert.deepEqual(planned.work, { produceShotIds: [SHOT_PRODUCT], voiceBeatIds: [], writerBeatIds: [] });

  const variantPlan = await planOf(output.artifacts["plan:product:SKU-FIX-002"] ?? "");
  master.shots.forEach((shot, index) => {
    const changed = variantPlan.shots[index];
    if (shot.shotId === SHOT_PRODUCT) {
      assert.deepEqual(changed?.source.kind === "generate" ? changed.source.refs : null, [ALT_PRODUCT_FRONT]);
    } else {
      assert.deepEqual(changed, shot, `shot ${shot.shotId} is unchanged`);
    }
  });
  assert.equal(output.artifacts["voice:product:SKU-FIX-002"], undefined, "no voice is stored for a product change");
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0, "nothing is charged before the produce jobs run");
});

test("a caption variant queues no generation: no writer, no voice, no ledger entry, and its EDL is built", async () => {
  const h = await harness({});
  const output = await runStage(h, requestWith({ captionStyles: ["lower"], maxVariants: 4, budgetUsd: 1 }));
  assert.equal(output.variants.length, 1);
  assert.equal(h.writerRequests(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});

test("the reservation is raised for the variants it funds, and released at deliver to what was committed", async () => {
  const h = await harness({ reservedUsd: 0.1, monthBudgetUsd: 100 });
  await runStage(h, requestWith({ products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 5 }));

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
  await runStage(h, requestWith({ products: ["SKU-FIX-002", "SKU-FIX-003", "SKU-FIX-004"], maxVariants: 4, budgetUsd: 5 }, 1));

  const rows = await h.events.list({ organizationId: WS, requestId: REQ });
  const refused = plannedOf(rows, "product:SKU-FIX-004");
  assert.equal(refused.status, "skipped");
  assert.equal(refused.reason, "over_request_budget");
  assert.equal(plannedOf(rows, "product:SKU-FIX-002").status, "deferred");
  assert.equal(plannedOf(rows, "product:SKU-FIX-003").status, "deferred");
  assert.equal((await h.ledger.getReservation(RESERVATION))?.reservedUsd, 0.9, "the two that fit need no raise of the hold");
});

test("without the workspace month budget, a variant that needs the reservation raised is refused with the reason, and nothing is held", async () => {
  const h = await harness({ reservedUsd: 0.3 });
  await runStage(h, requestWith({ products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 5 }));

  const row = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "product:SKU-FIX-002");
  assert.equal(row.status, "skipped");
  assert.match(String(row.reason), /monthly budget is not connected/);
  assert.equal((await h.ledger.getReservation(RESERVATION))?.reservedUsd, 0.3);
});

test("without the generation ports, a generation variant is deferred with NOT_CONNECTED and charges nothing", async () => {
  const h = await harness({ generation: false });
  await runStage(h, requestWith({ hooks: 1, products: ["SKU-FIX-002"], maxVariants: 4, budgetUsd: 1 }));

  const rows = await h.events.list({ organizationId: WS, requestId: REQ });
  for (const key of ["hook:1", "product:SKU-FIX-002"]) {
    const row = plannedOf(rows, key);
    assert.equal(row.status, "deferred");
    assert.match(String(row.reason), /^NOT_CONNECTED:/);
  }
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});

test("a voice that is not connected stops a hook variant after its writer call, and no plan is stored for it", async () => {
  const h = await harness({ speaker: "not_connected" });
  const output = await runStage(h, requestWith({ hooks: 1, maxVariants: 4, budgetUsd: 1 }), planWithCodedHook());

  assert.equal(h.writerRequests(), 1);
  const row = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "hook:1");
  assert.equal(row.status, "not_built");
  assert.equal(row.reason, "NOT_CONNECTED: no speech-to-text key");
  assert.equal(output.artifacts["plan:hook:1"], undefined);
});

test("a persona variant speaks every beat in the persona's voice, and re-produces the presenter shot with the persona's portrait", async () => {
  const h = await harness({});
  const output = await runStage(h, requestWith({ personas: ["persona_variant"], maxVariants: 4, budgetUsd: 2 }));

  assert.equal(h.writerRequests(), 0, "a persona change writes no words");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.request.script.beats.length, productionRequestFixture.script.beats.length, "every beat is spoken again");
  assert.equal(h.calls[0]?.voice.voiceId, ALT_VOICE_ID);
  const row = plannedOf(await h.events.list({ organizationId: WS, requestId: REQ }), "persona:persona_variant");
  assert.deepEqual(row.work, { produceShotIds: [SHOT_HOOK], voiceBeatIds: ["b1", "b2", "b3", "b4", "b5"], writerBeatIds: [] });
  const variantPlan = await planOf(output.artifacts["plan:persona:persona_variant"] ?? "");
  const hookShot = variantPlan.shots.find((shot) => shot.shotId === SHOT_HOOK);
  assert.deepEqual(hookShot?.source.kind === "generate" ? hookShot.source.refs : null, [ALT_PORTRAIT]);
});

test("a stage with no request or plan among its inputs is refused before any call, and charges nothing", async () => {
  const h = await harness({});
  await assert.rejects(createVariantsHandler(h.ports).run(contextFor([])), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  assert.equal(h.writerRequests(), 0);
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});
