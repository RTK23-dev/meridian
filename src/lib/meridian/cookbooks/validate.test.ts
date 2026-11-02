// validateCookbook (K2): a valid cookbook passes, and each rule refuses the case it names, with the field in the message.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { controlsOfComponent } from "./controls.ts";
import { validateCookbook, type ValidationContext } from "./validate.ts";

const COMPONENT_HTML = readFileSync(join(import.meta.dirname, "../../../engine/compose/components/captions.karaoke/component.html"), "utf8");
const CONTEXT: ValidationContext = (() => {
  const result = controlsOfComponent("captions.karaoke", COMPONENT_HTML);
  if (!result.ok) throw new Error(result.issues.join("; "));
  return { components: { "captions.karaoke": result.controls } };
})();

// A draft is loose on purpose: the tests break one field at a time, and some breaks are type errors the validator must catch.
type Draft = any;

function base(): Draft {
  return structuredClone({
    schema: "meridian.cookbook/v1",
    cookbookId: "ck_demo_explainer",
    version: 1,
    label: "Demo explainer",
    summary: "A demo cookbook used by the validator tests.",
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
      { id: "scenes", kind: "compose", label: "Scenes", after: ["script"], uses: { component: "captions.karaoke" }, params: {} },
      { id: "voice_over", kind: "voice", label: "Voice-over", after: ["script"], when: { control: "voice_on", equals: true }, params: {} },
    ],
    instructions: [{ role: "script", text: "Open on the claim." }],
    style: { styleKitId: "sk_demo", look: { preset: "cool", strength: 0.25 } },
    grammar: {
      structure: [
        { role: "hook", fromMs: 0, toMs: 4000 },
        { role: "payoff", fromMs: 4000, toMs: 10000 },
      ],
    },
    controls: [
      { id: "voice_on", kind: "toggle", label: "Voice-over", binds: [{ enable: "voice_over" }], default: true },
      { id: "beats", kind: "slider", label: "Beats", min: 3, max: 8, step: 1, default: 5, binds: [{ set: "step.script.beats" }] },
      { id: "look", kind: "slider", label: "Look strength", min: 0, max: 1, step: 0.05, default: 0.25, binds: [{ set: "style.look.strength" }] },
      {
        id: "voice_way",
        kind: "select",
        label: "Voice",
        options: [
          { value: "none", label: "None" },
          { value: "tts", label: "AI" },
        ],
        default: "none",
        binds: [{ choose: { ingredient: "voice" } }],
      },
    ],
    checks: [{ measure: "hardCuts", target: 9, tolerance: 1 }],
  });
}

function issuesOf(cookbook: unknown, context?: ValidationContext): string[] {
  const result = validateCookbook(cookbook, context);
  assert.equal(result.ok, false, "expected the cookbook to be refused");
  return result.ok ? [] : result.issues;
}

test("a valid cookbook passes", () => {
  const result = validateCookbook(base());
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
});

test("an unknown key is refused: a cookbook carries no field nobody reads, and no expression", () => {
  const cookbook = { ...base(), expression: "1 + 1" };
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("expression") || issue.includes("unrecognized")));
});

test("a control can only set a path the cookbook owns", () => {
  const cookbook = base();
  cookbook.controls[1].binds = [{ set: "process.env.KEY" }];
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("is not settable")));
});

test("a step parameter must exist on that step", () => {
  const cookbook = base();
  cookbook.controls[1].binds = [{ set: "step.script.nope" }];
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("is not a parameter of step script")));
});

test("a control's kind must fit the value it sets", () => {
  const cookbook = base();
  cookbook.controls.push({ id: "beats_text", kind: "text", label: "Beats", maxLength: 10, default: "5", binds: [{ set: "step.script.beats" }] });
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("takes a number")));
});

test("a slider cannot leave the engine's bound for the style look", () => {
  const cookbook = base();
  cookbook.controls[2].max = 2;
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("is outside 0 to 1")));
});

test("a linear map cannot send its output past the engine's bound", () => {
  const cookbook = base();
  cookbook.controls[2].binds = [{ set: "style.look.strength", map: { linear: { in: [0, 8], out: [0, 5] } } }];
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("the mapped output 0 to 5 is outside 0 to 1")));
});

test("a look preset option must be a look the engine draws", () => {
  const cookbook = base();
  cookbook.controls.push({
    id: "look_name",
    kind: "select",
    label: "Look",
    options: [{ value: "neon", label: "Neon" }],
    default: "neon",
    binds: [{ set: "style.look.preset" }],
  });
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("option neon is not allowed")));
});

test("ids are unique among steps, ingredients, controls and modes", () => {
  const cookbook = base();
  cookbook.steps.push({ ...cookbook.steps[0] });
  cookbook.controls.push({ ...cookbook.controls[0] });
  cookbook.modes = ["agent", "agent"];
  const issues = issuesOf(cookbook);
  assert.ok(issues.some((issue) => issue.includes("steps.script")));
  assert.ok(issues.some((issue) => issue.includes("controls.voice_on")));
  assert.ok(issues.some((issue) => issue.includes("modes: agent")));
});

