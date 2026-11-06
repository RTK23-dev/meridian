// Style preset: the 8-bit science explainer. Built on 2026-11-06 from a study of 14 reels of one account (6 pinned, 8 others; 12 science
// shorts and 2 ads), a partial sample, not an archive. The study's full record, per video and summarised, is in
// docs/engine/STYLE_PRESET_PIXEL_EXPLAINER.md. What was measured ran on the compressed copies (480x854, 30 fps) with ffmpeg and numpy,
// and speech with faster-whisper; what was read was read from frames by the coding agent, not by the engine's frame_reader role.
//
// Every value says where it came from (`source`, or the comment beside it):
// - "measured": a number from ffmpeg or the analysis code, on the sample's files (12 science shorts unless it says otherwise).
// - "read": read from the frames. An observation, not a measurement.
// - "chosen": a choice the preset makes to fit Meridian's contracts or its pixel crew. The owner can change it.
// Genes, never content (CLAUDE.md rule 6): no frame, character, line, music or sound of the sample is stored or drawn. The palettes are
// colour values of the craft; the worlds, characters, font and music of the pixel crew are Meridian's own.

import type { StyleKit } from "../contracts/index.ts";
import type { StylePackage } from "./style-packages.ts";

/** The sample: each reel's code, set, SHA-256 of the compressed copy that was read, and duration. */
export const PIXEL_EXPLAINER_SAMPLE = {
  account: "science_in_8bit",
  analysedOn: "2026-11-06",
  note: "14 of the account's 198 posts: 6 browser-identified pinned reels and 8 other accessible reels. Not a verified chronological sample. The hashes are of the compressed copies that were read; the originals were not read.",
  videos: [
    { code: "DfXd1QugiSd", set: "other", kind: "science", durationMs: 32110, sha256: "8c681556b7d997a58b1233d654f410501089744f98641cebfed64067927e361f" },
    { code: "DfXJJIGkhtD", set: "other", kind: "science", durationMs: 32110, sha256: "6bd9f3596b76acf3685255a065e77336bbbf687152bad4a2be327d38b2a74735" },
    { code: "DfW0jw1DNts", set: "other", kind: "science", durationMs: 32110, sha256: "1ea41075523c7eaf12c194583d390f6eb60fae81d1a57cf74444bd9968e93b51" },
    { code: "DfWgAn2DvOO", set: "other", kind: "science", durationMs: 36120, sha256: "a58fceacb7154cd0817b94e83f448c3c52e60943249057df286af3fbf9f408d9" },
    { code: "DfWLbwvlDws", set: "other", kind: "science", durationMs: 32110, sha256: "a8be02912a52f6e1b80059d9bb7c477aa15a4637ec45d4a9ec919ddb07aaa5c1" },
    { code: "DfUObncjJfa", set: "other", kind: "science", durationMs: 31120, sha256: "eed34223e443b94a31d1fea1592b16c3ffc26153c8fb78d85ca846b7b0bc412c" },
    { code: "DfWlPu3FTcE", set: "other", kind: "ad", durationMs: 39420, sha256: "20483c6de8d356b60427fd131665fa2dcacef6dd4ee1c80c29863003e3d8aa5a" },
    { code: "DfWy3_RiY5i", set: "other", kind: "ad", durationMs: 32700, sha256: "b164d3b057ac099854b7ee06e01633ae6f6b0e074e229274cf7986f8667a90b0" },
    { code: "DeyG894q-ga", set: "pinned", kind: "science", durationMs: 52140, sha256: "f7a6581f1363761963e31b7e3a5cdd3a2bf39c75589b0b0c112c9f56b1cf033e" },
    { code: "DfEeekmgjHs", set: "pinned", kind: "science", durationMs: 34110, sha256: "bdf3fa0d2e9c8112b62bdc0b84641c94103dd942a6ac0a3cd8e0cd489e9034d6" },
    { code: "DfBk_EenL20", set: "pinned", kind: "science", durationMs: 32130, sha256: "6d48aa80bb5794573e9293f57e5a73ec14b6dd41633651b83bbb0615564afe07" },
    { code: "DfEy_XqFMj5", set: "pinned", kind: "science", durationMs: 36120, sha256: "d3001c33b395fcfd0e5dffdba1e60ce3d513ba4fae49dd67fc1a27f436266b5f" },
    { code: "DfIqOKUCneZ", set: "pinned", kind: "science", durationMs: 32110, sha256: "effb658faf94e4fb78ec7e8aa94da3e83e4e2d9a2913a4bb556ec31d549e5980" },
    { code: "DfGuj5uo7EO", set: "pinned", kind: "science", durationMs: 32130, sha256: "4c8287f6149bc72b9fcbee2a835a4d71b62c90c07ff835038a9c9578c5176a6c" },
  ],
} as const;

