// Style preset: the 3D satellite data explainer. Built on 2026-10-31 from one uploaded reference (60 s, 720x1280, 30 fps), with
// Meridian's own media functions (functions/ffmpeg) and the engine's pure analysis code (analyze/zoom.ts, edit/grammar.ts). The
// paid steps of analyze_reference (speech-to-text, segmenter, genome, frame_reader) were not run: they need a live key and spend.
//
// Every field says where it came from (`source`):
// - "measured": a number from the media functions or the engine's analysis code, on the reference file.
// - "read": read from the reference's frames by the coding agent in the session, not by the engine's frame_reader role. It is an
//   observation, not a measurement, and the full analysis may change it.
// - "chosen": a choice the preset makes to fit the existing contracts (for example a font family). The owner can change it.
// The genes, not the content: no footage, voice, music or script line of the reference is stored here (CLAUDE.md rule 6).

import type { StyleKit } from "../contracts/index.ts";
import type { StylePreset } from "./style-presets.ts";

/** The reference's SHA-256 (hex). The Content Factory names a reference's format `ref_` plus its first 24 characters. */
export const REFERENCE_SHA256 = "98053a5a224b3833a3ed4421818f8c6f6d623cac99e6c017585ccc6bb1706377";

/** The style kit, in the engine's contract (styleKitSchema). It is what the kit store keeps and what a theme page names. */
export const threeDDataExplainerKit: StyleKit = {
  styleKitId: "sk_3d_data_explainer",
  version: 1,
  pageId: "preset_3d_data_explainer",
  palette: {
    primary: "#307080", // read: the teal data bars of the dark data room (sampled at 17 s)
    secondary: "#A8D8D8", // read: the light cyan of the highlighted bars (sampled at 17 s)
    accent: "#F0C048", // read: the gold of the italic hook accent (sampled at 1 s)
    text: "#F8F8F8", // read: the white title and caption text (sampled at 1 s)
    background: "#000010", // read: the navy-black of the data room panels (sampled at 17 s)
  },
  fonts: {
    display: "Inter", // chosen: a bold geometric sans like the reference's titles; the reference's font is not identified
    body: "Inter", // chosen
    captions: "Inter", // chosen
  },
  captionStyle: {
    component: "captions.karaoke", // chosen: the only caption component the compose library draws today
    highlight: "#F0E860", // read: the yellow of the current-word highlight (sampled at 2.5 s)
    weight: 700, // read: bold captions
    case: "sentence", // read: captions keep sentence case
  },
  motionIntensity: 1, // read and measured: slow, smooth camera flights; mean motion energy 0.020 on a 0 to 1 scale
  preferredTypes: ["cinematic", "coded_graphics", "kinetic_type"], // read: 3D aerial flights, data panels, the hook title
  bannedTypes: ["ugc_presenter", "react_clip", "cartoon_rigged", "cartoon_generated", "stop_motion"], // read: none of these appear
  musicGenres: [], // unknown: music was not separated from the voice without the speech-to-text step
  outroMs: 3542, // measured: the last shot, from the last scene cut (56,467 ms) to the end (60,009 ms)
  stickers: [],
};

