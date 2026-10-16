// The E1 acceptance inputs (Bible section 19, E1): a hand-written EDL with one stock clip, one TTS voice file and three
// components (captions.karaoke, title.hook, cta.card), the ScenePlan that reserve() prices, and the production request that
// the request row and its artifact record. Pure: no network, no keys, no environment reads.
//
// Text and the style kit come from the contract fixtures (src/engine/contracts/fixtures). The media URIs name existing
// assets. The run never generates them, and it never fetches stock footage: the owner supplies both files for a live run.

import {
  edlSchema,
  newId,
  productionRequestSchema,
  scenePlanSchema,
  type EditDecisionList,
  type ProductionRequest,
  type ScenePlan,
  type ShotSpec,
  type StyleKit,
} from "../../src/engine/contracts/index.ts";
import { productionRequestFixture, styleKitFixture } from "../../src/engine/contracts/fixtures/index.ts";

export const E1_FORMAT_ID = "fmt_e1_acceptance";
export const E1_PAGE_ID = "page_e1_acceptance";
export const E1_VOICE_ID = "voice_e1_acceptance";
/** The hand-written voice track is 12 s. The EDL's voice clip spans the whole video. */
export const E1_DURATION_MS = 12_000;
export const E1_STOCK_URI = "store://assets/e1-stock-kitchen.mp4";
export const E1_VOICE_URI = "store://assets/e1-voice.wav";
export const E1_STOCK_QUERY = "clean kitchen counter, morning light";
export const E1_VOICE_TRACK_ID = "vt_e1_hand_written";
export const E1_MAX_MS = 15_000;

/** The contract's style kit with bundled fonts only. A font outside the bundled set is fetched at render time (compose STATUS). */
export function e1StyleKit(): StyleKit {
  return { ...styleKitFixture, fonts: { display: "Inter", body: "Inter", captions: "Inter" } };
}

function fixtureBeat(beatId: string) {
  const beat = productionRequestFixture.script.beats.find((candidate) => candidate.beatId === beatId);
  if (!beat) throw new Error(`the contract fixtures have no beat ${beatId}`);
  return beat;
}

type CaptionWindow = { startMs: number; endMs: number; words: string[] };

/** Four caption windows, each split evenly between its words, so every time is a whole number of milliseconds. */
const CAPTION_WINDOWS: CaptionWindow[] = [
  { startMs: 0, endMs: 3000, words: ["Your", "kitchen", "counter"] },
  { startMs: 3000, endMs: 6000, words: ["is", "lying", "to", "you"] },
  { startMs: 6000, endMs: 9000, words: ["The", "fix", "is", "one", "blender"] },
  { startMs: 9000, endMs: 12000, words: ["Send", "BLEND", "to", "get", "the", "link"] },
];

export function karaokeCaptions() {
  return CAPTION_WINDOWS.map((window) => {
    const slice = (window.endMs - window.startMs) / window.words.length;
    return {
      startMs: window.startMs,
      endMs: window.endMs,
      words: window.words.map((text, index) => ({
        text,
        startMs: window.startMs + index * slice,
        endMs: window.startMs + (index + 1) * slice,
      })),
    };
  });
}

/** The props of the three components, as the EDL and the plan both carry them. */
export function e1ComponentProps() {
  const hook = fixtureBeat("b1");
  const cta = fixtureBeat("b5");
  return {
    title: {
      text: hook.text,
      emphasis: hook.emphasis ?? [],
      entrance: "pop",
      entranceMs: 250,
      band: "middle",
    },
    cta: { text: cta.text.replace(/\.$/, ""), keyword: "BLEND", arrow: "down" },
    captions: { band: "lower", captions: karaokeCaptions() },
  } as const;
}

/**
 * The hand-written E1 EDL: stock clip (base), title.hook and cta.card (graphics), captions.karaoke (captions), the TTS voice
 * clip and one punch-in. Validated with the EDL contract before it is returned.
 */
