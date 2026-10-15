import { CONTRACTS_VERSION } from "../../contracts/version.ts";
import { thresholds } from "../../config/thresholds.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import type { JournalEntry } from "../../claude/journal.ts";
import {
  compositionHash,
  contentHash,
  EngineError,
  manifestSchema,
  sumUsd,
  type CompositionFile,
  type EditDecisionList,
  type GateResult,
  type LedgerEntry,
  type Manifest,
  type RenderedVideo,
  type ReviewResult,
} from "../../contracts/index.ts";
import {
  budgetReservationFixture,
  compositionFixture,
  edlFixture,
  fixtureId,
  FIXTURE_IDS,
  ledgerClaudeFixture,
  ledgerRenderFixture,
  ledgerShot3Fixture,
  ledgerSttFixture,
  manifestFixture,
  manifestRoleCallsFixture,
  postRenderGateFixture,
  productionRequestFixture,
  renderedVideoFixture,
  reviewResultFixture,
  scenePlanFixture,
  takesFixture,
  videoDnaFixture,
  voiceTrackFixture,
} from "../../contracts/fixtures/index.ts";
import { memoryEventStore, type EventStore } from "../../events/store.ts";
import { asVariant, withCaptionBand } from "../../variants/diff.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createDeliverHandler, type DeliverPorts } from "./deliver.ts";

const WS = "ws_deliver";
const REQ = FIXTURE_IDS.request;
const RES = FIXTURE_IDS.reservation;
const AT = "2026-10-13T09:30:00.000Z";
const VARIANT_VIDEO = fixtureId("vid_", 100);
const VARIANT_CMP = fixtureId("cmp_", 101);
const SEGMENT_KEY = "segment:req:1";
const DIRECTOR_KEY = "director:req:1";

/** The master with its captions split, as the editor writes them: a caption over the presenter and one after it. */
function masterEdl(): EditDecisionList {
  const master = structuredClone(edlFixture);
  master.tracks = master.tracks.map((layer) =>
    layer.layer === "captions"
      ? {
          layer: "captions",
          clips: [
            { clipId: "c_cap_1", startMs: 0, endMs: 3000, component: "captions.karaoke", props: { band: "upper", captions: [] } },
            { clipId: "c_cap_2", startMs: 3000, endMs: 24000, component: "captions.karaoke", props: { band: "upper", captions: [] } },
          ],
        }
      : layer,
  );
  return master;
}

const MASTER = masterEdl();
const VARIANT_RESULT = asVariant(MASTER, withCaptionBand(MASTER, "lower").edl, "caption:lower");
if (!VARIANT_RESULT.ok) throw new Error("the fixture variant must be valid");
const VARIANT = VARIANT_RESULT.edl;
const VARIANT_EDL_ID = VARIANT.edlId;
const VARIANT_COMPOSITION_FILES: CompositionFile[] = [
  { path: "index.html", contentHash: contentHash(new TextEncoder().encode("variant markup")), bytes: 14 },
  ...compositionFixture.files.slice(1),
];
const VARIANT_COMPOSITION_HASH = compositionHash(VARIANT_COMPOSITION_FILES);