export const pixelExplainerKit: StyleKit = {
  styleKitId: "sk_pixel_explainer",
  version: 1,
  pageId: "preset_pixel_explainer",
  palette: {
    primary: "#F08A3C", // chosen: a warm subject colour; the sample's subjects are warm (orange, pink, peach, gold) on a cool ground (read)
    secondary: "#4FD6E8", // chosen: the cool concept colour (the sample pairs opposing concepts in red and cyan, read)
    accent: "#F4CE44", // measured: the payoff-word yellow, median of the 12 science shorts (range #EFD73E to #FCBE50)
    text: "#F4F1E8", // read: near-white card text with a dark outline
    background: "#12163C", // measured: navy is the largest colour in 7 of 12 (#10183F to #272A6B)
  },
  fonts: {
    display: "Inter", // chosen: the pixel crew draws its own 5x7 font in code; the kit's font roles cannot name a drawn font (see gaps)
    body: "Inter", // chosen
    captions: "Inter", // chosen
  },
  captionStyle: {
    component: "captions.minimal", // chosen: the words are cards drawn by the pixel crew, not speech captions
    highlight: "#F4CE44", // measured: the payoff-word yellow
    weight: 700, // read: a bold pixel font
    case: "upper", // read: every card is upper case in 12 of 12
  },
  motionIntensity: 2, // read and measured: quick character moves (pops, snaps, squashes) on a mostly locked frame; mean motion 0.0123
  preferredTypes: ["coded_graphics", "kinetic_type", "cartoon_rigged"], // chosen: the pixel crew draws everything in code
  bannedTypes: ["ugc_presenter", "stock_footage", "react_clip", "cinematic", "stop_motion"], // read: none appear; photoreal breaks the look
  musicGenres: ["chiptune"], // chosen: the pixel crew's own synthesised bed; the sample's music was not identified (unknown)
  outroMs: 1500, // read: the last 1 to 2 s return to frame 0 (the loop), in 9 of 12
  stickers: [],
};

