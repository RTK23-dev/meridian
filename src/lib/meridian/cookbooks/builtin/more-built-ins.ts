// Two more built-in cookbooks (round 3, K26 and K27). Each is data, validated and resolved by the same rules as any cookbook. Both need paid
// parts by default (a presenter, a voice), so their badges and modes say what the person must choose.

import type { Cookbook } from "../schema.ts";

/** K26: a product video with a presenter (an AI presenter, paid, or the person's own footage, free), product shots and a call to action. */
export const ugcProductCookbook: Cookbook = {
  schema: "meridian.cookbook/v1",
  cookbookId: "ck_ugc_product",
  version: 1,
  label: "UGC product",
  summary: "A short product video with a presenter: a problem, the product in use, and a call to action. Needs a presenter and the product kit.",
  family: "ugc",
  scope: "builtin",
  modes: ["agent", "engine"],
  ingredients: [
    {
      id: "presenter",
      kind: "presenter",
      label: "Presenter",
      need: "required",
      ways: [
        { id: "avatar", label: "AI presenter", modelClass: "avatar" },
        { id: "footage", label: "My footage", upload: true },
      ],
    },
    {
      id: "product",
      kind: "product_kit",
      label: "Product",
      need: "required",
      ways: [{ id: "kit", label: "Product kit", upload: true }],
    },
  ],
  steps: [
    { id: "script", kind: "script", label: "Write the script", after: [], uses: { role: "script" }, params: { hook_type: "problem" } },
    {
      id: "presenter_shot",
      kind: "avatar",
      label: "AI presenter",
      after: ["script"],
      when: { control: "presenter_way", equals: "avatar" },
      // The AI presenter is the presenter ingredient's paid way, so the step names no visual of its own.
      uses: {},
      params: {},
    },
    {
      id: "footage_cut",
      kind: "edit",
      label: "Cut your footage",
      after: ["script"],
      when: { control: "presenter_way", equals: "footage" },
      uses: {},
      params: {},
    },
    {
      id: "product_shots",
      kind: "visual",
      label: "Product in use",
      after: ["script"],
      when: { control: "product_shots", equals: true },
      uses: { visualType: "product_hero" },
      params: {},
    },
    { id: "captions", kind: "compose", label: "Captions", after: ["script"], uses: { component: "captions.karaoke" }, params: { highlight: "box" } },
    {
      id: "call_to_action",
      kind: "compose",
      label: "Call to action",
      after: ["script"],
      when: { control: "call_to_action", equals: true },
      uses: { component: "cta.card" },
      params: {},
    },
    { id: "edit", kind: "edit", label: "Cut", after: ["presenter_shot", "footage_cut", "captions"], uses: { role: "edit" }, params: {} },
    { id: "render", kind: "render", label: "Render 9:16", after: ["edit"], uses: {}, params: {} },
  ],
  instructions: [
    { role: "script", text: "Open on the problem the product solves, in the first sentence." },
    { role: "script", text: "Say what the product does in one sentence. Make no claim beyond the approved claims." },
    { role: "plan", text: "Show the product in use within the first five seconds, when product shots are on." },
    { role: "critic", text: "Check that every claim is one of the approved claims, and report any that is not." },
  ],
  grammar: { structure: [] },
  controls: [
    {
      id: "presenter_way",
      kind: "select",
      label: "Presenter",
      help: "An AI presenter is paid per shot. Your own footage is free.",
      options: [
        { value: "avatar", label: "AI presenter" },
        { value: "footage", label: "My footage" },
      ],
      default: "footage",
      binds: [{ choose: { ingredient: "presenter" } }],
    },
    {
      id: "product_kit",
      kind: "select",
      label: "Product",
      options: [{ value: "kit", label: "Product kit" }],
      default: "kit",
      binds: [{ choose: { ingredient: "product" } }],
    },
    {
      id: "hook_type",
      kind: "select",
      label: "Hook",
      options: [
        { value: "problem", label: "The problem first" },
        { value: "result", label: "The result first" },
        { value: "question", label: "A question" },
      ],
      default: "problem",
      binds: [{ set: "step.script.hook_type" }],
    },
    { id: "product_shots", kind: "toggle", label: "Product shots", help: "Paid per shot. Turn off to keep the video free.", default: false, binds: [{ enable: "product_shots" }] },
    { id: "call_to_action", kind: "toggle", label: "End card", default: true, binds: [{ enable: "call_to_action" }] },
  ],
  checks: [],
};

/** K27: a voice-led list: a spoken list of items over kinetic type, with stock clips when the person wants them. */
export const voiceListicleCookbook: Cookbook = {
  schema: "meridian.cookbook/v1",
  cookbookId: "ck_voice_listicle",
  version: 1,
  label: "Voice-led list",
  summary: "A spoken list of items over kinetic type, with optional stock clips. Free in agent mode when you record the voice yourself.",
  family: "listicle",
  scope: "builtin",
  modes: ["agent", "engine"],
  ingredients: [
    {
      id: "voice",
      kind: "voice",
      label: "Voice",
      need: "required",
      ways: [
        { id: "tts", label: "AI voice", modelClass: "tts" },
        { id: "recording", label: "My recording", upload: true },
      ],
    },
    {
      id: "clips",
      kind: "stock",
      label: "Clips",
      need: "optional",
      ways: [
        { id: "none", label: "Kinetic type only", coded: true },
        { id: "stock", label: "Stock clips", visualType: "stock_footage" },
      ],
    },
  ],
  steps: [
    { id: "script", kind: "script", label: "Write the list", after: [], uses: { role: "script" }, params: { items: 5 } },
    { id: "voice_over", kind: "voice", label: "Voice-over", after: ["script"], uses: { role: "voice" }, params: {} },
    { id: "list", kind: "compose", label: "Kinetic list", after: ["script"], uses: { component: "kinetic.type" }, params: {} },
    {
      id: "stock_clips",
      kind: "visual",
      label: "Stock clips",
      after: ["script"],
      when: { control: "clips_way", equals: "stock" },
      // The stock clips are the clips ingredient's paid way, so the step names no visual of its own.
      uses: {},
      params: {},
    },
    { id: "captions", kind: "compose", label: "Captions", after: ["voice_over"], uses: { component: "captions.karaoke" }, params: {} },
    { id: "edit", kind: "edit", label: "Cut to the voice", after: ["voice_over", "list"], uses: { role: "edit" }, params: {} },
    { id: "render", kind: "render", label: "Render 9:16", after: ["edit"], uses: {}, params: {} },
  ],
  instructions: [
    { role: "script", text: "One item to a beat, with its number first, then one sentence that says why it matters." },
    { role: "voice", text: "Speak in short sentences. Pause after each item number." },
    { role: "edit", text: "Cut on each item number. Keep each item on screen for as long as it is spoken." },
  ],
  grammar: { structure: [] },
  controls: [
    {
      id: "voice_way",
      kind: "select",
      label: "Voice",
      options: [
        { value: "tts", label: "AI voice" },
        { value: "recording", label: "My recording" },
      ],
      default: "recording",
      binds: [{ choose: { ingredient: "voice" } }],
    },
    {
      id: "clips_way",
      kind: "select",
      label: "Clips",
      options: [
        { value: "none", label: "Kinetic type only" },
        { value: "stock", label: "Stock clips" },
      ],
      default: "none",
      binds: [{ choose: { ingredient: "clips" } }],
    },
    { id: "items", kind: "slider", label: "Items", min: 3, max: 10, step: 1, default: 5, binds: [{ set: "step.script.items" }] },
  ],
  checks: [],
};
