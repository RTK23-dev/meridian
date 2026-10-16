// One request carried through every stage: request -> DNA -> voice -> plan -> takes -> EDL -> composition
// -> rendered video -> review -> manifest, with the ledger and reservation that pay for it.
// The numbers reconcile across artifacts (costs, durations, ids); the tests check that.

import {
  compositionHash,
  contentHash,
  sumUsd,
  type AudioClip,
  type BudgetLine,
  type BudgetReservation,
  type Composition,
  type CompositionFile,
  type Decision,
  type DnaSegment,
  type EditDecisionList,
  type EditGrammar,
  type GateResult,
  type LedgerEntry,
  type Manifest,
  type ManifestRoleCall,
  type ProductionRequest,
  type RenderedVideo,
  type ReviewResult,
  type ScenePlan,
  type ScriptBeat,
  type ChainCall,
  type ShotSpec,
  type Take,
  type TakeVerdict,
  type ValidatedRequest,
  type VideoDNA,
  type VoiceTrack,
  type Word,
  type AssetSpec,
} from "../index.ts";
import { FIXTURE_IDS as ID } from "./ids.ts";

export const WORKSPACE_ID = "ws_fixture";
export const VOICE_DURATION_MS = 24000;
const CREATED = "2026-10-13T09:00:05.000Z";

export const PROMPT_SHOT1 = "Presenter in a bright kitchen says the opening line to camera, relaxed, no text in frame.";
export const PROMPT_SHOT3 =
  "Slow push-in on a clean kitchen counter, the blender in the centre, soft window light, no text in frame.";
export const PORTRAIT_URI = "store://personas/fixture/portrait-1.png";
export const BLENDER_FRONT_URI = "store://products/fixture-blender-front.png";

// --- Request ---------------------------------------------------------------------------------------------

const beats: ScriptBeat[] = [
  { beatId: "b1", role: "hook", text: "Your kitchen counter is lying to you.", emphasis: ["lying"] },
  { beatId: "b2", role: "setup", text: "Most people clear it twice a day and still feel behind." },
  { beatId: "b3", role: "item", text: "The fix is one blender that lives on the counter.", emphasis: ["one"] },
  { beatId: "b4", role: "proof", text: "It makes four smoothies in under two minutes." },
  { beatId: "b5", role: "cta", text: "Send BLEND to get the link." },
];

export const productionRequestFixture: ProductionRequest = {
  schema: "meridian.production_request/v1",
  requestId: ID.request,
  workspaceId: WORKSPACE_ID,
  format: {
    formatId: "fmt_fixture_rank",
    referenceVideo: "ig:reel/FIXTURE0001",
    keep: ["hook_mechanism", "pacing", "caption_style"],
    change: ["topic", "products"],
  },
  script: { language: "en", beats },
  visualRequests: [{ beatId: "b3", want: "the blender on a clean kitchen counter", strength: "must" }],
  product: { sku: "SKU-FIX-001", productKitId: "pk_fixture", claimIds: ["claim_fixture_1"] },
  page: {
    pageId: "page_fixture",
    styleKitId: "sk_fixture",
    personaId: "persona_fixture",
    voiceId: "voice_fixture",
    characterIds: ["char_fixture"],
  },
  constraints: { aspect: "9:16", maxMs: 30000, budgetUsd: 4, priority: "normal" },
  output: { master: true, variants: { hooks: 2, maxVariants: 4, budgetUsd: 1 } },
};

export const validatedRequestFixture: ValidatedRequest = {
  schema: "meridian.validated_request/v1",
  requestId: ID.request,
  request: productionRequestFixture,
  kits: {
    styleKit: { id: "sk_fixture", version: 3 },
    persona: { id: "persona_fixture", version: 2 },
    voiceId: "voice_fixture",
    characters: [{ id: "char_fixture", version: 1 }],
    productKit: { id: "pk_fixture", version: 1 },
  },
  estimatedSpeechMs: 23500,
};

// --- Reference analysis ----------------------------------------------------------------------------------

const referenceWords: Word[] = [
  { wordId: "r01", text: "Stop", startMs: 100, endMs: 450, confidence: 0.95 },
  { wordId: "r02", text: "scrolling", startMs: 450, endMs: 1000, confidence: 0.94 },
  { wordId: "r03", text: "now", startMs: 3300, endMs: 3600, confidence: 0.93 },
  { wordId: "r04", text: "this", startMs: 9100, endMs: 9400, confidence: 0.96 },
  { wordId: "r05", text: "blender", startMs: 9400, endMs: 10000, confidence: 0.92 },
  { wordId: "r06", text: "trick", startMs: 15200, endMs: 15700, confidence: 0.95 },
];

