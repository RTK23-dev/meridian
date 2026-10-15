// The `post_render_review` stage handler (Bible 6.12, 12.3). It judges the rendered MP4 against the EDL it came from. It reads the
// rendered video, the EDL, and the render stage's render_integrity gate result (when the render stage stored one). Then it measures the
// file through the media functions (loudness, the true peak, the silence, and the frames) and through optional measurement ports
// (black frames, overlays, OCR). It runs the final Critic on twelve frames through the Claude client on the request's reservation
// (review/criticFinal.ts), runs checkPostRender, and stores a review_result artifact on every run, pass or fail.
//
// Missing evidence is never a pass (Bible 12). A measurement port that is absent, a frame the media functions could not decode, or a
// Critic that gave no answer leaves its check not evaluated, which fails it and routes the video to review. A broken overlay fails the
// gate, so it cannot reach delivery. This stage is paid (the Critic), so it needs the request's budget reservation.
//
// Errors are typed: an input that is missing or foreign is an invalid input; a media function that fails for a reason other than the
// input (a provider or an unreachable store) throws and the job retries it; a broken Critic answer throws RoleAnswerError.

import { thresholds } from "../../config/thresholds.ts";
import {
  EngineError,
  edlSchema,
  gateResultSchema,
  renderedVideoSchema,
  reviewResultSchema,
  type EdlLayer,
  type EditDecisionList,
  type GateResult,
  type RenderedVideo,
} from "../../contracts/index.ts";
import type { Gateway } from "../../gateway/gateway.ts";
import type { RoleCallJournal, RoleDeps } from "../../claude/client.ts";
import { MAX_SUMMARY_CLIPS, type CriticFinalClip } from "../../claude/roles/critic_final.ts";
import type { MediaFunctions, TimelineResult } from "../../media/interface.ts";
import { TIMELINE_STEPS } from "../../../../functions/ffmpeg/types.ts";
import type { BlackFrameMeasurement, LoudnessMeasurement, OcrMeasurement, OverlayMeasurement, SilenceMeasurement } from "../../review/gates/postRender.ts";
import { checkPostRender, criticFrameTimes, requiredFrameTimes, type PostRenderOutcome } from "../../review/gates/postRender.ts";
import { runCriticFinal, type CriticFinalOutcome } from "../../review/criticFinal.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { readArtifact, writeArtifact, type MediaStorePort } from "../artifact-store.ts";
import { scopedLedgerStore } from "../asset-stores-sql.ts";
import { sqlRoleCallJournal } from "../role-call-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

export const REVIEW_RESULT_SCHEMA = "meridian.review_result/v1";

/** What a port is given: the workspace, the request, and the rendered video and its EDL. */
export type PostRenderScope = { organizationId: string; requestId: string; rendered: RenderedVideo; edl: EditDecisionList };

export type PostRenderPorts = {
  /** The API gateway the final Critic calls go through (never fetch, never a provider name). */
  gateway: Gateway;
  /** The media functions: frames, loudness and the timeline of the rendered file. */
  media: Pick<MediaFunctions, "frames" | "loudness" | "timeline">;
  /** The object store the rendered file is read from. */
  objects: MediaStorePort;
  /** Black frames at the sample times. Absent, the black-frame check is not evaluated (no decoder is connected). */
  measureBlackFrames?: (input: { bytes: Uint8Array; times: readonly number[] }) => Promise<BlackFrameMeasurement[] | undefined>;
  /** Whether each graphics overlay is drawn in its frame. Absent, the overlay check is not evaluated. */
  measureOverlays?: (input: { bytes: Uint8Array; edl: EditDecisionList }) => Promise<OverlayMeasurement[] | undefined>;
  /** OCR of the captions and of the text on screen. Absent, the caption and claim checks are not evaluated. */
  measureOcr?: (input: { bytes: Uint8Array; edl: EditDecisionList }) => Promise<OcrMeasurement | undefined>;
  /** The product kit's forbidden terms. Absent, the claims check is not evaluated. */
  forbiddenTerms?: (scope: PostRenderScope) => Promise<string[] | undefined>;
  /** The clock as an ISO time, for the ledger and the artifacts. */
  now?: () => string;
};

function refuse(message: string, stage: string): EngineError {
  return new EngineError("invalid_input", message, { stage });
}

