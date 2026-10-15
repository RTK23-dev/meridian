import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { budgetReservationSchema, EngineError, gateResultSchema, reviewResultSchema, type GateResult, type RenderedVideo } from "../../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../../contracts/fixtures/index.ts";
import type { TimelineResult } from "../../media/interface.ts";
import { cleanRender, clearBlackFrames, drawnOverlays, integrityPassed, VIDEO_ID, type CleanRender } from "../../review/test/render.ts";
import { decideGate } from "../../review/gold.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { sqlLedgerStore } from "../sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import { fakeObjects, gatewayWith, json, PNG_1X1, recordedTransport, type Reply } from "../test/harness.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import { createPostRenderReviewHandler, criticSummaryOf, longestSilenceMs, type PostRenderPorts } from "./post-render-review.ts";

const WS = "ws_post_render";
const BRAND = "brand_fixture";
const REQ = FIXTURE_IDS.request;
const CREATED = "2026-10-15T10:00:00.000Z";

const here = dirname(fileURLToPath(import.meta.url));
/** A recorded Critic answer from the review folder's fixtures (authored, in the OpenRouter shape). */
function criticFixture(name: string): Reply {
  return json(200, JSON.parse(readFileSync(join(here, "../../review/test/fixtures", `${name}.json`), "utf8")));
}

let db: TestDatabase;
let counter = 0;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, ${BRAND}, 'fmt_fixture', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

/** A timeline of one audible minute, with a silent run of the given length in the middle (0 for none). */
function timelineWith(silentMs: number): TimelineResult {
  const samples = Array.from({ length: 600 }, (_, index) => {
    const silent = index >= 200 && index < 200 + silentMs / 100;
    return { atMs: index * 100, lufs: silent ? null : -18 };
  });
  return { videoPresent: true, audioPresent: true, brightness: [], motion: [], loudness: samples, envelope: { stepMs: 10, rms: [] } };
}

/** The media functions over the rendered file: clean loudness, and frames that the caller can make fail. */
function mediaFor(options: { silentMs?: number; framesRefuse?: boolean } = {}): PostRenderPorts["media"] {
  return {
    async frames(request) {
      if (options.framesRefuse) throw new EngineError("invalid_input", "the file is too large for a frame call");
      return { frames: request.atMs.map((atMs) => ({ atMs, width: 1080, height: 1920, png: PNG_1X1 })) };
    },
    async loudness() {
      return { integratedLufs: -14, truePeakDbtp: -2, loudnessRangeLu: 6 };
    },
    async timeline() {
      return timelineWith(options.silentMs ?? 0);
    },
  };
}

type Scenario = {
  render: CleanRender;
  videoId: string;
  reservationId: string;
  renderedArtifactId: string;
  edlArtifactId: string;
  /** The render stage's integrity gate artifact, or null when the scenario leaves it out. */
  integrityArtifactId: string | null;
  objects: ReturnType<typeof fakeObjects>;
};

/** Stores a rendered video of the clean render under its own id, its EDL, a reservation for the Critic and its object. */
async function scenario(options: { withIntegrity?: boolean; objectPresent?: boolean } = {}): Promise<Scenario> {
  counter += 1;
  const render = cleanRender();
  const videoId = counter === 1 ? VIDEO_ID : fixtureId("vid_", 400 + counter);
  const uri = "store://renders/" + videoId + ".mp4";
  const reservationId = fixtureId("res_", 400 + counter);
  await sqlLedgerStore(db.sql, WS).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId,
      requestId: REQ,
      workspaceId: WS,
      mode: "cap",
      lines: [{ stage: "claude_roles", estimateUsd: 0.1 }],
      estimateUsd: 0.1,
      redoAllowanceUsd: 0,
      reservedUsd: 0.1,
      state: "reserved",
      createdAt: CREATED,
    }),
  );
  const rendered: RenderedVideo = { ...render.rendered, videoId, uri };
  const renderedStored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "render", type: "rendered_video", body: rendered, createdAt: CREATED });
  const edlStored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: render.edl, createdAt: CREATED });
  let integrityArtifactId: string | null = null;
  if (options.withIntegrity !== false) {
    const integrity = gateResultSchema.parse({ ...integrityPassed(videoId), gate: "render_integrity" });
    const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "render", type: "gate_result", body: integrity, createdAt: CREATED });
    integrityArtifactId = stored.artifactId;
  }
  const objects = fakeObjects();
  if (options.objectPresent !== false) {
    objects.objects.set(WS + "|" + BRAND + "|" + uri, { mimeType: "video/mp4", bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]) });
  }
  return { render, videoId, reservationId, renderedArtifactId: renderedStored.artifactId, edlArtifactId: edlStored.artifactId, integrityArtifactId, objects };
}