const referenceSegments: DnaSegment[] = [
  {
    segId: "seg_1",
    startMs: 0,
    endMs: 3000,
    wordIds: ["r01", "r02"],
    shotType: "talking_head",
    layers: { presenter: "creator-face", base: "kitchen-wide" },
    beatRole: "hook",
    motion: 0.3,
    brightness: 0.62,
    loudnessLufs: -17.8,
  },
  {
    segId: "seg_2",
    startMs: 3000,
    endMs: 9000,
    wordIds: ["r03"],
    shotType: "broll_montage",
    layers: { broll: "counter-cleaning" },
    beatRole: "setup",
    motion: 0.6,
    brightness: 0.66,
    loudnessLufs: -20.1,
  },
  {
    segId: "seg_3",
    startMs: 9000,
    endMs: 15000,
    wordIds: ["r04", "r05"],
    shotType: "product_closeup",
    layers: { graphics: "label" },
    onScreenText: "NO MORE CLUTTER",
    beatRole: "item",
    motion: 0.55,
    brightness: 0.7,
    loudnessLufs: -16.9,
  },
  {
    segId: "seg_4",
    startMs: 15000,
    endMs: 28000,
    wordIds: ["r06"],
    shotType: "onscreen_list",
    layers: { graphics: "three-step-list", captions: "lower-band" },
    onScreenText: "3 STEPS",
    beatRole: "payoff",
    motion: 0.2,
    brightness: 0.5,
    loudnessLufs: -19.4,
  },
];

const referenceGrammar: EditGrammar = {
  hookFirstCutMs: 1100,
  hookPayoffMs: 3400,
  shotLengthMs: {
    p25: 1400,
    p50: 1900,
    p75: 2800,
    curve: [2100, 2000, 1900, 1800, 1800, 1700, 1900, 2000, 1700, 1600],
  },
  rehookIntervalMs: 4200,
  captions: { wordsPerCaption: [2, 3], position: "lower", style: "karaoke-bold", highlightCurrentWord: true },
  motion: { punchInsPer10s: 3, punchInScale: 1.1, shakeOnImpact: false, speedRamps: false },
  transitions: [
    { kind: "hard", share: 0.8 },
    { kind: "whip", share: 0.2 },
  ],
  sound: {
    music: true,
    bpm: 112,
    energyCurve: [0.6, 0.7, 0.7, 0.6, 0.5, 0.5, 0.6, 0.7, 0.8, 0.6],
    sfxPer10s: 2,
    silenceBeforePayoffMs: 350,
  },
  endsOnLoop: false,
};

export const videoDnaFixture: VideoDNA = {
  schema: "meridian.video_dna/v1",
  videoDnaId: ID.dna,
  formatId: "fmt_fixture_rank",
  sourceRef: "ig:reel/FIXTURE0001",
  durationMs: 28000,
  transcript: { words: referenceWords },
  segments: referenceSegments,
  genome: {
    hook_mechanism: "claim in the first second, then the proof",
    pacing: "a cut every 1.8 seconds",
    caption_style: "two to three word captions, lower band",
  },
  editGrammar: referenceGrammar,
  transferable: ["hook_mechanism", "pacing", "caption_style"],
  notTransferable: ["footage", "voice", "music", "script lines"],
  sourceDeletedAt: "2026-10-13T11:00:00.000Z",
};

// --- Voice -----------------------------------------------------------------------------------------------

const beatSpanBounds: [number, number][] = [
  [0, 3000],
  [3000, 9000],
  [9000, 15000],
  [15000, 21000],
  [21000, 24000],
];

/** Spread a beat's words evenly over its span, in whole milliseconds. */
function spreadWords(texts: string[], startMs: number, endMs: number, firstIndex: number): Word[] {
  const span = endMs - startMs;
  return texts.map((text, i) => ({
    wordId: `v${String(firstIndex + i).padStart(2, "0")}`,
    text,
    startMs: startMs + Math.round((span * i) / texts.length),
    endMs: startMs + Math.round((span * (i + 1)) / texts.length),
    confidence: 0.98,
  }));
}

function scriptTokens(text: string): string[] {
  return text.replace(/[.,]/g, "").split(/\s+/);
}

const voiceWords: Word[] = [];
beats.forEach((beat, i) => {
  const [startMs, endMs] = beatSpanBounds[i];
  voiceWords.push(...spreadWords(scriptTokens(beat.text), startMs, endMs, voiceWords.length + 1));
});