/** The longest silence of the file, from its momentary loudness (a null sample is below the gate). Null when it cannot be measured. */
export function longestSilenceMs(timeline: TimelineResult, durationMs: number): number | null {
  if (!timeline.audioPresent) return durationMs;
  if (timeline.loudness.length === 0) return null;
  let longest = 0;
  let run = 0;
  for (const sample of [...timeline.loudness].sort((a, b) => a.atMs - b.atMs)) {
    if (sample.lufs === null) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return longest * TIMELINE_STEPS.loudnessStepMs;
}

/** The EDL summary the final Critic is shown: each picture, graphics and caption clip's layer, span and component, in time order. */
export function criticSummaryOf(edl: EditDecisionList): { clips: CriticFinalClip[] } {
  const clips = edl.tracks
    .flatMap((track) => track.clips.map((clip) => ({ layer: track.layer as EdlLayer, startMs: clip.startMs, endMs: clip.endMs, component: clip.component ?? null })))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .slice(0, MAX_SUMMARY_CLIPS);
  return { clips };
}

/** The frame times in chunks no larger than the media call allows (thresholds.reference.maxFrames). */
function chunked(times: readonly number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let index = 0; index < times.length; index += size) chunks.push(times.slice(index, index + size));
  return chunks;
}

/**
 * The PNG of each requested frame. A media call that refuses its input (a file too large, or times out of range) is missing evidence:
 * null, and the frames are not judged. Any other failure throws, so the job retries it.
 */
async function framesAt(ports: PostRenderPorts, bytes: Uint8Array<ArrayBuffer>, times: readonly number[]): Promise<Map<number, Uint8Array> | null> {
  const frames = new Map<number, Uint8Array>();
  try {
    for (const atMs of chunked(times, thresholds.reference.maxFrames)) {
      const result = await ports.media.frames({ source: { kind: "bytes", bytes }, atMs });
      for (const frame of result.frames) frames.set(frame.atMs, frame.png);
    }
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return null;
    throw error;
  }
  return frames;
}

type PostInputs = { rendered: RenderedVideo; edl: EditDecisionList; integrity: GateResult | undefined };

async function readInputs(ctx: StageContext): Promise<PostInputs> {
  const stage = ctx.stage;
  let rendered: { value: RenderedVideo } | undefined;
  let edl: EditDecisionList | undefined;
  const integrities: GateResult[] = [];
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === "rendered_video") {
      const parsed = renderedVideoSchema.safeParse(stored.envelope.body);
      if (!parsed.success) throw refuse("the rendered video artifact does not parse", stage);
      if (rendered !== undefined) throw refuse("post_render_review needs exactly one rendered video", stage);
      rendered = { value: parsed.data };
    } else if (stored.envelope.type === "edl") {
      const parsed = edlSchema.safeParse(stored.envelope.body);
      if (!parsed.success) throw refuse("the edl artifact does not parse", stage);
      if (edl !== undefined) throw refuse("post_render_review needs exactly one EDL", stage);
      edl = parsed.data;
    } else if (stored.envelope.type === "gate_result") {
      const parsed = gateResultSchema.safeParse(stored.envelope.body);
      if (parsed.success && parsed.data.gate === "render_integrity") integrities.push(parsed.data);
    } else {
      throw refuse(`post_render_review does not read a ${stored.envelope.type} artifact`, stage);
    }
  }
  if (rendered === undefined || edl === undefined) throw refuse("post_render_review needs its rendered video and its EDL", stage);
  if (integrities.length > 1) throw refuse("post_render_review was given more than one render integrity result", stage);
  return { rendered: rendered.value, edl, integrity: integrities[0] };
}

async function brandOf(sql: Sql, organizationId: string, requestId: string): Promise<string> {
  const rows = await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  const brand = rows[0]?.brand_id ?? null;
  if (brand === null) throw new EngineError("invalid_input", "the request has no brand, so its rendered file cannot be read (Bible 5.2)", { stage: "post_render_review" });
  return brand;
}

function reservationOf(ctx: StageContext): string {
  if (ctx.payload.budgetReservationId === null) {
    throw refuse("post_render_review is a paid stage and has no budget reservation (Bible 14)", ctx.stage);
  }
  return ctx.payload.budgetReservationId;
}

function attemptOf(ctx: StageContext): number {
  const attempt = Number(ctx.payload.attempt);
  return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
}

