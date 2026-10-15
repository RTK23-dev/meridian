import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { EngineError, edlSchema, type EditDecisionList, type ProductionRequest, type VariantMatrix } from "../../contracts/index.ts";
import {
  budgetReservationFixture,
  FIXTURE_IDS,
  productionRequestFixture,
  scenePlanFixture,
  fixtureId,
} from "../../contracts/fixtures/index.ts";
import { memoryEventStore, type EventStore } from "../../events/store.ts";
import type { EventRecord } from "../../events/store.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { VariantMusicTrack } from "../../variants/expand.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createVariantsHandler, type VariantPorts } from "./variants.ts";
import { captionVariantMaster } from "../test/caption-variant.ts";
import { checkControl, diffEdl, withCaptionBand } from "../../variants/diff.ts";

const WS = "ws_variants";
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-13T09:00:05.000Z";
const AT = "2026-10-13T09:30:00.000Z";
const RESERVATION = FIXTURE_IDS.reservation;

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

function requestWith(matrix: VariantMatrix): ProductionRequest {
  return { ...(productionRequestFixture as ProductionRequest), output: { master: true, variants: matrix } };
}

function track(index: number): VariantMusicTrack {
  return { trackId: `trk_${index}`, uri: `store://music/track-${index}.wav`, durationMs: 60_000 };
}

type Harness = {
  ledger: LedgerStore;
  events: EventStore;
  ports: VariantPorts;
  storeMaster: (edl: EditDecisionList) => Promise<string>;
  storeRequest: (request: ProductionRequest) => Promise<string>;
  storePlan: () => Promise<string>;
};

/** Fresh ports for one test. The reservation is held at reservedUsd, unless the test pauses it. */
async function harness(options: { reservedUsd?: number; paused?: boolean; tracks?: Map<string, VariantMusicTrack> } = {}): Promise<Harness> {
  const ledger = memoryLedgerStore();
  const reservation = {
    ...budgetReservationFixture,
    workspaceId: WS,
    reservedUsd: options.reservedUsd ?? 5,
    state: options.paused ? ("paused" as const) : ("reserved" as const),
    ...(options.paused ? { pausedReason: "the test paused this reservation" } : {}),
  };
  await ledger.createReservation(reservation);
  const events = memoryEventStore();
  const tracks = options.tracks ?? new Map<string, VariantMusicTrack>();
  const ports: VariantPorts = {
    loadMusicTrack: async ({ trackId }) => tracks.get(trackId),
    withLedger: (_scope, fn) => fn(ledger),
    events,
    now: () => AT,
  };
  return {
    ledger,
    events,
    ports,
    storeMaster: (edl) => writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: edl, createdAt: CREATED }).then((stored) => stored.artifactId),
    storeRequest: (request) =>
      writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "intake", type: "production_request", body: request, createdAt: CREATED }).then((stored) => stored.artifactId),
    storePlan: () =>
      writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "plan", type: "scene_plan", body: scenePlanFixture, createdAt: CREATED }).then((stored) => stored.artifactId),
  };
}

