import assert from "node:assert/strict";
import { test } from "node:test";
import { openRouterProgress } from "./engine-progress.ts";

const base = { keySaved: false, testPassed: false, active: false, activeLabel: "TypeSafe JEV" };

test("a saved key is not a passed test and not an active engine", () => {
  const progress = openRouterProgress({ ...base, keySaved: true });
  assert.deepEqual(progress.steps.map((step) => step.done), [true, false, false]);
  assert.match(progress.next, /Test the connection/);
  assert.match(progress.next, /does not switch the engine/);
});

test("a passed test still names which engine is receiving decisions", () => {
  const progress = openRouterProgress({ ...base, keySaved: true, testPassed: true });
  assert.match(progress.next, /TypeSafe JEV receives every decision/);
});

test("only an active, tested, saved engine reads as finished", () => {
  const progress = openRouterProgress({ keySaved: true, testPassed: true, active: true, activeLabel: "OpenRouter Decisions" });
  assert.ok(progress.steps.every((step) => step.done));
  assert.match(progress.next, /Nothing more/);
});

test("no key says to save one first", () => {
  assert.match(openRouterProgress(base).next, /Save your OpenRouter key/);
});