export const voiceTrackFixture: VoiceTrack = {
  schema: "meridian.voice_track/v1",
  voiceTrackId: "vt_fixture_1",
  requestId: ID.request,
  voiceId: "voice_fixture",
  provider: "fixture-tts",
  audioUri: "store://voice/vt_fixture_1.wav",
  durationMs: VOICE_DURATION_MS,
  lufs: -15.2,
  words: voiceWords,
  beatSpans: beats.map((beat, i) => ({
    beatId: beat.beatId,
    startMs: beatSpanBounds[i][0],
    endMs: beatSpanBounds[i][1],
  })),
};

// --- Plan, shots and visual decisions --------------------------------------------------------------------

const shots: ShotSpec[] = [
  {
    shotId: ID.shot1,
    beatId: "b1",
    startMs: 0,
    endMs: 3000,
    visualType: "ugc_presenter",
    layer: "presenter",
    source: {
      kind: "generate",
      modelClass: "avatar",
      prompt: PROMPT_SHOT1,
      refs: [PORTRAIT_URI],
      takes: 1,
    },
    downgradeTo: "kinetic_type",
  },
  {
    shotId: ID.shot2,
    beatId: "b2",
    startMs: 3000,
    endMs: 9000,
    visualType: "stock_footage",
    layer: "base",
    source: { kind: "stock", query: "morning kitchen counter cleaning", minMs: 6000 },
  },
  {
    shotId: ID.shot3,
    beatId: "b3",
    startMs: 9000,
    endMs: 15000,
    visualType: "product_hero",
    layer: "base",
    source: {
      kind: "generate",
      modelClass: "video.budget",
      prompt: PROMPT_SHOT3,
      refs: [BLENDER_FRONT_URI],
      firstFrame: BLENDER_FRONT_URI,
      takes: 1,
    },
    mustSatisfy: "the blender on a clean kitchen counter",
    downgradeTo: "coded_graphics",
  },
  {
    shotId: ID.shot4,
    beatId: "b4",
    startMs: 15000,
    endMs: 21000,
    visualType: "coded_graphics",
    layer: "graphics",
    source: {
      kind: "component",
      component: "product.card",
      props: {
        name: "Fixture Blender",
        bullets: ["Four smoothies", "Under two minutes", "Fits the counter"],
      },
    },
  },
  {
    shotId: ID.shot5,
    beatId: "b5",
    startMs: 21000,
    endMs: 24000,
    visualType: "coded_graphics",
    layer: "graphics",
    source: {
      kind: "component",
      component: "cta.card",
      props: { text: "Send BLEND to get the link", keyword: "BLEND", arrow: "down" },
    },
  },
];

export const scenePlanFixture: ScenePlan = {
  schema: "meridian.scene_plan/v1",
  planId: "plan_fixture_1",
  requestId: ID.request,
  videoDnaId: ID.dna,
  voiceTrackId: "vt_fixture_1",
  shots,
  // Generation only: shot 1 (3 s avatar at $0.05/s) and shot 3 (6 s at $0.0336/s); the rest is code or stock.
  estimatedUsd: 0.3516,
  decisions: [
    {
      at: "b1",
      chose: "ugc_presenter",
      alternatives: [
        { option: "kinetic_type", score: 0.44 },
        { option: "react_clip", score: 0.39 },
      ],
      reason: "A confession hook needs a face in the first second.",
      by: "scorer",
    },
    {
      at: ID.shot3,
      chose: "product_hero",
      alternatives: [
        { option: "cinematic", score: 0.58 },
        { option: "stock_footage", score: 0.41 },
      ],
      reason: "The hero image is pinned as the first frame, so the product stays real.",
      by: "director",
    },
  ],
};

// --- Chains (contract v5, Bible 7.1): a shot whose source is several paid calls, each reading earlier outputs ----------------

export const CHARACTER_SHEET_URI = "store://characters/fixture/sheet-1.png";
const CARTOON_KEYFRAME_PROMPT = "A stylised cartoon character stands on a clean kitchen counter, arms open, no text in frame.";
const CARTOON_CLIP_PROMPT = "The cartoon character hops once and settles, camera static, soft light, no text in frame.";
const STOP_MOTION_PROMPT = "A small clay character hops beside the blender on a clean counter, held poses, no text in frame.";
const STOP_MOTION_FRAMES = 30;

/**
 * A cartoon_generated shot (7.1): the style keyframe is one image call, and the 3 s clip is a video call that starts from it.
 * Both calls read the character sheet. Its estimate is 0.018 (one image) plus 3 s at $0.0336 a second.
 */