function contextFor(inputArtifactIds: string[], options: { masterEdlId?: string; reservationId?: string | null } = {}): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "variants",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: options.reservationId === undefined ? RESERVATION : options.reservationId,
    inputArtifactIds,
    hints: [],
    details: { masterEdlId: options.masterEdlId ?? FIXTURE_IDS.edl, variantCount: 1 },
  };
  return {
    sql: db.sql,
    jobId: "job_variants_1",
    organizationId: WS,
    requestId: REQ,
    stage: "variants",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

/** The variants output, narrowed: the stage is asserted, so the union is not read as if every stage had variants. */
function variantsOf(output: StageOutput): { stage: "variants"; artifacts: Record<string, string>; variants: { edlId: string }[] } {
  assert.equal(output.stage, "variants");
  if (output.stage !== "variants") throw new Error("the output is not a variants output");
  return output;
}

function eventsOf(rows: EventRecord[], kind: string): EventRecord[] {
  return rows.filter((row) => row.kind === kind);
}

test("a caption-only variant is built from the master with no generation: no ledger entry, and one EDL that names the master", async () => {
  const h = await harness();
  const requestId = await h.storeRequest(requestWith({ captionStyles: ["lower"], maxVariants: 4, budgetUsd: 1 }));
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const handler = createVariantsHandler(h.ports);
  const result = await handler.run(contextFor([requestId, planId, masterId]));

  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.equal(result.output.stage, "variants");
  assert.equal(variantsOf(result.output).variants.length, 1, "the lower band is a real change on the captions after the presenter");
  const [variant] = variantsOf(result.output).variants;
  assert.ok(variant !== undefined);
  assert.equal(validateStageOutput(result.output, contextFor([]).payload).stage, "variants");

  const edlArtifactId = result.output.artifacts[`edl:${variant.edlId}`];
  assert.ok(edlArtifactId, "the variant EDL is an artifact under its slot");
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: edlArtifactId });
  const body = edlSchema.parse(stored.envelope.body);
  assert.equal(body.variantOf, FIXTURE_IDS.edl);
  assert.equal(body.requestId, REQ);
  assert.deepEqual(stored.envelope.parentIds, [masterId, requestId, planId]);

  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0, "no call was made, so nothing was charged");
  const planned = eventsOf(await h.events.list({ organizationId: WS, requestId: REQ }), "variant.planned");
  assert.equal(planned.length, 1);
  assert.equal((planned[0]?.body as { status: string }).status, "built");
  assert.deepEqual((planned[0]?.body as { work: unknown }).work, { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] });
});

test("the caption fixture is a real caption change: the band moves the caption after the presenter, keeps the presenter's, and changes only captions", () => {
  const master = captionVariantMaster();
  const changed = withCaptionBand(master, "lower");
  assert.equal(changed.changedClips, 1, "the caption after the presenter moves to the lower band");
  assert.equal(changed.keptClips, 1, "the caption over the presenter keeps its band (the face rule, Bible 8.2 step 9)");
  const changes = diffEdl(master, changed.edl);
  assert.ok(changes.length > 0, "the variant is not a no-op");
  assert.ok(changes.every((change) => change.surface === "captions"), "only the captions surface changes");
  assert.equal(checkControl("caption", changes, new Set<string>()).pass, true);
});

test("twenty variants from one master are planned with no generation for caption and music, and all twenty are built", async () => {
  const tracks = new Map(Array.from({ length: 18 }, (_, index) => [`trk_${index + 1}`, track(index + 1)] as const));
  const h = await harness({ reservedUsd: 5, tracks });
  const requestId = await h.storeRequest(
    requestWith({
      captionStyles: ["middle", "lower"],
      music: Array.from({ length: 18 }, (_, index) => `trk_${index + 1}`),
      maxVariants: 20,
      budgetUsd: 5,
    }),
  );
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const result = await createVariantsHandler(h.ports).run(contextFor([requestId, planId, masterId]));

  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.equal(variantsOf(result.output).variants.length, 20);
  assert.equal(Object.keys(result.output.artifacts).length, 20);
  const rows = await h.events.list({ organizationId: WS, requestId: REQ });
  const planned = eventsOf(rows, "variant.planned");
  assert.equal(planned.length, 20);
  for (const event of planned) {
    const body = event.body as { status: string; work: { produceShotIds: string[]; voiceBeatIds: string[]; writerBeatIds: string[] } };
    assert.equal(body.status, "built");
    assert.deepEqual(body.work, { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] }, "no generation for a caption or music variant");
  }
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0, "no paid call was made");
});

