import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COST_COPY, EXAMPLE_GOALS, FILTERS, GEOMETRY, KIND_LABEL, SAMPLE_PLAN, STATE, STATE_COPY, costLabel, initialState, layoutSteps, reduce, restrictionText, toastDuration, visibleIds,
} from "../docs/design/prototype/model.mjs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const layoutSource = source("../src/engine/orchestrator/layout.ts");
const presentationSource = source("../src/components/content-factory/orchestrator-presentation.ts");

test("the canvas geometry is the engine's geometry", () => {
  const pairs = [["NODE_WIDTH", GEOMETRY.nodeWidth], ["NODE_HEIGHT", GEOMETRY.nodeHeight], ["COLUMN_GAP", GEOMETRY.columnGap], ["ROW_GAP", GEOMETRY.rowGap], ["CANVAS_PAD", GEOMETRY.canvasPad]];
  for (const [name, value] of pairs) {
    const declared = layoutSource.match(new RegExp(`export const ${name} = (\\d+);`));
    assert.ok(declared, `layout.ts declares ${name}`);
    assert.equal(Number(declared[1]), value, `${name} differs from layout.ts`);
  }
});

test("the example goals are the app's own goals, in its order", () => {
  for (const goal of EXAMPLE_GOALS) assert.ok(presentationSource.includes(`"${goal}"`), `"${goal}" is in orchestrator-presentation.ts`);
});

test("every state word and kind label is the app's own copy", () => {
  for (const state of Object.values(STATE)) {
    assert.ok(presentationSource.includes(`label: "${state.label}"`), `"${state.label}" is in orchestrator-presentation.ts`);
  }
  for (const label of Object.values(KIND_LABEL)) {
    assert.ok(presentationSource.includes(`label: "${label}"`), `"${label}" is in orchestrator-presentation.ts`);
  }
});

test("every state has a word, a dot shape and a tone, and no two words match", () => {
  const dots = new Set(["hollow", "filled", "cross", "plug", "pause", "dashed"]);
  const tones = new Set(["muted", "accent", "success", "danger", "warning", "info", "secondary"]);
  const words = Object.values(STATE).map((state) => state.label);
  assert.equal(new Set(words).size, words.length);
  for (const [key, state] of Object.entries(STATE)) {
    assert.ok(dots.has(state.dot), `${key} has a known dot`);
    assert.ok(tones.has(state.tone), `${key} has a known tone`);
    assert.ok(state.label.length > 0, `${key} has a word`);
  }
});

test("the sample plan shows the five states that a plan can show, and the legend shows all ten", () => {
  const used = new Set(SAMPLE_PLAN.steps.map((step) => step.state));
  for (const key of ["planned", "running", "done", "paused", "not_connected"]) assert.ok(used.has(key), `the sample has ${key}`);
  assert.equal(Object.keys(STATE).length, 10);
});

test("layout places each step one column right of the steps it reads, and stacks steps that share a column in plan order", () => {
  const layout = layoutSteps(SAMPLE_PLAN.steps);
  const at = Object.fromEntries(layout.nodes.map((node) => [node.id, node]));
  assert.equal(at.s1.column, 0);
  assert.equal(at.s3.column, 2);
  assert.equal(at.s4.column, 3, "a still reads the script, so it sits in column 3");
  assert.equal(at.s5.column, 3, "a voice-over also reads the script, so it shares column 3");
  assert.equal(at.s4.row, 0, "the earlier step in plan order is on top");
  assert.equal(at.s5.row, 1);
  assert.equal(at.s6.column, 4, "a shot reads the still, which is in column 3");
  assert.equal(at.s7.column, 5);
  assert.equal(at.s8.column, 6);
});

test("layout size and edges follow from the geometry", () => {
  const layout = layoutSteps(SAMPLE_PLAN.steps);
  assert.equal(layout.width, GEOMETRY.canvasPad * 2 + 7 * GEOMETRY.nodeWidth + 6 * GEOMETRY.columnGap);
  assert.equal(layout.height, GEOMETRY.canvasPad * 2 + 2 * GEOMETRY.nodeHeight + GEOMETRY.rowGap);
  assert.equal(layout.edges.length, SAMPLE_PLAN.steps.reduce((total, step) => total + step.reads.length, 0));
});

test("a cycle in the reads is an error, not a guess", () => {
  const cyclic = [
    { id: "a", reads: ["b"] },
    { id: "b", reads: ["a"] },
  ];
  assert.throws(() => layoutSteps(cyclic), /cycle/);
});