function portsFor(s: Scenario, options: { transport: ReturnType<typeof recordedTransport>; media?: PostRenderPorts["media"]; overlayDrop?: boolean; silent?: number; forbidden?: string[] | undefined }): PostRenderPorts {
  return {
    gateway: gatewayWith(options.transport.transport),
    media: options.media ?? mediaFor({ silentMs: options.silent }),
    objects: s.objects,
    measureBlackFrames: async () => clearBlackFrames(s.render.edl),
    measureOverlays: async ({ edl }) => drawnOverlays(edl).map((item, index) => ({ clipId: item.clipId, present: !(options.overlayDrop === true && index === 0) })),
    measureOcr: async () => ({ captionWordsChecked: 24, captionWordsMismatched: 0, onScreenText: ["Send BLEND to get the link"] }),
    forbiddenTerms: async () => options.forbidden ?? ["miracle cure"],
  };
}

function contextFor(s: Scenario, overrides: { reservation?: string | null } = {}): StageContext {
  const inputArtifactIds = [s.renderedArtifactId, s.edlArtifactId, ...(s.integrityArtifactId === null ? [] : [s.integrityArtifactId])];
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "post_render_review",
    subjectId: s.videoId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: overrides.reservation === undefined ? s.reservationId : overrides.reservation,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_post_" + s.videoId,
    organizationId: WS,
    requestId: REQ,
    stage: "post_render_review",
    subjectId: s.videoId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function reviewOf(artifactId: string) {
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId });
  assert.equal(stored.envelope.type, "review_result");
  return reviewResultSchema.parse(stored.envelope.body);
}