export const threeDDataExplainer: StylePreset = {
  presetId: "3d_data_explainer",
  version: 2,
  label: "3D satellite data explainer",
  summary:
    "A calm, documentary explainer: slow 3D camera flights over satellite and aerial scenes, numbers anchored in the scene, a dark " +
    "3D data room for the proof, one word at a time captions with a yellow highlight, and a last shot that returns to the opening scene.",
  reference: {
    formatId: `ref_${REFERENCE_SHA256.slice(0, 24)}`,
    sha256: REFERENCE_SHA256,
    durationMs: 60009,
    width: 720,
    height: 1280,
    fps: 30,
    analysedOn: "2026-10-31",
  },
  styleKit: threeDDataExplainerKit,
  look: { preset: "cool", strength: 0.25, source: "chosen" },
  grammar: {
    measured: {
      cutsMs: [6767, 9867, 13300, 16333, 21967, 38700, 43367, 54400, 56467],
      sceneCutScore: 0.3,
      hookFirstCutMs: 6767,
      shotLengthMs: { p25: 3183, p50: 4105, p75: 6484 },
      zoomJumps: [
        { atMs: 4400, scale: 1.64 },
        { atMs: 22600, scale: 1.18 },
        { atMs: 23900, scale: 0.78 },
        { atMs: 25200, scale: 1.33 },
        { atMs: 26000, scale: 3.06 },
        { atMs: 51200, scale: 1.29 },
        { atMs: 52700, scale: 1.52 },
        { atMs: 55300, scale: 1.8 },
      ],
      punchInsPer10s: 1.17,
      punchInScale: 1.52,
      patternInterruptMedianMs: 2700,
      meanMotion: 0.02,
      flickerScore: 0.013,
      integratedLufs: -14.1,
      truePeakDbtp: -1.1,
      loudnessRangeLu: 2.8,
      loudnessTenthsLufs: [-18.3, -15.0, -14.8, -16.3, -14.6, -15.1, -14.8, -18.5, -15.6, -23.3],
      silencesMs: [
        { startMs: 42905, endMs: 43390 },
        { startMs: 58877, endMs: 59140 },
        { startMs: 59159, endMs: 59927 },
      ],
      loopDistance: 0.101,
      endsOnLoop: false,
    },
    read: {
      captions: { wordsPerCaption: [1, 3], position: "lower", highlightCurrentWord: true },
      captionLook:
        "White bold sans, centred at about 73% of the height. The spoken word sits in a filled yellow box with dark text; the words " +
        "still to come are dimmed.",
      hookTitle:
        "Two lines at the top in the first frame: a bold white claim, then its last words in a gold italic serif. A live counter " +
        "with a small dark pill label sits under it.",
      camera:
        "Continuous 3D camera flights instead of hard cuts: a pull-up from a parking lot to orbit, a push-in from the globe to a " +
        "region, slow orbits around single objects. That is why 9 hard cuts carry about 17 pattern interrupts.",
      transitions:
        "Mostly camera moves and match cuts between scenes of the same kind (aerial to aerial, panel to panel). No flashes or whips seen.",
      endsOnLoopNote:
        "The last shot returns to the opening scene (the parking lot), but the frames differ (distance 0.101, the loop test needs " +
        "at most 0.04), so the engine reads it as no loop. It is a thematic loop, not a frame loop.",
    },
    unknown: [
      "speech: words, pace and speech spans (speech-to-text was not run)",
      "segments, shot types and beat roles (the segmenter role was not run)",
      "genome: the genes in the reference's own terms (the genome role was not run)",
      "shakeOnImpact and speedRamps (the frame_reader role was not run)",
      "music, tempo, energy curve and sound effects per 10 s (they need the speech spans to separate music from voice)",
    ],
  },
  // Version 2: the layout the first render from this preset had to choose (docs/engine/STYLE_PRESET_3D_DATA_EXPLAINER.md, section 7).
  // Positions and sizes were read from the reference's frames and are approximate; "chosen" marks a value the reference did not give.
  layout: {
    title: {
      topFrac: 0.075,
      sizeFracOfWidth: 0.07,
      accent: "the last words of the second line, in an italic serif, in the accent colour",
      visibleUntilMs: 4300,
      source: "read",
    },
    counter: {
      topFrac: 0.2,
      sizeFracOfWidth: 0.09,
      behaviour: "counts up the objects marked in the shot, with a pill label under the number",
      source: "read",
    },
    pill: { background: "#485058", sizeFracOfWidth: 0.021, letterSpacingEm: 0.15, source: "read" },
    captions: { topFrac: 0.72, sizeFracOfWidth: 0.047, highlight: "box", upcomingOpacity: 0.45, source: "read" },
    rings: { colourRole: "secondary", strokeFracOfWidth: 0.004, glow: true, appearEveryMs: 400, source: "chosen" },
    room: {
      background: "#000010",
      lightStrips: "narrow white ceiling strips receding to a vanishing point above the panels",
      panel: "navy panel, thin light border, bold white title on the left, small grey label on the right",
      bigNumberColourRole: "accent",
      source: "read",
    },
    follow: { fromEndMs: 2000, colour: null, source: "read" },
    zoomJumpKinds: [
      { atMs: 4400, kind: "camera_move" },
      { atMs: 22600, kind: "punch" },
      { atMs: 23900, kind: "punch" },
      { atMs: 25200, kind: "punch" },
      { atMs: 26000, kind: "camera_move" },
      { atMs: 51200, kind: "punch" },
      { atMs: 52700, kind: "punch" },
      { atMs: 55300, kind: "punch" },
    ],
  },
  structure: [
    {
      role: "hook",
      fromMs: 0,
      toMs: 4400,
      intent: "A surprising claim over a concrete scene, with a number counting up in the scene.",
      visual: "Top-down aerial of the subject, objects outlined in the data colour, a live counter with a pill label.",
    },
    {
      role: "setup",
      fromMs: 4400,
      toMs: 6767,
      intent: "Reveal the method in one camera move.",
      visual: "Continuous pull-up from the scene to a satellite view.",
    },
    {
      role: "item",
      fromMs: 6767,
      toMs: 16333,
      intent: "First case: compare two places by the same count, name the company, place the count before the official date.",
      visual: "Two aerials side by side in time, counters, an up or down pill, a logo card, a timeline from count to announcement.",
    },
    {
      role: "proof",
      fromMs: 16333,
      toMs: 30000,
      intent: "Show the result as data, then contrast with what ordinary people see.",
      visual: "Dark 3D data room: bar chart, two-line chart split at the event, one large percentage; then a 3D phone prop.",
    },
    {
      role: "item",
      fromMs: 30000,
      toMs: 43367,
      intent: "Second case: a physical sign that reveals a hidden number, explained in three steps.",
      visual: "Low orbit around one object, then a wide view of many, each outlined with a glow, ending on a big count.",
    },
    {
      role: "item",
      fromMs: 43367,
      toMs: 54400,
      intent: "Third case with a date and place: an event seen early, and the price move it caused.",
      visual: "Aerial with a place and date pill, then data panels: a forecast image, a price chart with the move window marked.",
    },
    {
      role: "payoff",
      fromMs: 54400,
      toMs: 56467,
      intent: "Name the idea that joins the cases, and the gap between those who see it and those who wait.",
      visual: "One panel holding the three cases as tiles; an estimate against an unknown official number; a 3D balance prop.",
    },
    {
      role: "cta",
      fromMs: 56467,
      toMs: 60009,
      intent: "Return to the opening scene and ask to follow, on a closing line.",
      visual: "The opening aerial again, with a follow button.",
    },
  ],
  genes: {
    keep: ["hook_mechanism", "structure", "proof_device", "edit_grammar", "pacing", "caption_style", "emotional_arc"],
    change: [
      "the subject, the cases, the numbers and every line of the script",
      "the brands, places and dates (no logo of the reference's subjects)",
      "the voice: the page's own voice kit",
    ],
    notTransferable: ["the reference's footage and renders", "its voice-over and music", "its script lines", "the brands it names"],
  },
  shots: [
    {
      id: "aerial_count",
      visualType: "cinematic",
      want:
        "Photoreal top-down satellite view of the subject at midday, slow push-in, objects outlined in thin teal, soft haze, no text.",
    },
    {
      id: "orbit_pull_up",
      visualType: "cinematic",
      want: "One continuous camera move from a close aerial up to orbit over the region, clouds passing, night lights where fitting.",
    },
    {
      id: "object_orbit",
      visualType: "cinematic",
      want: "Low 3D orbit around one physical object that carries the hidden number, soft shadows, muted natural colours.",
    },
    {
      id: "data_room",
      visualType: "coded_graphics",
      want: "Dark navy 3D room with ceiling light strips; floating panels with a bar chart and a two-line chart; one large figure.",
    },
    {
      id: "prop_closeup",
      visualType: "cinematic",
      want: "One glossy 3D prop on a dark set (a phone, a balance, a stack of notes), rim-lit, slow turn.",
    },
  ],
  gaps: [
    {
      what: "The gold italic serif accent in the hook title",
      why: "The style kit has three font roles (display, body, captions) and no accent font.",
      needs: "A contract change (Q1): an accent font role.",
    },
    {
      what: "The up-green, down-red, pill grey and follow-button blue",
      why: "The palette has five roles. The reference uses more; their values were seen but not all sampled.",
      needs: "A contract change (Q1) for more palette roles, or keep five.",
    },
    {
      what: "The filled yellow box behind the spoken word, and the dimmed words still to come",
      why: "captions.karaoke changes the word's colour only, and captions.boxed is in the contract but has no component.",
      needs: "A caption component (no contract change if it is captions.boxed).",
    },
    {
      what: "The counter with a pill label, the place and date pill, the data panels with bar and line charts",
      why: "The compose library has no counter, label pill or chart component.",
      needs: "New coded_graphics components in src/engine/compose/components.",
    },
    {
      what: "The 3D aerial flights and props",
      why: "They are generated shots (video.cinematic), which are paid provider calls.",
      needs: "The owner's spend approval for a first live run.",
    },
    {
      what: "The full Video DNA (transcript, segments, genome, captions, shake, music)",
      why: "The paid steps of analyze_reference did not run.",
      needs: "One live analysis of this reference; the DNA is then cached for the format and reused by every later run.",
    },
  ],
};
