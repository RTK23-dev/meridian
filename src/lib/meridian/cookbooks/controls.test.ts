// The shared control schema (K1): every compose component's declaration reads into controls, and each control kind refuses a value its
// own rules forbid, with the field named.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { controlSchema, controlsOfComponent, defaultsOf, bindingSchema } from "./controls.ts";

const COMPONENTS = join(import.meta.dirname, "../../../engine/compose/components");

test("every compose component's declaration reads into controls", () => {
  const names = readdirSync(COMPONENTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length >= 14, `expected the component library, found ${names.length}`);
  for (const name of names) {
    const html = readFileSync(join(COMPONENTS, name, "component.html"), "utf8");
    const result = controlsOfComponent(name, html);
    assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
    if (result.ok) {
      assert.ok(result.controls.length > 0, `${name} declares no controls`);
      for (const control of result.controls) {
        assert.ok(control.id.startsWith(`${name}.`), `${control.id} is not named for its component`);
        assert.deepEqual(control.binds, [{ set: `component.${control.id.slice(name.length + 1)}` }]);
      }
    }
  }
});

test("a component's enum becomes a select, a number a slider and a string a text box", () => {
  const html = `<div data-composition-variables='[{"id":"band","type":"enum","label":"Band","default":"lower","options":[{"value":"upper","label":"Upper"},{"value":"lower","label":"Lower"}]},{"id":"durationMs","type":"number","label":"Duration","default":1000,"min":1,"max":60000,"step":1,"unit":"ms"},{"id":"text","type":"string","label":"Text","default":"hi"}]'></div>`;
  const result = controlsOfComponent("demo.card", html);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.controls.map((control) => control.kind),
    ["select", "slider", "text"],
  );
  assert.deepEqual(defaultsOf(result.controls), { "demo.card.band": "lower", "demo.card.durationMs": 1000, "demo.card.text": "hi" });
});

test("a broken declaration fails with the entry and the field named", () => {
  const html = `<div data-composition-variables='[{"id":"band","type":"enum","label":"Band","default":"gone","options":[{"value":"upper","label":"Upper"}]}]'></div>`;
  const result = controlsOfComponent("bad.card", html);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.includes("bad.card[0]") && issue.includes("default")), result.issues.join("; "));
});

test("a missing attribute, bad JSON and a non-list are each refused", () => {
  assert.equal(controlsOfComponent("x", "<div></div>").ok, false);
  assert.equal(controlsOfComponent("x", "<div data-composition-variables='[oops'></div>").ok, false);
  assert.equal(controlsOfComponent("x", "<div data-composition-variables='{}'></div>").ok, false);
});

test("a slider default outside its range, and an empty range, are refused", () => {
  assert.equal(controlSchema.safeParse({ id: "pace", kind: "slider", label: "Pace", binds: [], min: 0, max: 10, step: 1, default: 11 }).success, false);
  assert.equal(controlSchema.safeParse({ id: "pace", kind: "slider", label: "Pace", binds: [], min: 5, max: 5, step: 1, default: 5 }).success, false);
  assert.equal(controlSchema.safeParse({ id: "pace", kind: "slider", label: "Pace", binds: [], min: 0, max: 10, step: 1, default: 4 }).success, true);
});

test("a select needs unique values and a default among them", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "a", label: "Again" },
  ];
  assert.equal(controlSchema.safeParse({ id: "mode", kind: "select", label: "Mode", binds: [], options, default: "a" }).success, false);
  assert.equal(controlSchema.safeParse({ id: "mode", kind: "select", label: "Mode", binds: [], options: options.slice(0, 1), default: "b" }).success, false);
});

test("a colour control picks a palette role, never a free colour", () => {
  const ok = { id: "highlight", kind: "colour", label: "Highlight", binds: [], roles: ["accent", "secondary"], default: "accent" };
  assert.equal(controlSchema.safeParse(ok).success, true);
  assert.equal(controlSchema.safeParse({ ...ok, default: "#FF0000" }).success, false);
  assert.equal(controlSchema.safeParse({ ...ok, default: "text" }).success, false);
});

test("a text control's default fits its maxLength", () => {
  assert.equal(controlSchema.safeParse({ id: "hook", kind: "text", label: "Hook", binds: [], maxLength: 4, default: "too long" }).success, false);
});

test("bindings are the four fixed shapes, and nothing else", () => {
  assert.equal(bindingSchema.safeParse({ set: "pace" }).success, true);
  assert.equal(bindingSchema.safeParse({ set: "pace", map: { linear: { in: [0, 1], out: [40, 300] } } }).success, true);
  assert.equal(bindingSchema.safeParse({ enable: "voice_over" }).success, true);
  assert.equal(bindingSchema.safeParse({ choose: { ingredient: "voice" } }).success, true);
  assert.equal(bindingSchema.safeParse({ instruct: { role: "script", text: "Open on the claim." } }).success, true);
  // Refused: an expression, an unknown role, an empty input range, an unknown key, and a path that is not a plain name.
  assert.equal(bindingSchema.safeParse({ set: "pace", eval: "1+1" }).success, false);
  assert.equal(bindingSchema.safeParse({ instruct: { role: "producer", text: "x" } }).success, false);
  assert.equal(bindingSchema.safeParse({ set: "pace", map: { linear: { in: [1, 1], out: [0, 1] } } }).success, false);
  assert.equal(bindingSchema.safeParse({ set: "process.env.KEY" }).success, true, "a dotted name is still a name, and the validator checks it against the cookbook");
  assert.equal(bindingSchema.safeParse({ set: "../etc" }).success, false);
  assert.equal(bindingSchema.safeParse({ instruct: { role: "script", text: "x".repeat(4001) } }).success, false);
});