describe("post_render_review on PostgreSQL (Bible 6.12, 12.3)", () => {
  test("a clean video passes: one Critic call, the review result is stored, and the output validates", async () => {
    const s = await scenario();
    const transport = recordedTransport({ "POST /api/v1/chat/completions": criticFixture("openrouter-critic-final-ok") });
    const ctx = contextFor(s);
    const result = await createPostRenderReviewHandler(portsFor(s, { transport })).run(ctx);
    assert.equal(result.kind, "done");
    if (result.kind !== "done") return;
    const output: StageOutput = result.output;
    assert.equal(output.stage, "post_render_review");
    validateStageOutput(output, ctx.payload);
    if (output.stage !== "post_render_review") return;
    assert.equal(output.gate.pass, true, output.gate.checks.filter((check) => !check.pass).map((check) => check.rule).join(", "));
    assert.equal(transport.requests.length, 1, "Haiku answered, so there is no re-check");
    const review = await reviewOf(output.artifacts[`review:${s.videoId}`] ?? "");
    assert.equal(review.result.pass, true);
    assert.deepEqual(review.failures, []);
  });

  test("a missing render integrity result is review: the gate fails, the failure is recorded, and the stage still answers", async () => {
    const s = await scenario({ withIntegrity: false });
    const transport = recordedTransport({ "POST /api/v1/chat/completions": criticFixture("openrouter-critic-final-ok") });
    const result = await createPostRenderReviewHandler(portsFor(s, { transport })).run(contextFor(s));
    if (result.kind !== "done" || result.output.stage !== "post_render_review") assert.fail("expected a done post_render_review output");
    assert.equal(result.output.gate.pass, false);
    assert.equal(decideGate(result.output.gate, {}).verdict, "review");
    const review = await reviewOf(result.output.artifacts[`review:${s.videoId}`] ?? "");
    assert.ok(review.failures.some((failure) => failure.rule === "render_integrity_passed"));
  });

  test("a broken overlay never passes: the failure names the graphics layer and its shot, and the review result is stored", async () => {
    const s = await scenario();
    const transport = recordedTransport({ "POST /api/v1/chat/completions": criticFixture("openrouter-critic-final-ok") });
    const result = await createPostRenderReviewHandler(portsFor(s, { transport, overlayDrop: true })).run(contextFor(s));
    if (result.kind !== "done" || result.output.stage !== "post_render_review") assert.fail("expected a done post_render_review output");
    assert.equal(result.output.gate.pass, false);
    const review = await reviewOf(result.output.artifacts[`review:${s.videoId}`] ?? "");
    assert.equal(review.result.pass, false);
    assert.ok(review.failures.some((failure) => failure.rule === "overlays_present" && failure.layer === "graphics"));
    assert.ok((result.output.gate.failingShotIds ?? []).length > 0, "the shot with the broken overlay is named");
  });

  test("Haiku unsure sends the frames to Sonnet, and Sonnet's rubric is the one the gate reads", async () => {
    const s = await scenario();
    const transport = recordedTransport({
      "POST /api/v1/chat/completions": [criticFixture("openrouter-critic-final-unsure"), criticFixture("openrouter-critic-final-sonnet-ok")],
    });
    const result = await createPostRenderReviewHandler(portsFor(s, { transport })).run(contextFor(s));
    if (result.kind !== "done" || result.output.stage !== "post_render_review") assert.fail("expected a done post_render_review output");
    assert.equal(transport.requests.length, 2, "one Haiku call and one Sonnet call");
    const hands = result.output.gate.checks.find((check) => check.rule === "rubric_hands");
    assert.equal(hands?.pass, false, "Sonnet scored the hands at 0.4");
    assert.equal(result.output.gate.pass, false);
  });

  test("frames the media functions cannot give leave the Critic unanswered: nothing is sent, and the gate fails closed", async () => {
    const s = await scenario();
    const transport = recordedTransport({});
    const result = await createPostRenderReviewHandler(portsFor(s, { transport, media: mediaFor({ framesRefuse: true }) })).run(contextFor(s));
    if (result.kind !== "done" || result.output.stage !== "post_render_review") assert.fail("expected a done post_render_review output");
    assert.equal(transport.requests.length, 0, "no call is sent without the frames");
    assert.equal(result.output.gate.pass, false);
    assert.ok(result.output.gate.checks.some((check) => check.rule === "critic_final_answered" && !check.pass));
  });

  test("a silence over the limit fails the gate, and the measured number is in the check", async () => {
    const s = await scenario();
    const transport = recordedTransport({ "POST /api/v1/chat/completions": criticFixture("openrouter-critic-final-ok") });
    const result = await createPostRenderReviewHandler(portsFor(s, { transport, silent: 1000 })).run(contextFor(s));
    if (result.kind !== "done" || result.output.stage !== "post_render_review") assert.fail("expected a done post_render_review output");
    const silence = result.output.gate.checks.find((check) => check.rule === "silence_within_limit");
    assert.equal(silence?.pass, false);
    assert.equal(silence?.value, 1000);
  });

  test("a video whose forbidden terms are not known is missing evidence, not a pass", async () => {
    const s = await scenario();
    const transport = recordedTransport({ "POST /api/v1/chat/completions": criticFixture("openrouter-critic-final-ok") });
    const ports = { ...portsFor(s, { transport }), forbiddenTerms: async () => undefined };
    const result = await createPostRenderReviewHandler(ports).run(contextFor(s));
    if (result.kind !== "done" || result.output.stage !== "post_render_review") assert.fail("expected a done post_render_review output");
    assert.equal(result.output.gate.checks.find((check) => check.rule === "forbidden_terms_absent")?.pass, false);
  });

  test("a stage with no budget reservation is refused: it is paid, and no call is made", async () => {
    const s = await scenario();
    const transport = recordedTransport({});
    await assert.rejects(
      createPostRenderReviewHandler(portsFor(s, { transport })).run(contextFor(s, { reservation: null })),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(transport.requests.length, 0);
  });

  test("a rendered file missing from the object store is a failure to read it, not a verdict on nothing", async () => {
    const s = await scenario({ objectPresent: false });
    const transport = recordedTransport({});
    await assert.rejects(
      createPostRenderReviewHandler(portsFor(s, { transport })).run(contextFor(s)),
      (error: unknown) => error instanceof EngineError && error.kind === "not_found",
    );
  });
});

describe("post_render_review helpers", () => {
  test("the longest silence is the longest run of silent samples, in milliseconds", () => {
    assert.equal(longestSilenceMs(timelineWith(0), 60000), 0);
    assert.equal(longestSilenceMs(timelineWith(1000), 60000), 1000);
  });

  test("a file with no audio is silent for its whole duration, and an unmeasured timeline gives no silence figure", () => {
    const silent: TimelineResult = { videoPresent: true, audioPresent: false, brightness: [], motion: [], loudness: [], envelope: { stepMs: 10, rms: [] } };
    assert.equal(longestSilenceMs(silent, 24000), 24000);
    const empty: TimelineResult = { ...silent, audioPresent: true };
    assert.equal(longestSilenceMs(empty, 24000), null);
  });

  test("the Critic is shown the EDL's clips in time order, with their layers, spans and components", () => {
    const render = cleanRender();
    const summary = criticSummaryOf(render.edl);
    assert.ok(summary.clips.length > 0);
    assert.ok(summary.clips.every((clip, index) => index === 0 || clip.startMs >= (summary.clips[index - 1]?.startMs ?? 0)));
    assert.ok(summary.clips.some((clip) => clip.component === "product.card"));
  });

  test("the rendered video is read as the review's subject, and the decision is a review on a missing result", () => {
    const gate: GateResult = { gate: "post_render", subjectId: VIDEO_ID, pass: false, checks: [{ rule: "render_integrity_passed", pass: false }] };
    assert.equal(decideGate(gate, {}).verdict, "review");
  });
});