/** The post_render_review stage. Stores a review_result artifact on every run and returns the gate for the orchestrator to route. */
export function createPostRenderReviewHandler(ports: PostRenderPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const stage = ctx.stage;
      const inputs = await readInputs(ctx);
      const { rendered, edl } = inputs;
      if (rendered.edlId !== edl.edlId) throw refuse("the rendered video was made from another EDL", stage);
      const reservationId = reservationOf(ctx);
      const brandId = await brandOf(ctx.sql, ctx.organizationId, ctx.requestId);
      const object = await ports.objects.get(ctx.organizationId, brandId, rendered.uri);
      if (!object) throw new EngineError("not_found", `the file of video ${rendered.videoId} is missing from the object store`, { stage });
      const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(object.bytes);
      const scope: PostRenderScope = { organizationId: ctx.organizationId, requestId: ctx.requestId, rendered, edl };

      const source = { kind: "bytes" as const, bytes };
      const loudnessResult = await ports.media.loudness({ source });
      const timeline = await ports.media.timeline({ source });
      const loudness: LoudnessMeasurement = { integratedLufs: loudnessResult.integratedLufs, truePeakDbtp: loudnessResult.truePeakDbtp };
      const silence: SilenceMeasurement = { longestMs: longestSilenceMs(timeline, rendered.durationMs) };

      const required = requiredFrameTimes(edl);
      const criticTimes = criticFrameTimes(rendered.durationMs);
      const frames = await framesAt(ports, bytes, [...new Set([...required, ...criticTimes])].sort((a, b) => a - b));

      const blackFrames = ports.measureBlackFrames ? await ports.measureBlackFrames({ bytes, times: required }) : undefined;
      const overlays = ports.measureOverlays ? await ports.measureOverlays({ bytes, edl }) : undefined;
      const ocr = ports.measureOcr ? await ports.measureOcr({ bytes, edl }) : undefined;
      const forbiddenTerms = ports.forbiddenTerms ? await ports.forbiddenTerms(scope) : undefined;

      // The final Critic: twelve frames over the whole video. A frame the media functions could not give is missing evidence.
      const pngs: Uint8Array[] = [];
      if (frames !== null) {
        for (const atMs of criticTimes) {
          const png = frames.get(atMs);
          if (png !== undefined) pngs.push(png);
        }
      }
      let critic: CriticFinalOutcome;
      if (frames === null || pngs.length !== criticTimes.length) {
        critic = { status: "not_answered", reason: "the frames of the render could not be read for the final Critic" };
      } else {
        const role: RoleDeps = {
          gateway: ports.gateway,
          ledger: scopedLedgerStore(ctx.sql, ctx.organizationId, reservationId),
          now: ports.now ?? (() => new Date().toISOString()),
          journal: sqlRoleCallJournal(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId }) as RoleCallJournal,
        };
        const run = await runCriticFinal(role, {
          requestId: ctx.requestId,
          workspaceId: ctx.organizationId,
          reservationId,
          attempt: attemptOf(ctx),
          signal: ctx.signal,
          input: {
            videoId: rendered.videoId,
            durationMs: rendered.durationMs,
            edlSummary: criticSummaryOf(edl),
            frames: criticTimes.map((atMs, index) => ({
              atMs,
              imageUrl: `data:image/png;base64,${Buffer.from(pngs[index]).toString("base64")}`,
            })),
          },
        });
        critic = run.outcome;
      }

      const outcome: PostRenderOutcome = checkPostRender({
        renderedVideo: rendered,
        edl,
        integrity: inputs.integrity,
        loudness,
        silence,
        overlays,
        blackFrames,
        ocr,
        forbiddenTerms,
        critic,
      });
      const review = reviewResultSchema.parse({
        schema: REVIEW_RESULT_SCHEMA,
        videoId: rendered.videoId,
        result: outcome.gate,
        failures: outcome.failures,
      });
      const written = await writeArtifact(ctx.sql, {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        stage,
        type: "review_result",
        body: review,
        parentIds: ctx.payload.inputArtifactIds,
        createdAt: (ports.now ?? (() => new Date().toISOString()))(),
      });
      return {
        kind: "done",
        output: {
          stage: "post_render_review",
          subjectId: ctx.subjectId,
          artifacts: { [`review:${rendered.videoId}`]: written.artifactId },
          edlId: edl.edlId,
          gate: outcome.gate,
        },
      };
    },
  };
}