export const pixelExplainer: StylePackage = {
  packageId: "pixel_explainer",
  version: 1,
  label: "8-bit science explainer",
  summary:
    "A 30 to 36 second science short told in two-line pixel cards over music, no voice: a hook that names a belief, a dare or an " +
    "extreme number at frame 0; the answer by 3 s as a visible event; a dive into a smaller world where each card has one literal " +
    "picture; everyday objects with faces whose expressions follow the stakes; a number that moves; a source or safety line; a share " +
    "or comment ask; and a last second that returns to frame 0, so it loops.",
  reference: null,
  sample: {
    account: PIXEL_EXPLAINER_SAMPLE.account,
    videos: PIXEL_EXPLAINER_SAMPLE.videos.map((video) => ({ code: video.code, sha256: video.sha256, durationMs: video.durationMs })),
    analysedOn: PIXEL_EXPLAINER_SAMPLE.analysedOn,
    templateDurationMs: 32000,
    note: PIXEL_EXPLAINER_SAMPLE.note,
  },
  styleKit: pixelExplainerKit,
  look: { preset: "cool", strength: 0.15, source: "chosen" },
  grammar: {
    measured: {
      sampleSize: { videos: 14, scienceShorts: 12, ads: 2 },
      durationMs: { median: 32120, min: 31120, max: 52140 },
      voiceOver: { scienceShorts: 0, ads: 2 },
      sceneCutsAtScore0_3: { median: 2, min: 1, max: 8 },
      loopDistance: { median: 0.0115, min: 0.0062, max: 0.0217, under0_04: 12 },
      meanMotion: { median: 0.0123, min: 0.0062, max: 0.0308 },
      integratedLufs: { median: -14.25, min: -14.4, max: -14.1 },
      loudnessRangeLu: { median: 7.95, min: 6.1, max: 10 },
      truePeakDbfs: { min: -0.5, max: 1.7 },
      tempoBpmEstimate: { clusters: [117.5, 80.7], counts: [8, 4], note: "autocorrelation on the mixed track; approximate" },
      keywordYellow: { median: "#F4CE44", min: "#EFD73E", max: "#FCBE50" },
      darkGround: { meanLuminanceRange: [0.155, 0.339], videosBelow0_35: 11 },
      toneTest: "DfEy_XqFMj5 plays pure tones: 8,000 Hz at 0 to 4 s and 10,000 Hz at 6 to 7 s",
      countTicks: "DfBk_EenL20 has transients at 0.93, 1.93 and 2.93 s as 1, 2, 3 SEC count on screen",
      postingCadence: "the 5 dated consecutive posts are 3 hours apart (as indexed)",
    },
    read: {
      hookFlipMs: { median: 2000, min: 500, max: 3000, note: "the answer, flip or event of the hook, at 0.5 s steps" },
      textAtFrameZero: "12 of 12",
      cards: { perVideoMedian: 12, holdMsMedian: 2630, wordsPerSecondMedian: 1.98, wordsPerSecondRange: [1.31, 2.93], maxLines: 2 },
      cardLook: "upper case, a bold pixel font, near-white with a dark outline; the payoff words in yellow; the card cuts on, it is never faded",
      cardPlace: "the main band is the upper third (line centres at about 20 to 28% of the height); numbers, labels and sub-claims may sit in the lower third when the subject is high",
      equationCards: "11 of 12 have an 'X = Y' or 'X: Y' card",
      scaleCut: "8 of 12 dive into a smaller world and come back; 2 more change scale outward",
      shots: { perVideoMedian: 6, meanShotMsMedian: 5350 },
      characters: "objects and body parts with two round eyes (white, black pupil, a highlight), a line mouth and brows; expressions follow the stakes (strain as stakes rise, relief at the payoff)",
      conceptColours: "two opposing concepts keep two fixed colours (red and cyan, blue and grey, blue and red)",
      movingNumbers: "9 of 12 have a counter, timer, countdown or readout that changes on screen",
      participation: "4 of 6 pinned and 1 of 6 others have a dare, count-along, timer or test",
      honesty: "approximation marks, a small source line under a number, safety lines where the body is involved",
      jokeBeat: "a speech bubble or a '...NOTHING.' beat",
      watermark: "inside the world (a sign, an engraving, a tag), never an overlay",
      caption: "claim, sound-on cue, 2 to 3 short paragraphs, three sources, a 'send this to' line, follow, site and four hashtags",
      rendering: "clean shapes with ordered-dither shading, soft glows, fine grain and a pixel font; not native low-resolution pixel art (inferred from crops)",
    },
    unknown: [
      "the original resolution and frame rate (only compressed copies were read)",
      "the animation cadence: a grain overlay changes every frame, so held drawings could not be measured",
      "the music's source and genre",
      "performance: the indexed view counts are unadjusted for age and observation time, so no comparison is made",
    ],
  },
  structure: [
    { role: "hook", fromMs: 0, toMs: 3000, intent: "Name a belief, a dare or an extreme number at frame 0; land the answer or flip as a visible event by 3 s.", visual: "The everyday world with the subject (a face on it) and something already moving." },
    { role: "setup", fromMs: 3000, toMs: 6000, intent: "Re-hook: a one-word question, a 'but' twist, or a change of scale.", visual: "A push or a dive toward the subject." },
    { role: "item", fromMs: 6000, toMs: 22000, intent: "The mechanism in 4 to 6 cards, each with one literal picture; at least one 'X = Y' card; concept colours fixed.", visual: "A smaller world (inside the object) with a field of characters reacting unevenly." },
    { role: "proof", fromMs: 22000, toMs: 27000, intent: "A number that moves, with a small source line or an approximation mark.", visual: "A readout, counter or timer, or a side-by-side of two cases." },
    { role: "payoff", fromMs: 27000, toMs: 29500, intent: "One line with the keyword: the corrected belief, or the advice.", visual: "Back out of the small world; the subject's face resolves." },
    { role: "cta", fromMs: 29500, toMs: 32000, intent: "A person to send it to, a result to comment, or a safety rule; then the last second returns to frame 0.", visual: "The opening framing, the subject in its opening pose." },
  ],
  genes: {
    keep: ["hook_mechanism", "structure", "proof_device", "edit_grammar", "pacing", "caption_style", "emotional_arc", "conversion_move"],
    change: ["the topic, the facts and every card", "the worlds and the characters (Meridian's own, drawn by the pixel crew)", "the music and the sound effects (synthesised)"],
    notTransferable: ["the sample's frames, characters and art", "its card lines", "its music", "its handle and site"],
  },
  shots: [
    { id: "hook_world", visualType: "coded_graphics", want: "The everyday world at night, the subject with a face in the lower middle, an event already moving; the upper third empty for the card." },
    { id: "dive", visualType: "coded_graphics", want: "A continuous dive from the subject into its inside, landing on a hit (a splash, a pop) as the scale cut." },
    { id: "field", visualType: "coded_graphics", want: "A field of small characters (droplets, cells, bits) on a dark navy ground, reacting to one force with uneven delays." },
    { id: "readout", visualType: "kinetic_type", want: "A big yellow number that counts and slams on the moment, with ticks, over the field." },
    { id: "overhead", visualType: "coded_graphics", want: "The subject from above or in section, two concept colours side by side, one changing into the other on the moment." },
    { id: "return", visualType: "coded_graphics", want: "Back to the opening framing; the subject returns to its opening pose by the last frame." },
  ],
  gaps: [
    {
      what: "The shot direction (one moment, motion arc, eye target, empty band, loop, avoid list) between plan and produce",
      why: "It is the proposed ShotDirection contract (src/engine/direction/film.ts), not yet an engine contract.",
      needs: "The owner's or lead's approval, a contract version bump and a Bible section 4 note (docs/engine/proposals/SHOT_DIRECTION.md).",
    },
    {
      what: "Drawing the film inside the engine's render path",
      why: "The pixel crew (compose/pixel/pixel-engine.js) runs in agent mode through scripts/engine/pixel-explainer/render.ts; it is not a compose component yet.",
      needs: "A pixel.scene component that draws one stage per shot inside a HyperFrames composition, with goldens.",
    },
    {
      what: "The pixel font in the style kit",
      why: "The kit's font roles name CSS font families; the pixel crew draws its 5x7 font in code.",
      needs: "A font asset and a font role for it (contract Q1), or keep the font in the pixel crew only.",
    },
    {
      what: "Generated pictures in the locked look",
      why: "A generated keyframe comes back in the model's own palette and resolution.",
      needs: "A media function that snaps a generated still to the look: downscale to the logical frame, map to the palette with ordered dither, scale up by a whole number (L6).",
    },
    {
      what: "The sample's music",
      why: "It was not identified; tempo estimates only.",
      needs: "Nothing for the preset: the crew synthesises its own bed.",
    },
  ],
};