test("a hook variant is deferred, not built: the stage reports the shots it would regenerate and writes no EDL for it", async () => {
  const h = await harness();
  const requestId = await h.storeRequest(requestWith({ hooks: 1, maxVariants: 2, budgetUsd: 1 }));
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const result = await createVariantsHandler(h.ports).run(contextFor([requestId, planId, masterId]));
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.deepEqual(variantsOf(result.output).variants, []);
  assert.deepEqual(result.output.artifacts, {});
  const [deferred] = eventsOf(await h.events.list({ organizationId: WS, requestId: REQ }), "variant.planned");
  const body = deferred?.body as { status: string; work: { produceShotIds: string[]; voiceBeatIds: string[] } };
  assert.equal(body.status, "deferred");
  assert.deepEqual(body.work.produceShotIds, [FIXTURE_IDS.shot1], "only the generated shot of the hook beat");
  assert.deepEqual(body.work.voiceBeatIds, ["b1"]);
  assert.equal((await h.ledger.listEntries(RESERVATION)).length, 0);
});

test("a paused reservation funds no variant: every planned one is skipped over the reservation, and no EDL is written", async () => {
  const h = await harness({ paused: true });
  const requestId = await h.storeRequest(requestWith({ captionStyles: ["lower"], maxVariants: 4, budgetUsd: 1 }));
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const result = await createVariantsHandler(h.ports).run(contextFor([requestId, planId, masterId]));
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.deepEqual(variantsOf(result.output).variants, []);
  const [skipped] = eventsOf(await h.events.list({ organizationId: WS, requestId: REQ }), "variant.planned");
  assert.equal((skipped?.body as { reason: string }).reason, "over_reservation");
});

test("an unknown music track is skipped with its reason, and the other variants are still built", async () => {
  const h = await harness({ tracks: new Map([["trk_known", track(1)]]) });
  const requestId = await h.storeRequest(requestWith({ captionStyles: ["lower"], music: ["trk_known", "trk_unknown"], maxVariants: 4, budgetUsd: 1 }));
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const result = await createVariantsHandler(h.ports).run(contextFor([requestId, planId, masterId]));
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.equal(variantsOf(result.output).variants.length, 2);
  const planned = eventsOf(await h.events.list({ organizationId: WS, requestId: REQ }), "variant.planned");
  const skipped = planned.filter((row) => (row.body as { status: string }).status === "skipped");
  assert.deepEqual(skipped.map((row) => (row.body as { reason: string }).reason), ["music_track_unknown"]);
});

test("a retried job names the same EDL and writes no second copy or event", async () => {
  const h = await harness();
  const requestId = await h.storeRequest(requestWith({ captionStyles: ["lower"], maxVariants: 4, budgetUsd: 1 }));
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const handler = createVariantsHandler(h.ports);
  const first = await handler.run(contextFor([requestId, planId, masterId]));
  const second = await handler.run(contextFor([requestId, planId, masterId]));
  assert.equal(first.kind, "done");
  assert.equal(second.kind, "done");
  if (first.kind !== "done" || second.kind !== "done") return;
  assert.deepEqual(first.output.artifacts, second.output.artifacts);
  assert.equal((await h.events.list({ organizationId: WS, requestId: REQ })).filter((row) => row.kind === "variant.planned").length, 1);
});

test("refuses a run without its request, its plan, its master, or its reservation, and writes nothing", async () => {
  const h = await harness();
  const requestId = await h.storeRequest(requestWith({ captionStyles: ["lower"], maxVariants: 4, budgetUsd: 1 }));
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  const handler = createVariantsHandler(h.ports);

  await assert.rejects(handler.run(contextFor([planId, masterId])), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  await assert.rejects(handler.run(contextFor([requestId, masterId])), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  await assert.rejects(handler.run(contextFor([requestId, planId, masterId], { masterEdlId: fixtureId("edl_", 90) })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  await assert.rejects(handler.run(contextFor([requestId, planId, masterId], { reservationId: null })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  assert.equal((await h.events.list({ organizationId: WS, requestId: REQ })).length, 0);
});

test("refuses a request that names no variant matrix, since the orchestrator queued variants for it", async () => {
  const h = await harness();
  const plain = { ...(productionRequestFixture as ProductionRequest), output: { master: true as const } };
  const requestId = await h.storeRequest(plain);
  const planId = await h.storePlan();
  const masterId = await h.storeMaster(captionVariantMaster());
  await assert.rejects(createVariantsHandler(h.ports).run(contextFor([requestId, planId, masterId])), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});