export const cartoonChainShotFixture: ShotSpec = {
  shotId: ID.shotCartoonChain,
  beatId: "b1",
  startMs: 0,
  endMs: 3000,
  visualType: "cartoon_generated",
  layer: "base",
  source: {
    kind: "chain",
    calls: [
      {
        output: "keyframe",
        modelClass: "image.keyframe",
        prompt: CARTOON_KEYFRAME_PROMPT,
        refs: [{ kind: "asset", uri: CHARACTER_SHEET_URI }],
        takes: 1,
      },
      {
        output: "clip",
        modelClass: "video.budget",
        prompt: CARTOON_CLIP_PROMPT,
        refs: [{ kind: "asset", uri: CHARACTER_SHEET_URI }],
        firstFrame: { kind: "output", output: "keyframe" },
        takes: 1,
      },
    ],
  },
  downgradeTo: "cartoon_rigged",
};

/**
 * A stop_motion shot (7.1): 30 image-edit frames from the hero image, each reading the hero and the frame before it, over 2.5 s.
 * The closing player is a component, not a call, so it is not in the chain (contract v5 note). Its image-edit price is unknown,
 * so the estimate refuses it, naming the shot.
 */
export const stopMotionChainShotFixture: ShotSpec = {
  shotId: ID.shotStopChain,
  beatId: "b3",
  startMs: 9000,
  endMs: 11500,
  visualType: "stop_motion",
  layer: "base",
  source: {
    kind: "chain",
    calls: Array.from({ length: STOP_MOTION_FRAMES }, (_, index): ChainCall => {
      const name = `frame_${String(index + 1).padStart(2, "0")}`;
      const hero = { kind: "asset" as const, uri: BLENDER_FRONT_URI };
      const previous = index === 0 ? [] : [{ kind: "output" as const, output: `frame_${String(index).padStart(2, "0")}` }];
      return { output: name, modelClass: "image.edit", prompt: STOP_MOTION_PROMPT, refs: [hero, ...previous], takes: 1 };
    }),
  },
  downgradeTo: "product_hero",
};

/**
 * The fixture plan with its first shot drawn by the cartoon chain instead of a presenter. The shots come to 0.3204: the chain
 * (0.1188) and shot 3 (0.2016). Other shots and decisions are the fixture's.
 */
export const scenePlanChainFixture: ScenePlan = {
  ...scenePlanFixture,
  planId: "plan_fixture_chain",
  shots: [cartoonChainShotFixture, ...scenePlanFixture.shots.slice(1)],
  estimatedUsd: 0.3204,
  decisions: [
    {
      at: "b1",
      chose: "cartoon_generated",
      alternatives: [],
      reason: "The beat is a sketch joke; a cartoon keyframe carries the character, and the page's character sheet is available.",
      by: "scorer",
    },
    ...scenePlanFixture.decisions.slice(1),
  ],
};

// An editor decision (contract v4, Bible L7). Its subject is an EDL clip: `at` is the clip id (edlFixture, track base). The
// cut into it is sampled from the grammar's transition mix (hard 0.8, whip 0.2) with the request's seed, and came out hard.
export const editorDecisionFixture: Decision = {
  at: "c_base_3",
  chose: "hard",
  alternatives: [{ option: "whip", score: 0.2 }],
  reason: "The cut into this clip is sampled from the grammar's transition mix (hard 0.8, whip 0.2) with the request seed; it came out hard.",
  by: "editor",
};

export const assetSpecFixture: AssetSpec = {
  schema: "meridian.asset_spec/v1",
  specId: ID.asset,
  shotId: ID.shot3,
  modelClass: "video.budget",
  prompt: PROMPT_SHOT3,
  refs: [BLENDER_FRONT_URI],
  firstFrame: BLENDER_FRONT_URI,
  durationMs: 6000,
  aspect: "9:16",
  width: 1080,
  height: 1920,
  seed: 421337,
  takes: 1,
};

// --- Takes and verdicts ----------------------------------------------------------------------------------

export const take1Fixture: Take = {
  schema: "meridian.take/v1",
  takeId: ID.take1,
  shotId: ID.shot1,
  attempt: 1,
  provider: "openrouter",
  model: "avatar-iv",
  uri: "store://takes/take1.mp4",
  durationMs: 3000,
  width: 1080,
  height: 1920,
  promptHash: contentHash(PROMPT_SHOT1),
  costUsd: 0.15,
  latencyMs: 41000,
};

