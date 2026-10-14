// Test harness for the analyze stage: the recorded measurements, the recorded role answers and the recorded speech-to-text,
// wired as the ReferencePorts of analyze/reference.ts. Test code only. No function here calls a live API.
// The measurements are captured from the real functions (see fixtures/README.md); the answers are hand-written to the
// documented OpenRouter shape and the role contracts, and say so in their own files.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deps,
  gatewayFor,
  json,
  ledgerWith,
  NOW,
  REQUEST_ID,
  RESERVATION_ID,
  WORKSPACE,
} from "../../claude/test/helpers.ts";
import { productionRequestFixture } from "../../contracts/fixtures/index.ts";
import {
  cutsResultSchema,
  probeResultSchema,
  timelineResultSchema,
} from "../../../../functions/ffmpeg/types.ts";
import { pngBytes } from "../../assets/test/recorded.ts";
import type { MediaFunctions, MediaSource } from "../../media/index.ts";
import { recordedSpeechToText, type RecordedSttFixture } from "../../media/stt.ts";
import type { ProductionRequest } from "../../contracts/index.ts";
import type { GrammarReadings, ReferencePorts, ReferenceRun } from "../reference.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

export const SOURCE: MediaSource = {
  kind: "url",
  url: "https://media.example.test/reels/fixture-0001.mp4",
};
export const DNA_ID = "dna_01JABCDEFGHJKMNPQRSTVWXYZ0";
export { NOW, REQUEST_ID, RESERVATION_ID, WORKSPACE };

/** The request the example is copied for: the contracts' fixture. */
export const request: ProductionRequest = productionRequestFixture;

type Measurements = { probe: unknown; cuts: unknown; timeline: unknown };
const measurements = read<Measurements>("reference-measurements.json");

/** The recorded measurements as the media functions return them. Each is checked against its contract. */
export function recordedMedia(
  options: { durationMs?: number | null; audio?: boolean } = {},
): MediaFunctions {
  const probe = probeResultSchema.parse(measurements.probe);
  const timeline = timelineResultSchema.parse(measurements.timeline);
  const cuts = cutsResultSchema.parse(measurements.cuts);
  const audioless = options.audio === false;
  return {
    id: "recorded:reference-measurements",
    probe: async () => ({
      ...probe,
      durationMs: options.durationMs === undefined ? probe.durationMs : options.durationMs,
    }),
    cuts: async () => cuts,
    timeline: async () =>
      audioless
        ? { ...timeline, audioPresent: false, loudness: [], envelope: { stepMs: 10, rms: [] } }
        : timeline,
    frames: async (frameRequest) => ({
      frames: frameRequest.atMs.map((atMs) => ({
        atMs,
        width: 64,
        height: 64,
        png: new Uint8Array(pngBytes(64)),
      })),
    }),
    loudness: async () => {
      throw new Error("analyze reads loudness from the timeline, not from the loudness function");
    },
  };
}

/** Recorded role answers in the OpenRouter shape, in the order the stage calls them. */
export const segmenterBody = read<Record<string, unknown>>("openrouter-segmenter.json");
export const genomeBody = read<Record<string, unknown>>("openrouter-genome.json");
export const copiesGenomeBody = read<Record<string, unknown>>("openrouter-genome-copies.json");
export const readings = read<GrammarReadings>("readings.json");
export const sttFixture = read<RecordedSttFixture>("speech-recorded.json");

/** A copy of the recorded segmenter answer with the first segment's base layer replaced: a recorded answer changed by a test. */
export function segmenterWithLayer(base: string): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(segmenterBody)) as {
    choices: Array<{ message: { content: string } }>;
  };
  const answer = JSON.parse(body.choices[0]?.message.content ?? "{}") as {
    segments: Array<{ layers: Record<string, string> }>;
  };
  const first = answer.segments[0];
  if (first) first.layers.base = base;
  body.choices[0]!.message.content = JSON.stringify(answer);
  return body as unknown as Record<string, unknown>;
}

export function referenceRun(overrides: Partial<ReferenceRun> = {}): ReferenceRun {
  return {
    organizationId: WORKSPACE,
    requestId: REQUEST_ID,
    reservationId: RESERVATION_ID,
    attempt: 1,
    subjectId: "subject_analyze_1",
    request,
    ...overrides,
  };
}

/**
 * The ports of one run on recorded answers: the media, the speech (connected or not), the role calls in order, the source
 * store (which records what it resolved and released), and the readings (null to leave them unconnected).
 */
export async function referencePorts(options: {
  responses: Array<Record<string, unknown>>;
  media?: MediaFunctions;
  readings?: GrammarReadings | null;
  speechConnected?: boolean;
  reservedUsd?: number;
}) {
  const ledger = await ledgerWith(options.reservedUsd ?? 1);
  const gateway = gatewayFor(options.responses.map((body) => json(200, body)));
  const stt = recordedSpeechToText(sttFixture);
  const released: string[] = [];
  const resolved: string[] = [];
  const ports: ReferencePorts = {
    media: options.media ?? recordedMedia(),
    speech:
      options.speechConnected === false
        ? { status: "not_connected", reason: "NOT_CONNECTED: no speech-to-text vendor (test)" }
        : { status: "ready", stt },
    sttPricePerMinuteUsd: 0.006,
    roles: deps(gateway.gateway, ledger),
    source: {
      async resolve(referenceVideo) {
        resolved.push(referenceVideo);
        return { status: "ready", source: SOURCE };
      },
      async release(referenceVideo) {
        released.push(referenceVideo);
      },
    },
    ...(options.readings === null ? {} : { readings: async () => options.readings ?? readings }),
    newDnaId: () => DNA_ID,
  };
  return { ports, requests: gateway.requests, stt, released, resolved, ledger };
}