test("steps form no cycle, and every dependency names a step", () => {
  const loop = base();
  loop.steps[0].after = ["scenes"];
  assert.ok(issuesOf(loop).some((issue) => issue.includes("depend on each other in a loop")));
  const missing = base();
  missing.steps[1].after = ["nowhere"];
  assert.ok(issuesOf(missing).some((issue) => issue.includes("nowhere is not a step")));
});

test("a condition names a control that exists, and a value that fits it", () => {
  const unknown = base();
  unknown.steps[2].when = { control: "ghost", equals: true };
  assert.ok(issuesOf(unknown).some((issue) => issue.includes("control ghost, which does not exist")));
  const wrong = base();
  wrong.steps[2].when = { control: "voice_on", equals: "yes" };
  assert.ok(issuesOf(wrong).some((issue) => issue.includes('"yes" does not fit control voice_on')));
});

test("enable needs a toggle, and choose needs a select whose options are the ingredient's ways", () => {
  const enable = base();
  enable.controls[2].binds = [{ enable: "voice_over" }];
  assert.ok(issuesOf(enable).some((issue) => issue.includes("enable needs a toggle")));
  const choose = base();
  choose.controls[3].options.push({ value: "robot", label: "Robot" });
  assert.ok(issuesOf(choose).some((issue) => issue.includes("option robot is not a way of ingredient voice")));
  const missing = base();
  missing.controls[3].binds = [{ choose: { ingredient: "music" } }];
  assert.ok(issuesOf(missing).some((issue) => issue.includes("ingredient music, which does not exist")));
});

test("agent mode needs a free way for every required ingredient", () => {
  const cookbook = base();
  cookbook.ingredients[1].ways = [{ id: "generated", label: "Generated", visualType: "cinematic" }];
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("modes.agent: required ingredient scenes has no free way")));
  cookbook.modes = ["engine"];
  assert.equal(validateCookbook(cookbook).ok, true, "an engine-only cookbook may need paid ways");
});

test("instructions are bounded per instruction and in total", () => {
  const long = base();
  long.instructions = [{ role: "script", text: "x".repeat(4001) }];
  assert.equal(validateCookbook(long).ok, false);
  const total = base();
  total.instructions = Array.from({ length: 5 }, () => ({ role: "script", text: "x".repeat(3900) }));
  assert.ok(issuesOf(total).some((issue) => issue.includes("19500 characters in total")));
});

test("the beats of the structure are contiguous, and each has a length", () => {
  const gap = base();
  gap.grammar.structure[1].fromMs = 5000;
  assert.ok(issuesOf(gap).some((issue) => issue.includes("grammar.structure[1]") && issue.includes("not where the last one ends")));
});

test("a check measure is named once", () => {
  const cookbook = base();
  cookbook.checks.push({ measure: "hardCuts", target: 8, tolerance: 2 });
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("checks.hardCuts")));
});

test("a component variable binds when a step uses that component and the declaration is provided", () => {
  const cookbook = base();
  cookbook.controls.push({
    id: "caption_ms",
    kind: "slider",
    label: "Duration",
    min: 1,
    max: 60000,
    step: 1,
    default: 1000,
    binds: [{ set: "component.captions.karaoke.durationMs" }],
  });
  assert.equal(validateCookbook(cookbook, CONTEXT).ok, true);
  // Without the declarations the path is not settable: fail closed.
  assert.ok(issuesOf(cookbook).some((issue) => issue.includes("is not settable") || issue.includes("is not a declared variable")));
  // A range wider than the declaration is refused.
  const wide = structuredClone(cookbook);
  wide.controls[wide.controls.length - 1].max = 999999;
  assert.ok(issuesOf(wide, CONTEXT).some((issue) => issue.includes("outside 1 to 60000")));
});

test("a component variable needs a step that uses its component", () => {
  const cookbook = base();
  cookbook.steps[1].uses = {};
  cookbook.controls.push({
    id: "caption_ms",
    kind: "slider",
    label: "Duration",
    min: 1,
    max: 60000,
    step: 1,
    default: 1000,
    binds: [{ set: "component.captions.karaoke.durationMs" }],
  });
  assert.ok(issuesOf(cookbook, CONTEXT).some((issue) => issue.includes("needs a step that uses component captions.karaoke")));
});

test("a select with a lookup table sets a number, when every option has an entry of that type", () => {
  const cookbook = base();
  cookbook.controls.push({
    id: "length",
    kind: "select",
    label: "Length",
    options: [
      { value: "30", label: "30 s" },
      { value: "60", label: "60 s" },
    ],
    default: "60",
    binds: [{ set: "step.script.beats", map: { table: { "30": 3, "60": 5 } } }],
  });
  assert.equal(validateCookbook(cookbook).ok, true, JSON.stringify(validateCookbook(cookbook).ok));
  const missing = structuredClone(cookbook);
  missing.controls[missing.controls.length - 1].options.push({ value: "45", label: "45 s" });
  assert.ok(issuesOf(missing).some((issue) => issue.includes("option 45 has no table entry")));
  const wrongType = structuredClone(cookbook);
  wrongType.controls[wrongType.controls.length - 1].binds = [{ set: "step.script.beats", map: { table: { "30": "three", "60": 5 } } }];
  assert.ok(issuesOf(wrongType).some((issue) => issue.includes("table entry 30 is not a number")));
});
