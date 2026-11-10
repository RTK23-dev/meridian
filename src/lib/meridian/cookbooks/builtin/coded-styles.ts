// Five built-in cookbooks for code-drawn styles (owner request 2026-11-09: the best five of the Applied AI "Claude animation styles" list,
// mapped to Meridian). Each makes a vertical 1080 x 1920 short in agent mode: the script and a scene spec are written, the style is drawn in
// code on this machine and the sound is synthesised, so no paid provider is called. A chat on the connector can follow the same cookbook
// and write the video as a HyperFrames composition.
//
// - Isometric explainer: a labelled route of stages with a packet travelling it (tech and process explainers).
// - Paper-cut story: layered paper scenes with a slow parallax push-in (story intros, brand moods, hooks).
// - Line-art diagram: a diagram that builds step by step in thin lines with one warm accent (science and how-it-works).
// - Stacked data chart: stacks of coins, cash or blocks that build a bar chart, one token per unit (data and finance reveals).
// - 8-bit explainer: the pixel crew's directed science short (presets/pixel-explainer.ts, the pixel-explainer skill).
//
// The four new looks were designed from a written description of each style, not copied from anyone's footage: every shape, colour, move
// and sound is drawn or synthesised by Meridian (CLAUDE.md rule 6). Their checks are Meridian's own targets (the length chosen, -14 LUFS,
// a frame loop), not a reference's measures. The 8-bit explainer's checks are its study's measured values.

import { CODED_STYLE_KITS } from "../../../../engine/compose/styles/kits.ts";
import { pixelExplainer } from "../../../../engine/presets/pixel-explainer.ts";
import type { Check, Cookbook, Instruction } from "../schema.ts";

type Def = {
  id: string;
  label: string;
  summary: string;
  family: Cookbook["family"];
  styleKitId: string;
  look: { preset: "warm" | "cool" | "faded" | "mono"; strength: number };
  beatsLabel: string;
  beats: { min: number; max: number; default: number };
  lengths: number[];
  defaultLength: number;
  structure: Cookbook["grammar"]["structure"];
  cutRule: string;
  extraControls?: Cookbook["controls"];
  extraParams?: Record<string, string | number | boolean>;
  instructions: Instruction[];
  renderer: string;
  checks: Check[];
};

const LOUDNESS: Check = { measure: "integratedLufs", target: -14, tolerance: 1 };
const LOOP: Check = { measure: "loopDistance", target: 0, tolerance: 0.04 };

function codedCookbook(def: Def): Cookbook {
  const lengthTable = Object.fromEntries(def.lengths.map((seconds) => [String(seconds), seconds * 1000]));
  return {
    schema: "meridian.cookbook/v1",
    cookbookId: def.id,
    version: 1,
    label: def.label,
    summary: def.summary,
    family: def.family,
    scope: "builtin",
    modes: ["agent"],
    ingredients: [
      {
        id: "scenes",
        kind: "generated_video",
        label: "Scenes",
        need: "required",
        ways: [{ id: "coded", label: "Drawn in code", coded: true }],
      },
      {
        id: "voice",
        kind: "voice",
        label: "Voice-over",
        need: "optional",
        ways: [
          { id: "none", label: "No voice-over", coded: true },
          { id: "upload", label: "My recording", upload: true },
        ],
      },
      {
        id: "music",
        kind: "music",
        label: "Music",
        need: "optional",
        ways: [
          { id: "synth", label: "The style's own bed", coded: true },
          { id: "upload", label: "My track", upload: true },
        ],
      },
    ],
    steps: [
      { id: "script", kind: "script", label: "Write the lines", after: [], uses: { role: "script" }, params: { beats: def.beats.default } },
      { id: "scene", kind: "compose", label: "Fill the scene spec and draw it", after: ["script"], uses: { visualType: "coded_graphics" }, params: { length_ms: def.defaultLength * 1000, ...(def.extraParams ?? {}) } },
      { id: "voice_over", kind: "voice", label: "Lay the voice-over", after: ["script"], when: { control: "voice_way", equals: "upload" }, uses: { role: "voice" }, params: {} },
      { id: "music_mix", kind: "edit", label: "Your music bed", after: ["scene"], when: { control: "music_way", equals: "upload" }, uses: {}, params: {} },
      { id: "render", kind: "render", label: "Render 9:16", after: ["scene"], uses: {}, params: {} },
    ],
    instructions: [
      ...def.instructions,
      { role: "agent", text: `Draw it with ${def.renderer}. It checks the spec before drawing, renders locally with no provider call, and reports the length, the loudness and the loop distance.` },
      { role: "agent", text: "Chat on the connector: write the same scene as a HyperFrames composition (meridian_video_guide) in this style's colours and moves, and render it in your sandbox." },
      { role: "critic", text: "Report each check as pass, near, miss or unknown. A miss is reported as a miss, never adjusted to pass." },
    ],
    style: { styleKitId: def.styleKitId, look: def.look },
    grammar: { structure: def.structure, cutRule: def.cutRule },
    controls: [
      {
        id: "length",
        kind: "select",
        label: "Length",
        options: def.lengths.map((seconds) => ({ value: String(seconds), label: `${seconds} seconds` })),
        default: String(def.defaultLength),
        binds: [{ set: "step.scene.length_ms", map: { table: lengthTable } }],
      },
      {
        id: "scenes_way",
        kind: "select",
        label: "Scenes",
        help: "Drawn in code on this machine, so they cost nothing.",
        options: [{ value: "coded", label: "Drawn in code" }],
        default: "coded",
        binds: [{ choose: { ingredient: "scenes" } }],
      },
      { id: "beats", kind: "slider", label: def.beatsLabel, min: def.beats.min, max: def.beats.max, step: 1, default: def.beats.default, binds: [{ set: "step.script.beats" }] },
      ...(def.extraControls ?? []),
      {
        id: "voice_way",
        kind: "select",
        label: "Voice-over",
        help: "The style tells the story in text, so no voice-over keeps it free. Your own recording is free too. An AI voice can be added from the chat connector (meridian_voiceover).",
        options: [
          { value: "none", label: "None" },
          { value: "upload", label: "My recording" },
        ],
        default: "none",
        binds: [{ choose: { ingredient: "voice" } }],
      },
      {
        id: "music_way",
        kind: "select",
        label: "Music",
        options: [
          { value: "synth", label: "The style's own bed" },
          { value: "upload", label: "My track" },
        ],
        default: "synth",
        binds: [{ choose: { ingredient: "music" } }],
      },
      { id: "look_strength", kind: "slider", label: "Look strength", min: 0, max: 1, step: 0.05, default: def.look.strength, binds: [{ set: "style.look.strength" }] },
    ],
    checks: def.checks,
  };
}

