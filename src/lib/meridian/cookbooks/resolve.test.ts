// resolveCookbook (K3): the same inputs give the same output; a control's value reaches the step it binds; costs are free, priced or
// unknown (never 0 for an unknown); agent mode needs every chosen way to be free; the orchestrator accepts the plan template.

import assert from "node:assert/strict";
import { test } from "node:test";
import { planNodeSchema } from "../../../engine/orchestrator/contracts.ts";
import { priceFor, prices } from "../../../engine/config/prices.ts";
import { shotCost } from "../../../engine/plan/cost.ts";
import { resolveCookbook, type ResolvedCookbook } from "./resolve.ts";

// A draft is loose on purpose: each test changes one field of a valid cookbook.
type Draft = any;

function fixture(): Draft {
  return structuredClone({
    schema: "meridian.cookbook/v1",
    cookbookId: "ck_resolve_demo",
    version: 2,
    label: "Resolve demo",
    summary: "A cookbook for the resolver tests.",
    family: "explainer",
    scope: "builtin",
    modes: ["agent", "engine"],
    ingredients: [
      {
        id: "voice",
        kind: "voice",
        label: "Voice",
        need: "optional",
        ways: [
          { id: "none", label: "No voice", coded: true },
          { id: "tts", label: "AI voice", modelClass: "tts" },
          { id: "upload", label: "My recording", upload: true },
        ],
      },
      {
        id: "scenes",
        kind: "generated_video",
        label: "Scenes",
        need: "required",
        ways: [
          { id: "coded", label: "Coded scenes", coded: true },
          { id: "generated", label: "Generated", visualType: "cinematic" },
        ],
      },
    ],
    steps: [
      { id: "script", kind: "script", label: "Script", uses: { role: "script" }, params: { beats: 5 } },
      { id: "scenes", kind: "compose", label: "Scenes", after: ["script"], uses: { component: "captions.karaoke" }, params: { pace: 1 } },
      { id: "voice_over", kind: "voice", label: "Voice-over", after: ["script"], when: { control: "voice_on", equals: true }, params: {} },
    ],
    instructions: [{ role: "script", text: "Keep the sentences short.", when: { control: "voice_on", equals: true } }],
    style: { styleKitId: "sk_demo", look: { preset: "cool", strength: 0.25 } },
    grammar: {
      structure: [
        { role: "hook", fromMs: 0, toMs: 4000 },
        { role: "payoff", fromMs: 4000, toMs: 10000 },
      ],
    },
    controls: [
      { id: "voice_on", kind: "toggle", label: "Voice-over", binds: [{ enable: "voice_over" }], default: true },
      { id: "hook_first", kind: "toggle", label: "Open on the claim", binds: [{ instruct: { role: "script", text: "Open on the claim." } }], default: false },
      { id: "beats", kind: "slider", label: "Beats", min: 3, max: 8, step: 1, default: 5, binds: [{ set: "step.script.beats" }] },
      {
        id: "pace",
        kind: "slider",
        label: "Pace",
        min: 0,
        max: 1,
        step: 0.1,
        default: 0.5,
        binds: [{ set: "step.scenes.pace", map: { linear: { in: [0, 1], out: [1, 4] } } }],
      },
      { id: "look", kind: "slider", label: "Look strength", min: 0, max: 1, step: 0.05, default: 0.25, binds: [{ set: "style.look.strength" }] },
      {
        id: "voice_way",
        kind: "select",
        label: "Voice",
        options: [
          { value: "none", label: "None" },
          { value: "tts", label: "AI" },
          { value: "upload", label: "Recording" },
        ],
        default: "none",
        binds: [{ choose: { ingredient: "voice" } }],
      },
      {
        id: "scenes_way",
        kind: "select",
        label: "Scenes",
        options: [
          { value: "coded", label: "Coded" },
          { value: "generated", label: "Generated" },
        ],
        default: "coded",
        binds: [{ choose: { ingredient: "scenes" } }],
      },
    ],
    checks: [{ measure: "hardCuts", target: 9, tolerance: 1 }],
  });
}

const LENGTH = 60000;