const journal: JournalEntry[] = [
  {
    status: "answered",
    idempotencyKey: ledgerClaudeFixture.idempotencyKey,
    retryOfKey: null,
    role: "planner",
    stage: "plan",
    promptVersion: "planner@1",
    model: "anthropic/claude-opus-5.5",
    reservationId: RES,
    answer: {},
    refusedReason: null,
    call: {
      idempotencyKey: ledgerClaudeFixture.idempotencyKey,
      ledgerEntryId: ledgerClaudeFixture.entryId,
      promptVersion: "planner@1",
      model: "anthropic/claude-opus-5.5",
      answeredBy: "anthropic/claude-opus-5.5",
      generationId: "gen-fixture-planner-1",
      promptTokens: 19000,
      completionTokens: 3300,
      costUsd: 0.142,
      actualIsEstimate: false,
      verdict: "answered",
      issues: [],
    },
  },
  {
    status: "invalid_answer",
    idempotencyKey: DIRECTOR_KEY,
    retryOfKey: null,
    role: "director_check",
    stage: "plan",
    promptVersion: "director_check@1",
    model: "anthropic/claude-opus-5.5",
    reservationId: RES,
    answer: null,
    refusedReason: null,
    call: {
      idempotencyKey: DIRECTOR_KEY,
      ledgerEntryId: fixtureId("led_", 41),
      promptVersion: "director_check@1",
      model: "anthropic/claude-opus-5.5",
      answeredBy: null,
      generationId: "gen-fixture-director-1",
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      actualIsEstimate: true,
      verdict: "invalid_answer",
      issues: ["swaps: expected an array"],
    },
  },
  {
    status: "pending",
    idempotencyKey: SEGMENT_KEY,
    retryOfKey: null,
    role: "segmenter",
    stage: "analyze_reference",
    promptVersion: "segmenter@1",
    model: "anthropic/claude-sonnet-5.5",
    reservationId: RES,
    answer: null,
    refusedReason: null,
    call: null,
  },
];

/**
 * The ledger of the request: four settled calls, and three holds that never reconciled. The variant's render is keyed by the variant's
 * composition hash, which is how the ledger row is attributed to the variant (Bible 6.11).
 */
function ledgerEntries(): LedgerEntry[] {
  return [
    ledgerClaudeFixture,
    ledgerSttFixture,
    ledgerShot3Fixture,
    ledgerRenderFixture,
    {
      entryId: fixtureId("led_", 42),
      requestId: REQ,
      stage: "claude_roles",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      estimateUsd: 0.08,
      reservedUsd: 0.08,
      idempotencyKey: SEGMENT_KEY,
      at: "2026-10-13T09:00:30.000Z",
      role: "segmenter",
      promptVersion: "segmenter@1",
    },
    {
      entryId: fixtureId("led_", 41),
      requestId: REQ,
      stage: "claude_roles",
      provider: "openrouter",
      model: "anthropic/claude-opus-5.5",
      estimateUsd: 0.05,
      reservedUsd: 0.05,
      idempotencyKey: DIRECTOR_KEY,
      at: "2026-10-13T09:01:50.000Z",
      role: "director_check",
      promptVersion: "director_check@1",
    },
    {
      entryId: fixtureId("led_", 43),
      requestId: REQ,
      stage: "render",
      provider: "hyperframes-cloud",
      model: "hyperframes",
      estimateUsd: 0.05,
      reservedUsd: 0.05,
      idempotencyKey: VARIANT_COMPOSITION_HASH,
      at: "2026-10-13T09:25:00.000Z",
    },
  ];
}

