// The 3D data explainer as the first built-in cookbook (round 3, K4). The style, the grammar structure, the cut rule and the checks come from
// the style preset (src/engine/presets/three-d-data-explainer.ts), read here rather than copied, so there is one source. What this file adds
// is what the preset could not hold: the ingredients and how each can be met, the steps, the instructions for each role, and the controls
// that the person sets.
//
// The default choices are the free ones: no voice-over, no music, coded scenes. A cookbook with those choices can run in agent mode, with no
// provider call (the Claude plan). Turning on a voice-over (text-to-speech is priced per character, so it is unknown until a count exists)
// or generated scenes (a paid shot) turns agent mode off, and the badge and the estimate say so.

import { threeDDataExplainer } from "../../../../engine/presets/three-d-data-explainer.ts";
import type { StylePreset } from "../../../../engine/presets/style-presets.ts";
import type { Cookbook } from "../schema.ts";

export const THREE_D_DATA_EXPLAINER_ID = "ck_3d_data_explainer";

/** The cookbook, built from a style preset. Pass another preset of the same shape to build a cookbook from it. */
export function buildThreeDDataExplainerCookbook(preset: StylePreset = threeDDataExplainer): Cookbook {
  const measured = preset.grammar.measured as {
    cutsMs: number[];
    shotLengthMs: { p50: number };
    zoomJumps: unknown[];
    patternInterruptMedianMs: number;
    integratedLufs: number;
  };
  const read = preset.grammar.read as { cutRule?: string };
  const cutRule = read.cutRule ?? undefined;

  return {
    schema: "meridian.cookbook/v1",
    cookbookId: THREE_D_DATA_EXPLAINER_ID,
    version: preset.version,
    label: "3D data explainer",
    summary:
      "Slow 3D camera flights over real-looking places, numbers anchored in the scene, a data room for the proof, and captions one word at a time. Free to make in agent mode.",
    family: "explainer",
    scope: "builtin",
    modes: ["agent", "engine"],
    ingredients: [
      {
        id: "voice",
        kind: "voice",
        label: "Voice-over",
        need: "optional",
        ways: [
          { id: "none", label: "No voice-over", coded: true },
          { id: "tts", label: "AI voice", modelClass: "tts" },
          { id: "upload", label: "My recording", upload: true },
        ],
      },
      {
        id: "music",
        kind: "music",
        label: "Music",
        need: "optional",
        ways: [
          { id: "none", label: "No music", coded: true },
          { id: "upload", label: "My track", upload: true },
        ],
      },
      {
        id: "scenes",
        kind: "generated_video",
        label: "Scenes",
        need: "required",
        ways: [
          { id: "coded", label: "Coded 3D scenes", coded: true },
          { id: "generated", label: "Generated aerial shots", visualType: "cinematic" },
        ],
      },
    ],
    steps: [
      { id: "script", kind: "script", label: "Write the script", after: [], uses: { role: "script" }, params: { beats: 8 } },
      {
        id: "scenes",
        kind: "visual",
        label: "Draw the scenes",
        after: ["script"],
        uses: { visualType: "cinematic" },
        params: { pace: 1, length_ms: 60000 },
      },
      {
        id: "data_room",
        kind: "visual",
        label: "Draw the data room",
        after: ["script"],
        when: { control: "data_panels", equals: true },
        uses: { visualType: "coded_graphics" },
        params: {},
      },
      {
        id: "hook_counter",
        kind: "visual",
        label: "Hook counter",
        after: ["script"],
        when: { control: "hook_counter", equals: true },
        uses: {},
        params: {},
      },
      {
        id: "captions",
        kind: "compose",
        label: "Captions",
        after: ["script"],
        uses: { component: "captions.karaoke" },
        params: { highlight: "box" },
      },
      {
        id: "voice_over",
        kind: "voice",
        label: "Voice-over",
        after: ["script"],
        when: { control: "voice_way", in: ["tts", "upload"] },
        uses: { role: "voice" },
        params: {},
      },
      {
        id: "music_mix",
        kind: "edit",
        label: "Music bed",
        after: ["script"],
        when: { control: "music_way", equals: "upload" },
        uses: {},
        params: {},
      },
      {
        id: "edit",
        kind: "edit",
        label: "Cut to the rhythm",
        after: ["scenes", "captions"],
        uses: { role: "edit" },
        params: {},
      },
      {
        id: "render",
        kind: "render",
        label: "Render 9:16",
        after: ["edit"],
        uses: {},
        params: {},
      },
    ],
    instructions: [
      {
        role: "script",
        text: "Open on a surprising claim, with a number that counts up in the scene within the first two seconds.",
      },
      {
        role: "script",
        text: "Make three cases. Each has a place, a number and a price move, and the proof lands before the end.",
      },
      {
        role: "script",
        text: "Write for speech when a voice-over is on: short sentences, one number to a sentence.",
        when: { control: "voice_way", in: ["tts", "upload"] },
      },
      {
        role: "plan",
        text: "Use aerial, data-room and prop shots only. Cut only when the place, the scale or the set changes; a move within one scene is a camera move, not a cut.",
      },
      {
        role: "critic",
        text: "Check the cut rhythm, the motion and the loudness against the checks below. A miss is reported as a miss, never adjusted to pass.",
      },
    ],
    style: {
      styleKitId: preset.styleKit.styleKitId,
      look: { preset: preset.look.preset, strength: preset.look.strength },
    },
    grammar: {
      structure: preset.structure.map((beat) => ({ role: beat.role, fromMs: beat.fromMs, toMs: beat.toMs })),
      ...(cutRule === undefined ? {} : { cutRule }),
    },
    controls: [
      {
        id: "voice_way",
        kind: "select",
        label: "Voice-over",
        help: "No voice-over keeps the video free in agent mode. AI voice is priced per character, so its cost stays unknown until a count exists.",
        options: [
          { value: "none", label: "None" },
          { value: "tts", label: "AI voice" },
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
          { value: "none", label: "None" },
          { value: "upload", label: "My track" },
        ],
        default: "none",
        binds: [{ choose: { ingredient: "music" } }],
      },
      {
        id: "scenes_way",
        kind: "select",
        label: "Scenes",
        help: "Coded 3D scenes are free. Generated aerial shots are paid per shot.",
        options: [
          { value: "coded", label: "Coded 3D scenes" },
          { value: "generated", label: "Generated aerial shots" },
        ],
        default: "coded",
        binds: [{ choose: { ingredient: "scenes" } }],
      },
      {
        id: "length",
        kind: "select",
        label: "Length",
        options: [
          { value: "30", label: "30 seconds" },
          { value: "45", label: "45 seconds" },
          { value: "60", label: "60 seconds" },
        ],
        default: "60",
        binds: [{ set: "step.scenes.length_ms", map: { table: { "30": 30000, "45": 45000, "60": 60000 } } }],
      },
      {
        id: "pace",
        kind: "slider",
        label: "Pace",
        help: "How quickly the scenes move. 1 is the reference.",
        min: 0.5,
        max: 1.5,
        step: 0.1,
        default: 1,
        binds: [{ set: "step.scenes.pace" }],
      },
      {
        id: "beats",
        kind: "slider",
        label: "Beats in the script",
        min: 5,
        max: 10,
        step: 1,
        default: 8,
        binds: [{ set: "step.script.beats" }],
      },
      {
        id: "look_strength",
        kind: "slider",
        label: "Look strength",
        min: 0,
        max: 1,
        step: 0.05,
        default: preset.look.strength,
        binds: [{ set: "style.look.strength" }],
      },
      {
        id: "data_panels",
        kind: "toggle",
        label: "Data room panels",
        help: "The dark data room with charts, for the proof.",
        default: true,
        binds: [{ enable: "data_room" }],
      },
      {
        id: "hook_counter",
        kind: "toggle",
        label: "Hook counter",
        help: "A number that counts up in the first scene.",
        default: true,
        binds: [{ enable: "hook_counter" }],
      },
      {
        id: "caption_highlight",
        kind: "select",
        label: "Caption highlight",
        options: [
          { value: "box", label: "Filled box" },
          { value: "colour", label: "Colour only" },
        ],
        default: "box",
        binds: [{ set: "step.captions.highlight" }],
      },
    ],
    checks: [
      { measure: "hardCuts", target: measured.cutsMs.length, tolerance: 1 },
      { measure: "firstCutMs", target: measured.cutsMs[0] ?? 0, tolerance: 300 },
      { measure: "shotP50Ms", target: measured.shotLengthMs.p50, tolerance: 800 },
      { measure: "zoomJumps", target: measured.zoomJumps.length, tolerance: 2 },
      { measure: "interruptMedianMs", target: measured.patternInterruptMedianMs, tolerance: 400 },
      { measure: "integratedLufs", target: measured.integratedLufs, tolerance: 1 },
    ],
  };
}

export const threeDDataExplainerCookbook: Cookbook = buildThreeDDataExplainerCookbook();