const RENDER = "node --experimental-strip-types scripts/engine/applied-styles/render.ts --spec <spec.json> --out <dir>";

export const isometricExplainerCookbook = codedCookbook({
  id: "ck_isometric_explainer",
  label: "Isometric explainer",
  summary: "A labelled route of 2 to 6 stages on a cream isometric ground, with a glowing packet travelling it. For tech and process explainers. Free in agent mode.",
  family: "explainer",
  styleKitId: CODED_STYLE_KITS.isometric.styleKitId,
  look: { preset: "warm", strength: 0.1 },
  beatsLabel: "Stages on the route",
  beats: { min: 2, max: 6, default: 5 },
  lengths: [15, 20, 30],
  defaultLength: 20,
  structure: [
    { role: "hook", fromMs: 0, toMs: 1600 },
    { role: "item", fromMs: 1600, toMs: 18200 },
    { role: "payoff", fromMs: 18200, toMs: 20000 },
  ],
  cutRule: "No cuts: one locked isometric board. Each stage rises as the packet sets off for it; its label pops on when the packet arrives.",
  instructions: [
    { role: "script", text: "Write a title of at most 48 characters that names the journey, then one stage per step of the route: a label of at most 22 characters and one caption line of at most 90 characters that says what happens there." },
    { role: "script", text: "The last caption lands the payoff (how fast, how far, how many). Make only claims the brief gives." },
    { role: "plan", text: "Fill the isometric spec: title, stages (label, icon, caption) and an optional packet word. Icons: phone, laptop, tower, cable, server, cloud, house, factory, store, truck, warehouse, bank, sun, panel, battery, satellite." },
    { role: "visual", text: "Cream ground with a faint tile grid, models built from shaded boxes in a restrained blue family, warm yellow for the packet and lit windows, one red accent. No outlines on faces, soft drop shadows." },
  ],
  renderer: RENDER,
  checks: [{ measure: "durationMs", target: 20000, tolerance: 200 }, LOUDNESS, LOOP],
});