/** One request's database, with the request row. Each test has its own, because manifest ids are stable and immutable. */
async function freshRequest(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  await seedWorkspace(database.sql, WS, "brand_fixture");
  await database.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
  `;
  return database;
}

function masterReview(pass: boolean): ReviewResult["result"] {
  return pass
    ? postRenderGateFixture
    : { ...postRenderGateFixture, pass: false, checks: [{ rule: "frames_at_cuts", pass: false, detail: "a black frame" }] };
}

/** Stores the artifacts of a delivered request and returns their ids, in the order they were written. */
async function storeArtifacts(database: TestDatabase, options: { variantPasses?: boolean; masterPasses?: boolean } = {}): Promise<string[]> {
  const ids: string[] = [];
  const put = async (type: Parameters<typeof writeArtifact>[1]["type"], body: unknown, createdAt: string, stage: string) => {
    const stored = await writeArtifact(database.sql, { organizationId: WS, requestId: REQ, stage, type, body, createdAt });
    ids.push(stored.artifactId);
  };
  await put("production_request", productionRequestFixture, "2026-10-13T09:00:00.000Z", "intake");
  await put("video_dna", videoDnaFixture, "2026-10-13T09:00:05.000Z", "analyze_reference");
  await put("voice_track", voiceTrackFixture, "2026-10-13T09:00:40.000Z", "voice");
  await put("scene_plan", scenePlanFixture, "2026-10-13T09:00:41.000Z", "plan");
  for (const take of takesFixture) await put("take", take, "2026-10-13T09:02:10.000Z", "produce_shot");
  await put("edl", MASTER, "2026-10-13T09:05:00.000Z", "edit");
  await put("composition", compositionFixture, "2026-10-13T09:05:30.000Z", "compose");
  await put("rendered_video", renderedVideoFixture, "2026-10-13T09:06:00.000Z", "render");
  await put("review_result", { ...reviewResultFixture, result: masterReview(options.masterPasses !== false) }, "2026-10-13T09:07:00.000Z", "post_render_review");
  await put("edl", VARIANT, "2026-10-13T09:20:00.000Z", "variants");
  await put(
    "composition",
    { schema: "meridian.composition/v1", compositionId: VARIANT_CMP, edlId: VARIANT_EDL_ID, rootFile: "index.html", files: VARIANT_COMPOSITION_FILES, assetUris: compositionFixture.assetUris, contentHash: VARIANT_COMPOSITION_HASH },
    "2026-10-13T09:20:30.000Z",
    "compose",
  );
  const variantRender: RenderedVideo = { ...renderedVideoFixture, videoId: VARIANT_VIDEO, edlId: VARIANT_EDL_ID, costUsd: 0.046, idempotencyKey: VARIANT_COMPOSITION_HASH };
  await put("rendered_video", variantRender, "2026-10-13T09:25:00.000Z", "render");
  const variantPasses = options.variantPasses !== false;
  const variantReview: ReviewResult = {
    schema: "meridian.review_result/v1",
    videoId: VARIANT_VIDEO,
    result: variantPasses
      ? { ...postRenderGateFixture, subjectId: VARIANT_VIDEO }
      : { ...postRenderGateFixture, subjectId: VARIANT_VIDEO, pass: false, checks: [{ rule: "claims_on_screen", pass: false, detail: "a claim is off the list" }] },
    failures: variantPasses ? [] : [{ rule: "claims_on_screen" }],
  };
  await put("review_result", variantReview, "2026-10-13T09:26:00.000Z", "post_render_review");
  return ids;
}

type Harness = { ports: DeliverPorts; events: EventStore; ledger: LedgerStore };

/** Ports over one reservation with its ledger. The paid-partnership answer is given, or left unknown. */
async function harnessFor(options: { paidPartnership?: boolean } = {}): Promise<Harness> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation({ ...budgetReservationFixture, workspaceId: WS });
  for (const entry of ledgerEntries()) {
    await ledger.appendEntry({ ...entry, workspaceId: WS, reservationId: RES });
  }
  const events = memoryEventStore();
  const ports: DeliverPorts = {
    withLedger: (_scope, fn) => fn(ledger),
    roleCalls: async () => journal,
    gates: async () => manifestFixture.gates as GateResult[],
    decisions: async () => [],
    ...(options.paidPartnership === undefined ? {} : { paidPartnership: async () => options.paidPartnership }),
    events,
    now: () => AT,
  };
  return { ports, events, ledger };
}

function contextFor(database: TestDatabase, inputArtifactIds: string[], reservationId: string | null = RES): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "deliver",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: database.sql,
    jobId: "job_deliver_1",
    organizationId: WS,
    requestId: REQ,
    stage: "deliver",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function manifestOf(database: TestDatabase, artifactId: string): Promise<Manifest> {
  const stored = await readArtifact(database.sql, { organizationId: WS, artifactId });
  return manifestSchema.parse(stored.envelope.body);
}

test("delivers the master and the variant: writes both manifests, settles and releases the ledger, and emits the delivery events", async () => {
  const database = await freshRequest();
  try {
    const inputs = await storeArtifacts(database);
    const { ports, events, ledger } = await harnessFor();
    const result = await createDeliverHandler(ports).run(contextFor(database, inputs));

    assert.equal(result.kind, "done");
    if (result.kind !== "done") return;
    assert.equal(result.output.stage, "deliver");
    assert.equal(result.output.manifestId, FIXTURE_IDS.video);
    assert.equal(validateStageOutput(result.output, contextFor(database, inputs).payload).stage, "deliver");
    assert.deepEqual(Object.keys(result.output.artifacts).sort(), [`manifest:${FIXTURE_IDS.video}`, `manifest:${VARIANT_VIDEO}`].sort());

    const master = await manifestOf(database, result.output.artifacts[`manifest:${FIXTURE_IDS.video}`] ?? "");
    assert.equal(master.videoId, FIXTURE_IDS.video);
    assert.equal("variantOf" in master, false);
    assert.deepEqual(master.shots, manifestFixture.shots, "the master plays the takes of the chain fixture");
    assert.deepEqual(master.roleCalls, manifestRoleCallsFixture.filter((call) => call.role === "planner" || call.role === "director_check"));
    assert.deepEqual(master.promptVersions, { planner: "planner@1", director_check: "director_check@1", segmenter: "segmenter@1" });
    assert.deepEqual(master.disclosures, { aiGeneratedPeople: true, paidPartnership: true }, "no paid-partnership answer is unknown, so it is disclosed");
    assert.equal(master.cost.brain, 0.272, "the planner 0.142, the held segmenter 0.08 and the held director check 0.05");
    assert.equal(master.cost.generation, 0.2016);
    assert.equal(master.cost.render, 0.047);
    assert.equal(master.cost.other, 0.02);
    assert.equal(master.cost.total, 0.5406);
    assert.equal(master.gates.length, 10, "the master holds every gate of the request");

    const variant = await manifestOf(database, result.output.artifacts[`manifest:${VARIANT_VIDEO}`] ?? "");
    assert.equal(variant.variantOf, FIXTURE_IDS.video);
    assert.deepEqual(variant.shots, manifestFixture.shots, "the variant shares the master's takes");
    assert.deepEqual(variant.roleCalls, [], "the variant made no Claude call of its own");
    assert.equal(variant.cost.total, 0.05, "the variant pays for its own render");
    assert.equal(variant.cost.render, 0.05);
    assert.equal(
      variant.gates.some((gate) => gate.subjectId === FIXTURE_IDS.video),
      false,
      "the master's render and review are not the variant's gates",
    );

    const ledgerRows = await ledger.listEntries(RES);
    assert.ok(ledgerRows.every((row) => row.actualUsd !== undefined), "every paid call is reconciled");
    const reservation = await ledger.getReservation(RES);
    assert.equal(reservation?.state, "released");
    assert.equal(reservation?.reservedUsd, 0.5906, "the reservation holds only what was committed");
    assert.equal(
      sumUsd([master.cost.total, variant.cost.total]),
      sumUsd(ledgerRows.map((row) => row.actualUsd ?? 0)),
      "the manifests hold every paid call once",
    );

    const rows = await events.list({ organizationId: WS, requestId: REQ });
    const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
    assert.equal(count("cost.reconciled"), ledgerRows.length);
    assert.equal(count("gate.result"), 10);
    assert.equal(count("video.delivered"), 2);
    assert.equal(count("variant.delivered"), 1);
    assert.equal(count("request.delivered"), 1);
    const delivered = rows.find((row) => row.kind === "request.delivered")?.body as { releasedUsd: number; unansweredCalls: number; costTotalUsd: number };
    assert.equal(delivered.releasedUsd, 0.3689);
    assert.equal(delivered.unansweredCalls, 1);
    assert.equal(delivered.costTotalUsd, 0.5906);
    const variantEvent = rows.find((row) => row.kind === "variant.delivered")?.body as { attribute: string | null; value: string | null };
    assert.equal(variantEvent.attribute, "caption");
    assert.equal(variantEvent.value, "lower", "the band the variant set, not the master's");
    const videoEvent = rows.find((row) => row.kind === "video.delivered")?.body as { configVersions: Record<string, string> };
    assert.equal(videoEvent.configVersions.thresholds, thresholds.version, "the event records the config version in use");
    assert.equal(videoEvent.configVersions.contracts, CONTRACTS_VERSION);
  } finally {
    await database.close();
  }
});

test("a retried job writes no second manifest, settles nothing again, and emits no event twice", async () => {
  const database = await freshRequest();
  try {
    const inputs = await storeArtifacts(database);
    const { ports, events } = await harnessFor();
    const handler = createDeliverHandler(ports);
    const first = await handler.run(contextFor(database, inputs));
    const eventCount = (await events.list({ organizationId: WS, requestId: REQ })).length;
    const second = await handler.run(contextFor(database, inputs));
    assert.equal(first.kind, "done");
    assert.equal(second.kind, "done");
    if (first.kind !== "done" || second.kind !== "done") return;
    assert.deepEqual(first.output.artifacts, second.output.artifacts);
    assert.equal((await events.list({ organizationId: WS, requestId: REQ })).length, eventCount);
  } finally {
    await database.close();
  }
});

test("a variant whose review failed is not delivered, and its render cost stays on the request", async () => {
  const database = await freshRequest();
  try {
    const inputs = await storeArtifacts(database, { variantPasses: false });
    const { ports, events } = await harnessFor();
    const result = await createDeliverHandler(ports).run(contextFor(database, inputs));
    assert.equal(result.kind, "done");
    if (result.kind !== "done") return;
    assert.deepEqual(Object.keys(result.output.artifacts), [`manifest:${FIXTURE_IDS.video}`]);
    const master = await manifestOf(database, result.output.artifacts[`manifest:${FIXTURE_IDS.video}`] ?? "");
    assert.equal(master.cost.total, 0.5906, "the failed variant's render is paid for, so it is on the master's record");
    const rows = await events.list({ organizationId: WS, requestId: REQ });
    const delivered = rows.find((row) => row.kind === "request.delivered")?.body as { undeliveredVariantEdlIds: string[]; deliveredVariantVideoIds: string[] };
    assert.deepEqual(delivered.undeliveredVariantEdlIds, [VARIANT_EDL_ID]);
    assert.deepEqual(delivered.deliveredVariantVideoIds, []);
    assert.equal(rows.filter((row) => row.kind === "variant.delivered").length, 0);
  } finally {
    await database.close();
  }
});

test("a paid-partnership answer that is given is carried to the manifest", async () => {
  const database = await freshRequest();
  try {
    const inputs = await storeArtifacts(database);
    const { ports } = await harnessFor({ paidPartnership: false });
    const result = await createDeliverHandler(ports).run(contextFor(database, inputs));
    assert.equal(result.kind, "done");
    if (result.kind !== "done") return;
    const master = await manifestOf(database, result.output.artifacts[`manifest:${FIXTURE_IDS.video}`] ?? "");
    assert.equal(master.disclosures.paidPartnership, false);
  } finally {
    await database.close();
  }
});

test("refuses to deliver when the master's review did not pass, and writes no manifest", async () => {
  const database = await freshRequest();
  try {
    const inputs = await storeArtifacts(database, { masterPasses: false });
    const { ports, events } = await harnessFor();
    await assert.rejects(createDeliverHandler(ports).run(contextFor(database, inputs)), (error: unknown) => {
      return error instanceof EngineError && error.kind === "invalid_input" && /master does not deliver/.test(error.message);
    });
    assert.equal((await events.list({ organizationId: WS, requestId: REQ })).length, 0);
  } finally {
    await database.close();
  }
});

test("refuses to deliver without the request's reservation, which it must settle", async () => {
  const database = await freshRequest();
  try {
    const inputs = await storeArtifacts(database);
    const { ports } = await harnessFor();
    await assert.rejects(
      createDeliverHandler(ports).run(contextFor(database, inputs, null)),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  } finally {
    await database.close();
  }
});

test("the render idempotency key is the composition hash, which is how a render's ledger row finds its video", () => {
  assert.equal(renderedVideoFixture.idempotencyKey, compositionFixture.contentHash);
  assert.equal(VARIANT.variantOf, FIXTURE_IDS.edl);
});