export const take2Fixture: Take = {
  schema: "meridian.take/v1",
  takeId: ID.take2,
  shotId: ID.shot2,
  attempt: 1,
  provider: "pexels",
  model: "video-search",
  uri: "store://takes/take2.mp4",
  durationMs: 6000,
  width: 1080,
  height: 1920,
  promptHash: contentHash("morning kitchen counter cleaning"),
  costUsd: 0,
  latencyMs: 900,
};

export const take3aFixture: Take = {
  schema: "meridian.take/v1",
  takeId: ID.take3a,
  shotId: ID.shot3,
  attempt: 1,
  provider: "openrouter",
  model: "seedance-2.0-mini",
  uri: "store://takes/take3a.mp4",
  durationMs: 6000,
  width: 1080,
  height: 1920,
  promptHash: contentHash(PROMPT_SHOT3),
  costUsd: 0.2016,
  latencyMs: 96000,
};

export const take3bFixture: Take = {
  ...take3aFixture,
  takeId: ID.take3b,
  attempt: 2,
  uri: "store://takes/take3b.mp4",
  latencyMs: 88000,
};

export const takeVerdictFixture: TakeVerdict = {
  takeId: ID.take1,
  pass: true,
  confidence: 0.91,
  checks: [
    { rule: "duration_within_10pct", pass: true, score: 1 },
    { rule: "black_or_frozen_frames", pass: true },
    { rule: "slop.hands", pass: true, score: 0.92 },
    { rule: "slop.faces", pass: true, score: 0.88 },
  ],
  action: "accept",
};

export const takeVerdictRedoFixture: TakeVerdict = {
  takeId: ID.take3a,
  pass: false,
  confidence: 0.84,
  checks: [
    { rule: "duration_within_10pct", pass: true, score: 1 },
    { rule: "slop.hands", pass: false, score: 0.41, detail: "fingers merge into the blender handle", atMs: 2400 },
  ],
  action: "redo",
};

export const takeVerdictAcceptFixture: TakeVerdict = {
  takeId: ID.take3b,
  pass: true,
  confidence: 0.88,
  checks: [
    { rule: "duration_within_10pct", pass: true, score: 1 },
    { rule: "product_match", pass: true, score: 0.91 },
    { rule: "slop.hands", pass: true, score: 0.86 },
  ],
  action: "accept",
};

export const takeVerdictStockFixture: TakeVerdict = {
  takeId: ID.take2,
  pass: true,
  confidence: 0.95,
  checks: [
    { rule: "duration_within_10pct", pass: true, score: 1 },
    { rule: "palette_share", pass: true, score: 0.78 },
  ],
  action: "accept",
};

export const takesFixture: Take[] = [take1Fixture, take2Fixture, take3aFixture, take3bFixture];
export const takeVerdictsFixture: TakeVerdict[] = [
  takeVerdictFixture,
  takeVerdictStockFixture,
  takeVerdictRedoFixture,
  takeVerdictAcceptFixture,
];

// --- Edit decision list ----------------------------------------------------------------------------------

const voiceClip: AudioClip = { uri: "store://voice/vt_fixture_1.wav", startMs: 0, endMs: VOICE_DURATION_MS, gainDb: 0 };

export const edlFixture: EditDecisionList = {
  schema: "meridian.edl/v1",
  edlId: ID.edl,
  requestId: ID.request,
  durationMs: VOICE_DURATION_MS,
  fps: 30,
  width: 1080,
  height: 1920,
  tracks: [
    {
      layer: "presenter",
      clips: [{ clipId: "c_presenter_1", startMs: 0, endMs: 3000, srcUri: take1Fixture.uri, srcInMs: 0 }],
    },
    {
      layer: "base",
      clips: [
        { clipId: "c_base_2", startMs: 3000, endMs: 9000, srcUri: take2Fixture.uri, srcInMs: 0, transitionIn: "hard" },
        { clipId: "c_base_3", startMs: 9000, endMs: 15000, srcUri: take3bFixture.uri, srcInMs: 0, transitionIn: "hard" },
      ],
    },
    {
      layer: "graphics",
      clips: [
        {
          clipId: "c_gfx_4",
          startMs: 15000,
          endMs: 21000,
          component: "product.card",
          props: { name: "Fixture Blender" },
          box: { x: 60, y: 900, w: 960, h: 700 },
        },
        {
          clipId: "c_gfx_5",
          startMs: 21000,
          endMs: 24000,
          component: "cta.card",
          props: { text: "Send BLEND to get the link" },
          box: { x: 60, y: 900, w: 960, h: 500 },
        },
      ],
    },
    {
      layer: "captions",
      clips: [{ clipId: "c_cap_1", startMs: 0, endMs: VOICE_DURATION_MS, component: "captions.karaoke", props: {} }],
    },
  ],
  audio: {
    voice: voiceClip,
    music: { uri: "store://music/fixture-bed.wav", startMs: 0, endMs: VOICE_DURATION_MS, gainDb: -12, duckDb: -18 },
    sfx: [{ uri: "store://sfx/whoosh.wav", startMs: 8950, endMs: 9600, gainDb: -6 }],
    masterLufs: -14,
  },
  effects: [{ atMs: 1200, kind: "punch_in", params: { scale: 1.1 } }],
  seed: 421337,
};