export const paperCutStoryCookbook = codedCookbook({
  id: "ck_paper_cut_story",
  label: "Paper-cut story",
  summary: "A story in layered cut paper: the scene builds back to front, a slow parallax push-in, serif lines on a paper strip, and the light finds the hero. For story intros, brand moods and hooks. Free in agent mode.",
  family: "story",
  styleKitId: CODED_STYLE_KITS.paper_cut.styleKitId,
  look: { preset: "faded", strength: 0.15 },
  beatsLabel: "Story lines",
  beats: { min: 2, max: 6, default: 4 },
  lengths: [12, 16, 20],
  defaultLength: 16,
  structure: [
    { role: "hook", fromMs: 0, toMs: 2200 },
    { role: "setup", fromMs: 2200, toMs: 7300 },
    { role: "twist", fromMs: 7300, toMs: 11100 },
    { role: "payoff", fromMs: 11100, toMs: 16000 },
  ],
  cutRule: "No cuts: one scene, layers lit back to front, a slow push-in that returns to its start so the video loops.",
  extraControls: [
    {
      id: "scene",
      kind: "select",
      label: "Scene",
      options: [
        { value: "lighthouse", label: "Lighthouse at sea" },
        { value: "mountains", label: "Mountains and a cabin" },
        { value: "city", label: "City skyline" },
        { value: "forest", label: "Forest camp" },
      ],
      default: "lighthouse",
      binds: [{ set: "step.scene.scene" }],
    },
    {
      id: "time",
      kind: "select",
      label: "Time of day",
      options: [
        { value: "night", label: "Night" },
        { value: "dusk", label: "Dusk" },
        { value: "day", label: "Day" },
      ],
      default: "night",
      binds: [{ set: "step.scene.time" }],
    },
  ],
  extraParams: { scene: "lighthouse", time: "night" },
  instructions: [
    { role: "script", text: "Write a short story in 2 to 6 lines of at most 90 characters, one per beat: who, what they face, the turn, and the payoff on the last line, when the light finds the hero." },
    { role: "script", text: "Plain, warm words. The title (at most 48 characters) reads like a book title." },
    { role: "plan", text: "Fill the paper-cut spec: title, scene, time of day and the beats' captions." },
    { role: "visual", text: "Matte paper layers each casting a soft shade on the layer behind, edges cut by hand (a small wobble), fine paper fibre. One warm accent for the hero. Serif type." },
  ],
  renderer: RENDER,
  checks: [{ measure: "durationMs", target: 16000, tolerance: 200 }, LOUDNESS, LOOP],
});

export const lineDiagramCookbook = codedCookbook({
  id: "ck_line_diagram",
  label: "Line-art diagram",
  summary: "A diagram that draws itself step by step in thin white lines on deep navy, with numbered nodes, running arrows and one warm accent for the takeaway. For science and how-it-works. Free in agent mode.",
  family: "explainer",
  styleKitId: CODED_STYLE_KITS.line_diagram.styleKitId,
  look: { preset: "cool", strength: 0.1 },
  beatsLabel: "Steps in the diagram",
  beats: { min: 3, max: 6, default: 4 },
  lengths: [15, 18, 24],
  defaultLength: 18,
  structure: [
    { role: "hook", fromMs: 0, toMs: 1400 },
    { role: "item", fromMs: 1400, toMs: 13300 },
    { role: "payoff", fromMs: 13300, toMs: 18000 },
  ],
  cutRule: "No cuts: one diagram that grows. A node draws as a stroke, its label types on, then the arrow to the next step draws.",
  extraControls: [
    {
      id: "layout",
      kind: "select",
      label: "Shape",
      help: "A cycle closes its loop in the accent; a flow runs top to bottom.",
      options: [
        { value: "cycle", label: "Cycle" },
        { value: "flow", label: "Flow" },
      ],
      default: "cycle",
      binds: [{ set: "step.scene.layout" }],
    },
  ],
  extraParams: { layout: "cycle" },
  instructions: [
    { role: "script", text: "Write 3 to 6 steps: a label of at most 22 characters and one caption of at most 90 characters each, in the order they happen. Then one takeaway line of at most 60 characters." },
    { role: "script", text: "Use the subject's real terms once each, explained in plain words in the caption. Make only claims the brief or a named source gives." },
    { role: "plan", text: "Fill the line-diagram spec: title, layout (cycle when the process repeats, flow when it ends), steps and takeaway." },
    { role: "visual", text: "Deep navy with a faint dot grid, 4 px white lines, numbers in a monospace face, the accent only on the active step, the closing arrow and the takeaway." },
  ],
  renderer: RENDER,
  checks: [{ measure: "durationMs", target: 18000, tolerance: 200 }, LOUDNESS, LOOP],
});