/**
 * The direction template the Director writes from, for any new idea in this style (the shot_director prompt reads it). Each rule cites
 * the study (study n of 12) or says it is the crew's choice.
 */
export const PIXEL_EXPLAINER_DIRECTION = {
  formats: [
    { id: "myth_flip", hook: "Name the belief as a question at frame 0; flip it with one word or a number and a visible event by 2 s.", study: "6 of 12" },
    { id: "participation", hook: "A dare, a count-along, a timer or a test the viewer starts at once, with a readout that stays on screen; a safety line where the body is involved.", study: "5 of 12" },
    { id: "extreme_number", hook: "One extreme number with a picture of it at frame 0 (the missing part, the long fall), then the twist by 5 s.", study: "1 of 12" },
  ],
  timing: {
    durationMs: { target: 32000, min: 30000, max: 36000 },
    beatMs: 500,
    answerByMs: 3000,
    rehookFromMs: 4000,
    rehookToMs: 7000,
    returnToFrameZeroLastMs: 1500,
    note: "Moments land on the 120 bpm grid (every 500 ms), so the hit and the music agree (chosen; the sample's ticks fall on a 1 s grid, measured).",
  },
  cards: {
    maxLines: 2,
    maxCharsPerLine: 20,
    case: "upper",
    keywordPerCard: "one group of payoff words, in the keyword colour",
    holdMs: "600 plus 300 a word, and at least the study's 2 s",
    wordsPerSecond: [1.3, 2.9],
    equationCard: "at least one 'X = Y' or 'X: Y' card",
    sourceLine: "a number on screen sits in a sourced claim; a small source or approximation line under it when the claim is narrow",
    reveal: "cut on; never faded; the keyword may flash white for one drawing",
  },
  shots: {
    count: [5, 8],
    worlds: "at most three: the everyday world, the small world inside it, and the return",
    subject: "one subject with a face; a field of copies reacts unevenly (the first leads)",
    emptyBand: "the upper third, unless the subject is high; the subject never crosses it at the moment",
    camera: ["locked", "push", "follow", "dive_in", "dive_out"],
    cadence: "twos for characters, ones for the camera",
    moment: "every shot has one moment that is an event: impact, pop, flip, transform, land, count, reveal",
    arc: "anticipation (a squash, a lean back, a worried face), release on the beat, settle past the mark (overshoot) and back",
  },
  faces: {
    eyes: "two round white eyes with a dark pupil and a one-pixel highlight; one eye for a side view",
    stakes: {
      belief: "smug or calm",
      flip: "surprised",
      problem: "worried",
      stakes: "strained",
      overload: "dizzy",
      payoff: "happy",
    },
  },
  worlds: [
    { id: "night_city", colours: ["#0D1133", "#151A45", "#1C2256", "#3F3367"], source: "measured palette of DfXd1QugiSd" },
    { id: "kitchen_night", colours: ["#090B22", "#1A1F4D", "#262B63", "#3C3A75", "#7A5A3A", "#B0844F"], source: "chosen; navy from the study" },
    { id: "micro_field", colours: ["#0A0C26", "#16194A", "#232A66", "#9FE3EC"], source: "chosen; navy from the study" },
    { id: "body_plum", colours: ["#1D0B2A", "#3B164F", "#5A2A6A", "#7A4A7A"], source: "measured: plum of DfGuj5uo7EO (#3B164F)" },
    { id: "sunset_land", colours: ["#12163C", "#471F47", "#B8563C", "#E9A65A", "#EEA676"], source: "measured palette of DfXJJIGkhtD" },
    { id: "fields_night", colours: ["#070A1D", "#13271C", "#22331F", "#453331"], source: "measured palette of DfBk_EenL20" },
  ],
  sound: {
    bedBpm: 120,
    kickDropsOn: "the hook's moment",
    perMoment: { impact: "zap", pop: "pop", flip: "click", transform: "whoosh", land: "thud", count: "boom", reveal: "chime", release: "whoosh", split: "pop", grow: "blip", shrink: "blip", travel: "whoosh" },
    perCard: "blip",
    ticks: "one per counted unit, at most one every 90 ms",
    master: { integratedLufs: -14, truePeakDbtp: -1, source: "measured: the 12 sit at -14.4 to -14.1 LUFS" },
  },
  crewRecipes: {
    impact: "squash the subject on the beat, shake the camera 2 px for 0.25 s, sparks from the contact point",
    pop: "pop the subject (scale +25 to 30% and back), a ring from its centre",
    flip: "rotate with 15% anticipation and 25% overshoot; copies react up to 0.26 s late, unevenly",
    transform: "change colour through the dither (not a cross-fade), pop, and a puff (steam, sparks)",
    count: "the readout counts on the reveal curve for 1.2 s and holds; ticks while it counts; a flash and a shake as it lands",
    land: "move with the heavy curve and a 6% overshoot, a thud",
    reveal: "enter with an 18% overshoot from scale 0, a ring",
    dive: "zoom on a log scale with the heavy curve into the subject; a burst and a white flash at the surface; the next shot opens zoomed out and lands",
  },
  avoid: [
    "photoreal textures or realistic default colours",
    "smooth gradients without dither",
    "faded text, an even stagger, a template blur-in",
    "a centred subject under centred text",
    "words over a face or over the subject at its moment",
    "glowing orbs or particles with no job",
    "more than two lines on a card, lower-case cards",
    "a watermark overlay",
    "a fade to black at the end (it breaks the loop)",
  ],
  checks: {
    answerByMs: 3000,
    loopMax: 0.04,
    lufs: { target: -14, tolerance: 0.6 },
  },
} as const;