// --- Composition and render ------------------------------------------------------------------------------

const encoder = new TextEncoder();

function compositionFile(path: string, text: string): CompositionFile {
  const bytes = encoder.encode(text);
  return { path, contentHash: contentHash(bytes), bytes: bytes.byteLength };
}

const compositionFiles: CompositionFile[] = [
  compositionFile("index.html", '<!doctype html><html><body><div id="root"></div></body></html>'),
  compositionFile("components/product-card.html", '<div class="product-card"></div>'),
  compositionFile("components/cta-card.html", '<div class="cta-card"></div>'),
  compositionFile("components/captions-karaoke.html", '<div class="captions"></div>'),
];

export const compositionFixture: Composition = {
  schema: "meridian.composition/v1",
  compositionId: ID.composition,
  edlId: ID.edl,
  rootFile: "index.html",
  files: compositionFiles,
  assetUris: [take1Fixture.uri, take2Fixture.uri, take3bFixture.uri, voiceClip.uri, "store://music/fixture-bed.wav"],
  contentHash: compositionHash(compositionFiles),
};

export const renderedVideoFixture: RenderedVideo = {
  videoId: ID.video,
  edlId: ID.edl,
  uri: "store://renders/vid_fixture.mp4",
  renderer: "hyperframes-cloud",
  durationMs: VOICE_DURATION_MS,
  bytes: 6400000,
  estimateUsd: 0.05,
  costUsd: 0.047,
  idempotencyKey: compositionFixture.contentHash,
};

// --- Gates, review and manifest --------------------------------------------------------------------------

const gateResults: GateResult[] = [
  {
    gate: "request",
    subjectId: ID.request,
    pass: true,
    checks: [
      { rule: "schema_valid", pass: true },
      { rule: "estimated_speech_within_maxMs_plus_10pct", pass: true, value: 23500, limit: 33000 },
      { rule: "claims_approved", pass: true },
    ],
  },
  {
    gate: "dna",
    subjectId: ID.dna,
    pass: true,
    checks: [
      { rule: "segments_at_least_3", pass: true, value: 4, limit: 3 },
      { rule: "transcript_present", pass: true },
      { rule: "source_deletion_scheduled", pass: true },
    ],
  },
  {
    gate: "voice",
    subjectId: "vt_fixture_1",
    pass: true,
    checks: [
      { rule: "word_error_rate", pass: true, value: 0, limit: 0.03 },
      { rule: "duration_within_maxMs", pass: true, value: VOICE_DURATION_MS, limit: 30000 },
      { rule: "lufs_measurable", pass: true },
    ],
  },
  {
    gate: "plan",
    subjectId: "plan_fixture_1",
    pass: true,
    checks: [
      { rule: "shots_tile_voice_duration", pass: true },
      { rule: "must_satisfied", pass: true },
      { rule: "generated_shots_have_downgrade", pass: true },
      { rule: "estimate_within_budget", pass: true, value: 0.9595, limit: 4 },
    ],
  },
  {
    gate: "budget",
    subjectId: ID.reservation,
    pass: true,
    checks: [{ rule: "reservation_succeeded", pass: true }],
  },
  {
    gate: "take",
    subjectId: ID.take3b,
    pass: true,
    checks: [
      { rule: "duration_within_10pct", pass: true, value: 6000, limit: 6600 },
      { rule: "product_match", pass: true, value: 0.91, limit: 0.85 },
    ],
  },
  {
    gate: "edit",
    subjectId: ID.edl,
    pass: true,
    checks: [
      { rule: "no_cut_inside_word", pass: true, value: 0, limit: 0 },
      { rule: "shot_length_bounds", pass: true },
      { rule: "loudness_lufs", pass: true, value: -14, limit: -14 },
    ],
  },
  {
    gate: "pre_render",
    subjectId: ID.composition,
    pass: true,
    checks: [
      { rule: "slideshow_risk", pass: true, value: 0.22, limit: 0.35 },
      { rule: "safe_zones", pass: true },
      { rule: "rights_recorded", pass: true },
    ],
  },
  {
    gate: "render_integrity",
    subjectId: ID.video,
    pass: true,
    checks: [
      { rule: "resolution_1080x1920", pass: true },
      { rule: "fps_30", pass: true },
      { rule: "duration_within_100ms", pass: true, value: VOICE_DURATION_MS, limit: 24100 },
    ],
  },
];