function resolved(input: unknown, values: Record<string, string | number | boolean> = {}, extra: { voiceCharacters?: number } = {}): ResolvedCookbook {
  const result = resolveCookbook(input, { values, lengthMs: LENGTH, ...extra });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

test("the same inputs give the same output, byte for byte", () => {
  const a = resolved(fixture(), { pace: 0.8 });
  const b = resolved(fixture(), { pace: 0.8 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("defaults are used for every control the person does not set, and the values hash follows the values", () => {
  const defaults = resolved(fixture());
  assert.equal(defaults.values.pace, 0.5);
  assert.equal(defaults.values.voice_on, true);
  const changed = resolved(fixture(), { pace: 0.8 });
  assert.notEqual(defaults.valuesHash, changed.valuesHash);
});

test("a control's value reaches the step it binds, through its map", () => {
  const step = resolved(fixture(), { pace: 0.5 }).steps.find((candidate) => candidate.id === "scenes");
  assert.equal(step?.params.pace, 2.5, "0.5 on 0 to 1 maps to 2.5 on 1 to 4");
});

test("a value outside its control, or a control the cookbook does not have, is refused", () => {
  const outOfRange = resolveCookbook(fixture(), { values: { pace: 2 }, lengthMs: LENGTH });
  assert.equal(outOfRange.ok, false);
  const unknown = resolveCookbook(fixture(), { values: { ghost: 1 }, lengthMs: LENGTH });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.ok(unknown.issues[0]?.includes("no control ghost"));
  const badWay = resolveCookbook(fixture(), { values: { voice_way: "robot" }, lengthMs: LENGTH });
  assert.equal(badWay.ok, false);
});

test("a toggle that is off turns its step off, and the plan leaves it out", () => {
  const on = resolved(fixture());
  assert.ok(on.planTemplate.some((node) => node.id === "voice_over"));
  const off = resolved(fixture(), { voice_on: false });
  assert.equal(off.steps.find((step) => step.id === "voice_over")?.enabled, false);
  assert.equal(off.steps.find((step) => step.id === "voice_over")?.offReason, "turned off");
  assert.equal(off.planTemplate.some((node) => node.id === "voice_over"), false);
  assert.equal((off.instructions.script ?? []).includes("Keep the sentences short."), false, "an instruction whose condition fails is left out");
});

test("a bound instruction is added only when its toggle is on", () => {
  assert.equal(resolved(fixture()).instructions.script?.includes("Open on the claim."), false);
  assert.equal(resolved(fixture(), { hook_first: true }).instructions.script?.includes("Open on the claim."), true);
});

test("a coded way is free, so a cookbook built from coded and uploaded ways runs in agent mode", () => {
  const plain = resolved(fixture(), { voice_way: "none", scenes_way: "coded" });
  assert.deepEqual(plain.modes, ["agent", "engine"]);
  assert.equal(plain.badge, "Free in agent mode");
  const recorded = resolved(fixture(), { voice_way: "upload", scenes_way: "coded" });
  assert.deepEqual(recorded.modes, ["agent", "engine"], "a person's own recording is free too");
});

test("a text-to-speech way stays unknown until its character count is known, and then is priced", () => {
  const unknown = resolved(fixture(), { voice_way: "tts" });
  const voice = unknown.ingredients.find((item) => item.id === "voice");
  assert.equal(voice?.cost?.kind, "unknown", "no count, so no price: never 0");
  assert.equal(unknown.badge, "Price unknown");
  assert.deepEqual(unknown.modes, ["engine"], "an unknown price is a paid way, so agent mode is off");
  const priced = resolved(fixture(), { voice_way: "tts" }, { voiceCharacters: 1000 });
  const entry = priceFor(prices.routeFor.tts);
  assert.equal(priced.ingredients.find((item) => item.id === "voice")?.cost?.kind, "paid");
  assert.equal(priced.estimate.knownUsd, Math.round(((entry.usd ?? 0) * 1000) / 1_000_000 * 10000) / 10000);
});

test("a generated cinematic shot is priced by the engine's own shot cost, and turns agent mode off", () => {
  const generated = resolved(fixture(), { scenes_way: "generated" });
  const expected = shotCost("cinematic", LENGTH);
  assert.equal(expected.known, true, "the cinematic recipe is priced in the table");
  if (!expected.known) return;
  assert.equal(generated.estimate.knownUsd, Math.round(expected.totalUsd * 10000) / 10000);
  assert.deepEqual(generated.modes, ["engine"]);
  assert.equal(generated.badge, `Paid: about $${generated.estimate.knownUsd.toFixed(2)}`);
});

test("a required ingredient with no choice is named, and engine mode waits for it", () => {
  const cookbook = fixture();
  cookbook.controls = cookbook.controls.filter((control: { id: string }) => control.id !== "scenes_way");
  const result = resolved(cookbook);
  assert.equal(result.ingredients.find((item) => item.id === "scenes")?.status, "needs_choice");
  assert.equal(result.badge, "Choose scenes");
  assert.deepEqual(result.modes, [], "no mode is offered until the required choice is made");
  assert.ok(result.requirements.includes("Scenes: choose one"));
});

test("the requirements read in plain words, one line per chosen ingredient", () => {
  const result = resolved(fixture(), { voice_way: "upload", scenes_way: "coded" });
  assert.deepEqual(result.requirements, ["Voice: My recording (free)", "Scenes: Coded scenes (free)"]);
});

test("a lookup table sets the parameter for the chosen option, and an option with no entry is refused", () => {
  const cookbook = fixture();
  cookbook.controls.push({
    id: "mood",
    kind: "select",
    label: "Mood",
    options: [
      { value: "calm", label: "Calm" },
      { value: "bold", label: "Bold" },
    ],
    default: "calm",
    binds: [{ set: "step.script.beats", map: { table: { calm: 4, bold: 7 } } }],
  });
  const calm = resolved(cookbook, { mood: "bold" });
  assert.equal(calm.steps.find((step) => step.id === "script")?.params.beats, 7);
  const missing = structuredClone(cookbook);
  missing.controls[missing.controls.length - 1].options.push({ value: "wild", label: "Wild" });
  assert.equal(resolveCookbook(missing, { lengthMs: LENGTH }).ok, false, "an option with no table entry is refused before any run");
});

test("the plan template is a list the orchestrator's own schema accepts", () => {
  const result = resolved(fixture(), { voice_way: "upload" });
  assert.ok(result.planTemplate.length >= 2);
  for (const node of result.planTemplate) {
    const parsed = planNodeSchema.safeParse(node);
    assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  }
});

test("a component control reaches the request, when its declaration is supplied", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { controlsOfComponent } = await import("./controls.ts");
  const html = readFileSync(join(import.meta.dirname, "../../../engine/compose/components/captions.karaoke/component.html"), "utf8");
  const declared = controlsOfComponent("captions.karaoke", html);
  assert.equal(declared.ok, true);
  if (!declared.ok) return;
  const cookbook = fixture();
  cookbook.controls.push({
    id: "caption_ms",
    kind: "slider",
    label: "Duration",
    min: 1,
    max: 60000,
    step: 1,
    default: 1200,
    binds: [{ set: "component.captions.karaoke.durationMs" }],
  });
  const result = resolveCookbook(cookbook, { lengthMs: LENGTH, context: { components: { "captions.karaoke": declared.controls } } });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (result.ok) assert.equal(result.resolved.request.componentProps["captions.karaoke"]?.durationMs, 1200);
});

test("the agent brief states the no-paid-call rule, the steps and the checks", () => {
  const brief = resolved(fixture(), { voice_way: "none" }).agentBrief;
  assert.match(brief, /no paid provider call/);
  assert.match(brief, /1\. Script/);
  assert.match(brief, /hardCuts 9 \(\+\/- 1\)/);
});

test("a cookbook that fails validation is not resolved", () => {
  const broken = fixture();
  broken.steps[0].after = ["scenes"];
  broken.steps[1].after = ["script"];
  const result = resolveCookbook(broken, { lengthMs: LENGTH });
  assert.equal(result.ok, false);
});

test("a video length must be positive", () => {
  assert.equal(resolveCookbook(fixture(), { lengthMs: 0 }).ok, false);
});

test("a step that makes a paid visual is priced even when no ingredient names it, and it takes the run out of agent mode", () => {
  const cookbook = fixture();
  cookbook.controls.push({ id: "shots", kind: "toggle", label: "Product shots", default: false, binds: [{ enable: "product_shots" }] });
  cookbook.steps.push({ id: "product_shots", kind: "visual", label: "Product shots", after: ["script"], when: { control: "shots", equals: true }, uses: { visualType: "product_hero" }, params: {} });
  const off = resolved(cookbook, { shots: false, voice_way: "none", scenes_way: "coded" });
  assert.deepEqual(off.modes, ["agent", "engine"]);
  const on = resolved(cookbook, { shots: true, voice_way: "none", scenes_way: "coded" });
  assert.deepEqual(on.modes, ["engine"], "a paid shot is never run in agent mode");
  assert.ok(on.estimate.knownUsd > 0 || on.estimate.unknown.length > 0, "the shot is priced, or its price is named as unknown");
  assert.ok(on.requirements.some((line) => line.startsWith("Product shots:")));
});

test("a coded graphics step costs nothing, so it does not take the run out of agent mode", () => {
  const cookbook = fixture();
  cookbook.steps.push({ id: "graphics", kind: "compose", label: "Graphics", after: ["script"], uses: { visualType: "coded_graphics" }, params: {} });
  assert.deepEqual(resolved(cookbook, { voice_way: "none", scenes_way: "coded" }).modes, ["agent", "engine"]);
});