export function buildE1Edl(input: { edlId: string; requestId: string; stockUri?: string; voiceUri?: string }): EditDecisionList {
  const props = e1ComponentProps();
  return edlSchema.parse({
    schema: "meridian.edl/v1",
    edlId: input.edlId,
    requestId: input.requestId,
    durationMs: E1_DURATION_MS,
    fps: 30,
    width: 1080,
    height: 1920,
    tracks: [
      {
        layer: "base",
        clips: [{ clipId: "c_stock_1", startMs: 0, endMs: E1_DURATION_MS, srcUri: input.stockUri ?? E1_STOCK_URI, srcInMs: 0 }],
      },
      {
        layer: "graphics",
        clips: [
          { clipId: "c_title_1", startMs: 0, endMs: 2500, component: "title.hook", props: props.title },
          {
            clipId: "c_cta_1",
            startMs: 9000,
            endMs: E1_DURATION_MS,
            component: "cta.card",
            props: props.cta,
            box: { x: 60, y: 900, w: 880, h: 500 },
          },
        ],
      },
      {
        layer: "captions",
        clips: [{ clipId: "c_cap_1", startMs: 0, endMs: E1_DURATION_MS, component: "captions.karaoke", props: props.captions }],
      },
    ],
    audio: {
      voice: { uri: input.voiceUri ?? E1_VOICE_URI, startMs: 0, endMs: E1_DURATION_MS, gainDb: 0 },
      sfx: [],
      masterLufs: -14,
    },
    effects: [{ atMs: 1200, kind: "punch_in", params: { scale: 1.1 } }],
    seed: 4213,
  });
}

/**
 * The scene plan that reserve() prices. It holds the stock shot and the three component shots. Stock and code components
 * price at $0 (prices.ts), and no shot is generated, so the shots-only estimate is 0 and the fixed lines carry the estimate.
 * The video DNA is a placeholder reference: E1 has no reference analysis, and the plan is never stored as an artifact.
 */
export function buildE1Plan(input: { requestId: string }): ScenePlan {
  const props = e1ComponentProps();
  const shots: ShotSpec[] = [
    {
      shotId: newId("shot_"),
      beatId: "b1",
      startMs: 0,
      endMs: E1_DURATION_MS,
      visualType: "stock_footage",
      layer: "base",
      source: { kind: "stock", query: E1_STOCK_QUERY, minMs: E1_DURATION_MS },
    },
    {
      shotId: newId("shot_"),
      beatId: "b1",
      startMs: 0,
      endMs: 2500,
      visualType: "coded_graphics",
      layer: "graphics",
      source: { kind: "component", component: "title.hook", props: { ...props.title } },
    },
    {
      shotId: newId("shot_"),
      beatId: "b5",
      startMs: 9000,
      endMs: E1_DURATION_MS,
      visualType: "coded_graphics",
      layer: "graphics",
      source: { kind: "component", component: "cta.card", props: { ...props.cta } },
    },
    {
      shotId: newId("shot_"),
      beatId: "b1",
      startMs: 0,
      endMs: E1_DURATION_MS,
      visualType: "coded_graphics",
      layer: "graphics",
      source: { kind: "component", component: "captions.karaoke", props: { ...props.captions } },
    },
  ];
  return scenePlanSchema.parse({
    schema: "meridian.scene_plan/v1",
    planId: `plan_${input.requestId}`,
    requestId: input.requestId,
    videoDnaId: newId("dna_"),
    voiceTrackId: E1_VOICE_TRACK_ID,
    shots,
    estimatedUsd: 0,
    decisions: [
      {
        at: "E1",
        chose: "hand-written EDL",
        alternatives: [],
        reason: "E1 acceptance (Bible section 19): the EDL is written by hand, so no planner decision was made",
        by: "human",
      },
    ],
  });
}

/** The production request the request row points at. Built from the contract fixture's hook and CTA beats. */
export function buildE1Request(input: { requestId: string; workspaceId: string; budgetUsd: number }): ProductionRequest {
  const hook = fixtureBeat("b1");
  const cta = fixtureBeat("b5");
  return productionRequestSchema.parse({
    schema: "meridian.production_request/v1",
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    format: { formatId: E1_FORMAT_ID, referenceVideo: "none:hand-written-e1", keep: [], change: [] },
    script: {
      language: "en",
      beats: [
        { beatId: "b1", role: "hook", text: hook.text, emphasis: hook.emphasis ?? [] },
        { beatId: "b5", role: "cta", text: cta.text },
      ],
    },
    visualRequests: [],
    page: { pageId: E1_PAGE_ID, styleKitId: e1StyleKit().styleKitId, voiceId: E1_VOICE_ID },
    constraints: { aspect: "9:16", maxMs: E1_MAX_MS, budgetUsd: input.budgetUsd, priority: "normal" },
    output: { master: true },
  });
}