test("the layout depends on the plan alone, never on what is selected, filtered or loading", () => {
  const before = JSON.stringify(layoutSteps(SAMPLE_PLAN.steps));
  let state = initialState();
  state = reduce(state, { type: "select", id: "s6" });
  state = reduce(state, { type: "assistant", open: true });
  state = reduce(state, { type: "filter", filter: "needs" });
  state = reduce(state, { type: "loading", on: true });
  assert.equal(state.selectedId, "s6", "the state did change");
  assert.equal(JSON.stringify(layoutSteps(SAMPLE_PLAN.steps)), before);
});

test("the selected step is kept when the view changes, the drawer closes, or the assistant opens", () => {
  let state = reduce(initialState(), { type: "select", id: "s4" });
  for (const view of ["strip", "list", "canvas"]) {
    state = reduce(state, { type: "view", view });
    assert.equal(state.selectedId, "s4", `still s4 in ${view}`);
  }
  state = reduce(state, { type: "close" });
  assert.equal(state.selectedId, "s4", "closing keeps the reader's place");
  assert.equal(state.drawerOpen, false);
  state = reduce(state, { type: "assistant", open: true });
  assert.equal(state.selectedId, "s4");
  assert.equal(state.view, "canvas");
});

test("selecting a step the filter hides clears the filter and says so, never fails silently", () => {
  let state = reduce(initialState(), { type: "filter", filter: "needs" });
  assert.deepEqual(visibleIds(state), ["s5", "s6"]);
  state = reduce(state, { type: "select", id: "s1" });
  assert.equal(state.filter, "all");
  assert.equal(state.selectedId, "s1");
  assert.match(state.notice, /hidden by the filter/);
});

test("a visible selection carries no notice", () => {
  let state = reduce(initialState(), { type: "filter", filter: "needs" });
  state = reduce(state, { type: "select", id: "s6" });
  assert.equal(state.filter, "needs");
  assert.equal(state.notice, null);
});

test("the restriction names what is shown and how many, in words", () => {
  const state = reduce(initialState(), { type: "filter", filter: "needs" });
  assert.equal(restrictionText(state), "Showing 2 of 8 steps: needs you.");
  assert.equal(restrictionText(initialState()), "8 steps");
  assert.equal(FILTERS.running.includes(SAMPLE_PLAN.steps[3]), true);
});

test("the assistant toggle changes nothing about the plan's identity", () => {
  let state = reduce(initialState(), { type: "select", id: "s2" });
  const next = reduce(state, { type: "assistant", open: true });
  assert.equal(next.view, state.view);
  assert.equal(next.selectedId, state.selectedId);
  assert.equal(next.filter, state.filter);
});

test("toasts: passing confirmations leave by themselves, warnings and failures stay until dismissed", () => {
  assert.equal(toastDuration("success"), 4000);
  assert.equal(toastDuration("info"), 4000);
  assert.equal(toastDuration("warning"), null);
  assert.equal(toastDuration("danger"), null);
  assert.throws(() => toastDuration("celebrate"), /no toast policy/);
});

test("a cost is recorded, estimated, not recorded or absent, and never a made-up zero", () => {
  assert.equal(costLabel({ kind: "recorded", usd: 0 }), "$0.0000", "a recorded zero is still a recorded value");
  assert.equal(costLabel({ kind: "recorded", usd: 0.0212 }), "$0.0212");
  assert.equal(costLabel({ kind: "estimate", usd: 0.09 }), "est. $0.0900");
  assert.equal(costLabel({ kind: "estimate", usd: null }), "not recorded");
  assert.equal(costLabel({ kind: "unknown" }), "not recorded");
  assert.equal(costLabel({ kind: "none" }), "No model call");
  assert.throws(() => costLabel({ kind: "guess" }), /no cost rule/);
});

test("an unknown action is an error", () => {
  assert.throws(() => reduce(initialState(), { type: "explode" }), /unknown action/);
});

test("every state says what it means and what to do next, in full sentences", () => {
  for (const key of Object.keys(STATE)) {
    const copy = STATE_COPY[key];
    assert.ok(copy, `${key} has copy`);
    for (const field of ["meaning", "next"]) {
      assert.ok(copy[field].length > 10, `${key}.${field} is a sentence`);
      assert.match(copy[field], /[.!?]$/, `${key}.${field} ends a sentence`);
    }
  }
  assert.deepEqual(Object.keys(STATE_COPY).sort(), Object.keys(STATE).sort());
});

test("the cost copy covers every kind of figure the cost labels can show", () => {
  assert.deepEqual(Object.keys(COST_COPY).sort(), ["estimate", "none", "recorded", "unknown"]);
  for (const text of Object.values(COST_COPY)) assert.match(text, /[.!?]$/);
});

test("the copy uses no dash as an aside, so every sentence reads plainly", () => {
  const copy = [...Object.values(STATE_COPY).flatMap((c) => [c.meaning, c.next]), ...Object.values(COST_COPY)];
  for (const sentence of copy) assert.doesNotMatch(sentence, /[\u2013\u2014]/, sentence);
});