export const postRenderGateFixture: ReviewResult["result"] = {
  gate: "post_render",
  subjectId: ID.video,
  pass: true,
  checks: [
    { rule: "frames_at_cuts", pass: true },
    { rule: "loudness_lufs_pm1", pass: true, value: -14.1, limit: -14 },
    { rule: "true_peak_dbtp", pass: true, value: -1.4, limit: -1 },
    { rule: "captions_timing_ms", pass: true, value: 60, limit: 150 },
    { rule: "claims_on_screen", pass: true },
  ],
};

export const reviewResultFixture: ReviewResult = {
  schema: "meridian.review_result/v1",
  videoId: ID.video,
  result: postRenderGateFixture,
  failures: [],
};

export const gateResultFixture: GateResult = gateResults[5];

const budgetLines: BudgetLine[] = [
  { stage: "produce_shot", shotId: ID.shot1, provider: "heygen_avatar_iv", estimateUsd: 0.15 },
  { stage: "produce_shot", shotId: ID.shot2, provider: "pexels", estimateUsd: 0 },
  { stage: "produce_shot", shotId: ID.shot3, provider: "seedance_2_0_mini", estimateUsd: 0.2016 },
  { stage: "produce_shot", shotId: ID.shot4, provider: "code_component", estimateUsd: 0 },
  { stage: "produce_shot", shotId: ID.shot5, provider: "code_component", estimateUsd: 0 },
  { stage: "claude_roles", estimateUsd: 0.4 },
  { stage: "critic", estimateUsd: 0.05 },
  { stage: "render", estimateUsd: 0.05 },
  { stage: "media", estimateUsd: 0.02 },
];

export const budgetReservationFixture: BudgetReservation = {
  schema: "meridian.budget_reservation/v1",
  reservationId: ID.reservation,
  requestId: ID.request,
  workspaceId: WORKSPACE_ID,
  mode: "cap",
  lines: budgetLines,
  estimateUsd: sumUsd(budgetLines.map((line) => line.estimateUsd)),
  redoAllowanceUsd: 0.0879,
  reservedUsd: 0.9595,
  state: "reserved",
  createdAt: CREATED,
};

export const ledgerRenderFixture: LedgerEntry = {
  entryId: ID.ledgerRender,
  requestId: ID.request,
  stage: "render",
  provider: "hyperframes-cloud",
  model: "hyperframes",
  estimateUsd: 0.05,
  reservedUsd: 0.05,
  actualUsd: 0.047,
  settlement: "billed",
  idempotencyKey: compositionFixture.contentHash,
  at: "2026-10-13T09:06:00.000Z",
};

export const ledgerSttFixture: LedgerEntry = {
  entryId: ID.ledgerStt,
  requestId: ID.request,
  stage: "voice",
  provider: "fixture-stt",
  model: "word-timestamps",
  estimateUsd: 0.02,
  reservedUsd: 0.02,
  actualUsd: 0.02,
  settlement: "billed",
  idempotencyKey: `voice:${ID.request}`,
  at: "2026-10-13T09:00:40.000Z",
};

export const ledgerShot3Fixture: LedgerEntry = {
  entryId: ID.ledgerShot3,
  requestId: ID.request,
  stage: "produce_shot",
  provider: "openrouter",
  model: "seedance-2.0-mini",
  estimateUsd: 0.2016,
  reservedUsd: 0.2016,
  actualUsd: 0.2016,
  settlement: "billed",
  idempotencyKey: `produce:${ID.shot3}:1`,
  at: "2026-10-13T09:02:10.000Z",
};

