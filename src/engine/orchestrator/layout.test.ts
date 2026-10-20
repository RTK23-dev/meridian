import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orchestratorPlanSchema } from "./contracts.ts";
import { CANVAS_PAD, COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, layoutPlan } from "./layout.ts";
import { loadCatalog } from "./catalog.ts";
import { validatePlan } from "./validate.ts";

const sample = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const validated = validatePlan(sample, catalog);
if (!validated.ok) throw new Error("sample plan must validate");
const layout = layoutPlan(sample, validated.order);

test("a step sits one column past the steps it reads; a step with no reads is in column 0", () => {
  const column = Object.fromEntries(layout.nodes.map((node) => [node.id, node.column]));
  assert.deepEqual(column, {
    ref_viral: 0,
    brand: 0,
    analyze_ref: 1,
    script: 2,
    hero_still: 3,
    voice: 3,
    shot_1: 4,
    edit: 5,
    compose: 6,
    render: 7,
  });
});

test("steps in one column stack in plan order and never overlap", () => {
  const seen = new Set<string>();
  for (const node of layout.nodes) {
    const key = `${node.x},${node.y}`;
    assert.equal(seen.has(key), false, `two steps at ${key}`);
    seen.add(key);
  }
  const voice = layout.nodes.find((node) => node.id === "voice");
  const heroStill = layout.nodes.find((node) => node.id === "hero_still");
  assert.ok(voice && heroStill && heroStill.y < voice.y, "hero_still comes before voice in plan order");
});

test("every edge leaves the right side of its source and enters the left side of its target", () => {
  assert.equal(layout.edges.length, sample.nodes.reduce((count, node) => count + node.dependsOn.length, 0));
  for (const edge of layout.edges) {
    const from = layout.nodes.find((node) => node.id === edge.from);
    const to = layout.nodes.find((node) => node.id === edge.to);
    assert.ok(from && to);
    assert.ok(edge.d.startsWith(`M ${from.x + NODE_WIDTH} ${from.y + NODE_HEIGHT / 2} `), edge.d);
    assert.ok(edge.d.endsWith(` ${to.x} ${to.y + NODE_HEIGHT / 2}`), edge.d);
  }
});

test("the canvas is large enough to hold every step with its padding", () => {
  for (const node of layout.nodes) {
    assert.ok(node.x + NODE_WIDTH + CANVAS_PAD <= layout.width, `${node.id} runs past the right edge`);
    assert.ok(node.y + NODE_HEIGHT + CANVAS_PAD <= layout.height, `${node.id} runs past the bottom edge`);
  }
  const columns = Math.max(...layout.nodes.map((node) => node.column)) + 1;
  assert.equal(layout.width, CANVAS_PAD * 2 + columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP);
});

test("the same plan lays out the same way every time", () => {
  assert.deepEqual(layoutPlan(sample, validated.order), layout);
});