export const stackedDataChartCookbook = codedCookbook({
  id: "ck_stacked_data_chart",
  label: "Stacked data chart",
  summary: "A bar chart built from stacks of coins, cash or blocks that drop and settle, one token per unit, with each figure popping on. For data and finance reveals. Free in agent mode.",
  family: "other",
  styleKitId: CODED_STYLE_KITS.stacked_chart.styleKitId,
  look: { preset: "warm", strength: 0.1 },
  beatsLabel: "Bars",
  beats: { min: 2, max: 6, default: 5 },
  lengths: [12, 16, 20],
  defaultLength: 16,
  structure: [
    { role: "hook", fromMs: 0, toMs: 1600 },
    { role: "proof", fromMs: 1600, toMs: 12200 },
    { role: "payoff", fromMs: 12200, toMs: 16000 },
  ],
  cutRule: "No cuts: one lit stage. The stacks build left to right; each figure pops on when its stack lands.",
  extraControls: [
    {
      id: "token",
      kind: "select",
      label: "Tokens",
      options: [
        { value: "coins", label: "Gold coins" },
        { value: "cash", label: "Cash bundles" },
        { value: "blocks", label: "Blocks" },
      ],
      default: "coins",
      binds: [{ set: "step.scene.token" }],
    },
  ],
  extraParams: { token: "coins" },
  instructions: [
    { role: "script", text: "Write a title of at most 48 characters, 2 to 6 bars (a label of at most 12 characters and the figure exactly as the brief states it), and one takeaway of at most 60 characters." },
    { role: "script", text: "Use only figures the brief gives, with their source. With no source, the chart is marked ILLUSTRATIVE DATA and says so on screen; never present made-up numbers as real." },
    { role: "plan", text: "Fill the stacked-chart spec: unit (what one token is), perToken (the value one token stands for), token, bars (label, value, display), source or illustrative, takeaway. Each bar must come to 1 to 48 tokens: the key is honest only when every stack is counted." },
    { role: "visual", text: "A navy stage under a soft spotlight, tokens that drop and settle with a small bounce, gold figures, the source small at the foot." },
  ],
  renderer: RENDER,
  checks: [{ measure: "durationMs", target: 16000, tolerance: 200 }, LOUDNESS, LOOP],
});

/** The 8-bit explainer as a cookbook: the pixel crew's directed science short, with its study's measured checks. */
const pixelMeasured = pixelExplainer.grammar.measured as {
  durationMs: { median: number };
  loopDistance: { median: number; max: number };
  integratedLufs: { median: number };
  meanMotion: { median: number };
};

export const pixelExplainerCookbook: Cookbook = {
  ...codedCookbook({
    id: "ck_pixel_explainer",
    label: "8-bit explainer",
    summary: "A 30 to 36 second science short in pixel art: a hook card at frame 0, the answer by 3 s, a dive into a smaller world, objects with faces, a number that moves, and a loop. Free in agent mode.",
    family: "explainer",
    styleKitId: pixelExplainer.styleKit.styleKitId,
    look: { preset: pixelExplainer.look.preset, strength: pixelExplainer.look.strength },
    beatsLabel: "Mechanism cards",
    beats: { min: 4, max: 6, default: 5 },
    lengths: [32],
    defaultLength: 32,
    structure: pixelExplainer.structure.map((beat) => ({ role: beat.role, fromMs: beat.fromMs, toMs: beat.toMs })),
    cutRule: "Few hard cuts: the picture changes by camera moves and a dive into a smaller world and back.",
    instructions: [
      { role: "script", text: "Follow the pixel-explainer skill: one idea; a hook card at frame 0 (a belief, a dare or an extreme number); the answer or flip as a visible event by 3 s; 4 to 6 mechanism cards of at most two lines, about 2 words a second; a number that moves with a source or an approximation mark; a payoff line with the keyword; a share, comment or safety ask." },
      { role: "plan", text: "Write the directed film (direction/film.ts): every shot has its one moment, its arc, its eye target and empty band, its loop and its avoid list. The checks refuse a film that is described rather than directed." },
      { role: "visual", text: "The pixel crew draws everything: a navy ground with warm subjects, 4x4 dither shading, faces on objects, the 5x7 pixel font with the payoff word in yellow, soft glows and a fine grain." },
    ],
    renderer: "node --experimental-strip-types scripts/engine/pixel-explainer/render.ts --film <film.json> --build <build.json> --out <dir>",
    checks: [
      { measure: "durationMs", target: 32000, tolerance: 500 },
      { measure: "integratedLufs", target: pixelMeasured.integratedLufs.median, tolerance: 1 },
      { measure: "loopDistance", target: pixelMeasured.loopDistance.median, tolerance: 0.04 - pixelMeasured.loopDistance.median },
      { measure: "meanMotion", target: pixelMeasured.meanMotion.median, tolerance: 0.012 },
    ],
  }),
};

export const CODED_STYLE_COOKBOOKS: readonly Cookbook[] = [
  isometricExplainerCookbook,
  paperCutStoryCookbook,
  lineDiagramCookbook,
  stackedDataChartCookbook,
  pixelExplainerCookbook,
];