// A Claude call, traced to its role and prompt version (LedgerEntry, contract v2). The estimate is the planner's
// 20k in and 4k out at the Opus 5.5 rate (Bible 11.1): $0.16. The actual is 19k in and 3.3k out.
export const ledgerClaudeFixture: LedgerEntry = {
  entryId: ID.ledgerPlanner,
  requestId: ID.request,
  stage: "plan",
  provider: "openrouter",
  model: "anthropic/claude-opus-5.5",
  estimateUsd: 0.16,
  reservedUsd: 0.16,
  actualUsd: 0.142,
  settlement: "billed",
  idempotencyKey: contentHash({ role: "planner", promptVersion: "planner@1", model: "anthropic/claude-opus-5.5", input: ID.request }),
  at: "2026-10-13T09:01:30.000Z",
  role: "planner",
  promptVersion: "planner@1",
};

// A frame_reader call (contract v4): Haiku reads the captions, shake and speed ramps of the sampled frames, as measurements.
// The estimate is 12k in and 1k out at Haiku's $1 / $5 (the proposed Bible 11.1 row, not yet confirmed); the actual is 11.2k
// in and 0.9k out.
export const ledgerFrameReaderFixture: LedgerEntry = {
  entryId: ID.ledgerFrameReader,
  requestId: ID.request,
  stage: "analyze_reference",
  provider: "openrouter",
  model: "anthropic/claude-haiku-5.5",
  estimateUsd: 0.017,
  reservedUsd: 0.017,
  actualUsd: 0.0157,
  settlement: "billed",
  idempotencyKey: contentHash({ role: "frame_reader", promptVersion: "frame_reader@1", model: "anthropic/claude-haiku-5.5", input: ID.request }),
  at: "2026-10-13T09:01:50.000Z",
  role: "frame_reader",
  promptVersion: "frame_reader@1",
};

const generatedUsd = takesFixture.map((take) => take.costUsd);

// Role calls of the video (manifest v2). The planner is the ledger's planner call (ledgerClaudeFixture): same cost. The
// director check is an invalid answer: no answer was used, its cost is unknown, so it is held as the estimate and stays null.
export const manifestRoleCallsFixture: ManifestRoleCall[] = [
  {
    role: "planner",
    promptVersion: "planner@1",
    model: "anthropic/claude-opus-5.5",
    answeredBy: "anthropic/claude-opus-5.5",
    generationId: "gen-fixture-planner-1",
    tokens: { prompt: 19000, completion: 3300 },
    costUsd: 0.142,
    verdict: "answered",
  },
  {
    role: "critic_take",
    promptVersion: "critic_take@1",
    model: "anthropic/claude-haiku-5.5",
    answeredBy: "anthropic/claude-haiku-5.5",
    generationId: "gen-fixture-critic-1",
    tokens: { prompt: 2100, completion: 180 },
    costUsd: 0.003,
    verdict: "answered",
  },
  {
    role: "director_check",
    promptVersion: "director_check@1",
    model: "anthropic/claude-opus-5.5",
    answeredBy: null,
    generationId: "gen-fixture-director-1",
    tokens: { prompt: null, completion: null },
    costUsd: null,
    verdict: "invalid_answer",
  },
];

export const manifestFixture: Manifest = {
  schema: "meridian.manifest/v2",
  videoId: ID.video,
  requestId: ID.request,
  formatId: "fmt_fixture_rank",
  videoDnaId: ID.dna,
  genome: videoDnaFixture.genome,
  promptVersions: {
    planner: "planner@1",
    director_check: "director_check@1",
    critic_take: "critic_take@1",
    critic_final: "critic_final@1",
  },
  shots: [
    { shotId: ID.shot1, visualType: "ugc_presenter", takeId: ID.take1, provider: "openrouter", model: "avatar-iv", attempts: 1 },
    { shotId: ID.shot2, visualType: "stock_footage", takeId: ID.take2, provider: "pexels", model: "video-search", attempts: 1 },
    { shotId: ID.shot3, visualType: "product_hero", takeId: ID.take3b, provider: "openrouter", model: "seedance-2.0-mini", attempts: 2 },
  ],
  gates: [...gateResults, postRenderGateFixture],
  decisions: [...scenePlanFixture.decisions, editorDecisionFixture],
  cost: {
    brain: 0.44,
    generation: sumUsd(generatedUsd),
    render: 0.047,
    other: 0.02,
    total: sumUsd([0.44, sumUsd(generatedUsd), 0.047, 0.02]),
  },
  disclosures: { aiGeneratedPeople: true, paidPartnership: false },
  timings: {
    intake: 800,
    analyze_reference: 0,
    voice: 10400,
    plan: 41000,
    produce_shot: 210000,
    check_take: 9000,
    edit: 120,
    compose: 800,
    pre_render_gate: 300,
    render: 96000,
    post_render_review: 30000,
  },
  roleCalls: manifestRoleCallsFixture,
};
