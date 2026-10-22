import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACCENT,
  BUDGET,
  COMPOSER_LIMITS,
  EXAMPLE_GOALS,
  KIND_STYLE,
  NODE_KIND_ORDER,
  STALE_STYLE,
  STATE_STYLE,
  ZOOM_MAX,
  ZOOM_MIN,
  costText,
  describePlanOutcome,
  edgeAccent,
  fitScale,
  listWords,
  missingFields,
  nextZoom,
  parseBudget,
  replayStatus,
  stepName,
  undrawnReason,
} from "./orchestrator-presentation.ts";

test("every step kind has a label, a colour role, an icon and a summary, in the order a reader meets them", () => {
  assert.deepEqual(NODE_KIND_ORDER, ["reference", "analysis", "script", "visual", "video", "voice", "avatar", "edit", "compose", "render"]);
  for (const kind of NODE_KIND_ORDER) {
    const style = KIND_STYLE[kind];
    assert.ok(style.label.length > 0, `${kind} has no label`);
    assert.ok(style.summary.length > 0, `${kind} has no summary`);
    assert.ok(style.accent in ACCENT, `${kind} has an unknown colour role`);
  }
  const labels = NODE_KIND_ORDER.map((kind) => KIND_STYLE[kind].label);
  assert.equal(new Set(labels).size, labels.length, "two kinds share a label");
});

test("the summaries describe steps and name no model", () => {
  for (const kind of NODE_KIND_ORDER) {
    assert.doesNotMatch(KIND_STYLE[kind].summary, /[a-z0-9]\/[a-z0-9]/i, `${kind} summary looks like a model id`);
  }
});

test("NOT CONNECTED stays the literal word, and only the reason states show a reason line", () => {
  assert.equal(STATE_STYLE.not_connected.label, "NOT CONNECTED");
  assert.deepEqual(
    Object.entries(STATE_STYLE)
      .filter(([, style]) => style.showsReason)
      .map(([state]) => state)
      .sort(),
    ["failed", "not_connected", "paused"],
  );
  assert.equal(STALE_STYLE.label, "To re-run");
  assert.equal(STALE_STYLE.accent, "warning");
});

test("a cost is the recorded cost when there is one, otherwise the estimate marked as an estimate, otherwise nothing", () => {
  assert.equal(costText(0.0123, 0.5), "$0.0123");
  assert.equal(costText(null, 0.5), "est. $0.5000");
  assert.equal(costText(undefined, 0.5), "est. $0.5000");
  assert.equal(costText(null, null), null);
  assert.equal(costText(0, null), "$0.0000", "a recorded zero is a cost, not a missing one");
});

test("the accessible name says kind, title, state, model and cost, in that order", () => {
  assert.equal(
    stepName({ kind: "video", title: "Hero shot", state: "done", stale: false, model: "vendor/model-x", cost: "$0.0100" }),
    "Shot: Hero shot, Done, model vendor/model-x, $0.0100",
  );
  assert.equal(
    stepName({ kind: "reference", title: "Brand kit", state: "planned", stale: true, model: null, cost: null }),
    "Reference: Brand kit, To re-run",
  );
});

test("an edge takes the colour of the step it leaves", () => {
  assert.equal(edgeAccent("video"), KIND_STYLE.video.accent);
  assert.equal(edgeAccent("reference"), "muted");
});

test("the replay status counts drawn events and never exceeds the total", () => {
  assert.equal(replayStatus(3, 12, false), "3 of 12 events drawn");
  assert.equal(replayStatus(40, 12, false), "12 of 12 events drawn");
  assert.equal(replayStatus(0, 0, true), "Every step shown");
});

test("fit to width is at most 1 and at least the minimum zoom; an empty measurement is 1", () => {
  assert.equal(fitScale(0, 1000), 1);
  assert.equal(fitScale(500, 0), 1);
  assert.equal(fitScale(2000, 1000), 1);
  assert.equal(fitScale(800, 1000), 0.8);
  assert.equal(fitScale(100, 1000), ZOOM_MIN);
});

test("zoom steps move one step at a time and stop at the ends", () => {
  assert.equal(nextZoom(1, "in"), 1.25);
  assert.equal(nextZoom(1, "out"), 0.75);
  assert.equal(nextZoom(0.8, "in"), 1, "a fitted scale zooms to the next step above it");
  assert.equal(nextZoom(0.8, "out"), 0.75);
  assert.equal(nextZoom(ZOOM_MAX, "in"), ZOOM_MAX);
  assert.equal(nextZoom(ZOOM_MIN, "out"), ZOOM_MIN);
});

test("the budget is a number from 0.01 to 1000, and anything else is null", () => {
  assert.equal(parseBudget("2"), 2);
  assert.equal(parseBudget("0.01"), BUDGET.min);
  assert.equal(parseBudget("1000"), BUDGET.max);
  for (const bad of ["", "   ", "0", "0.009", "1000.01", "abc", "-3", "Infinity"]) {
    assert.equal(parseBudget(bad), null, `${JSON.stringify(bad)} should not be a budget`);
  }
});

test("the composer names exactly what is missing, in form order", () => {
  const ready = { brandId: "brand_1", title: "Launch", goal: "A video", format: "9:16, 20 seconds", budget: "2", storedModel: "vendor/model" };
  assert.deepEqual(missingFields(ready), []);
  assert.deepEqual(missingFields({ ...ready, brandId: "" }), ["a brand"]);
  assert.deepEqual(missingFields({ ...ready, title: "   ", goal: "", format: "" }), ["a title", "a goal", "the format"]);
  assert.deepEqual(missingFields({ ...ready, budget: "0" }), ["a budget from $0.01 to $1,000"]);
  assert.deepEqual(missingFields({ ...ready, storedModel: null }), ["an orchestrating model, stored in the Content Factory panel"]);
});

test("a plan that cannot be drawn says why: a missing step, or a loop", () => {
  assert.equal(
    undrawnReason([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a", "gone"] },
    ]),
    "step b reads step gone, which is not in the plan.",
  );
  assert.equal(
    undrawnReason([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]),
    "the steps depend on each other in a loop, so there is no order to draw them in.",
  );
});

test("listWords joins items the way a sentence does", () => {
  assert.equal(listWords([]), "");
  assert.equal(listWords(["a title"]), "a title");
  assert.equal(listWords(["a title", "a goal"]), "a title and a goal");
  assert.equal(listWords(["a", "b", "c"]), "a, b and c");
});

test("a planning outcome is said plainly and only a ready plan is called ready", () => {
  assert.deepEqual(describePlanOutcome({ status: "ready", reasons: [] }), {
    tone: "success",
    text: "The plan is ready. Review its steps, then run it.",
  });
  const refused = describePlanOutcome({ status: "refused", reasons: ["step shot_1 has no price", "over budget"] });
  assert.equal(refused.tone, "danger");
  assert.match(refused.text, /^The plan was refused: step shot_1 has no price and over budget\./);
  const notConnected = describePlanOutcome({ status: "not_connected", reason: "No OpenRouter key is connected." });
  assert.equal(notConnected.tone, "warning");
  assert.ok(notConnected.text.startsWith("NOT CONNECTED. No OpenRouter key is connected"));
  // A failed read is a catalog read error, never NOT CONNECTED: only a catalog with no key is not connected.
  const failed = describePlanOutcome({ status: "failed", reason: "timeout" });
  assert.equal(failed.tone, "danger");
  assert.match(failed.text, /^The catalog could not be read: timeout\./);
  assert.doesNotMatch(failed.text, /NOT CONNECTED/);
  assert.equal(describePlanOutcome({ status: "something_new" }).tone, "danger", "an unknown outcome is never a success");
});

test("example goals are filled in as text and name no model", () => {
  assert.ok(EXAMPLE_GOALS.length >= 3);
  for (const goal of EXAMPLE_GOALS) {
    assert.ok(goal.length > 0 && goal.length <= COMPOSER_LIMITS.goal);
    assert.doesNotMatch(goal, /[a-z0-9]\/[a-z0-9]/i);
  }
});

// The UI files may not name a model id or inject raw HTML. Plan text, model ids and reasons are untrusted data.
const UI_FILES = ["orchestrator-presentation.ts", "orchestrator-canvas.tsx", "orchestrator-canvas-parts.tsx", "orchestrator-composer.tsx", "orchestrator-plans.tsx", "orchestrator-screen.tsx"];
const MODEL_ID_IN_QUOTES = /"~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*"/i;

test("no orchestrator UI file names a model id or uses raw HTML injection", () => {
  const hits: string[] = [];
  for (const name of UI_FILES) {
    readFileSync(new URL(name, import.meta.url), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (MODEL_ID_IN_QUOTES.test(line)) hits.push(`${name}:${index + 1}: ${line.trim()}`);
        if (line.includes("dangerouslySetInnerHTML")) hits.push(`${name}:${index + 1}: raw HTML`);
      });
  }
  assert.deepEqual(hits, []);
});
