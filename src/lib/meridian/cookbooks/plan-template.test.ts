// The cookbook as the orchestrator's starting plan (K16): every built-in gives a valid skeleton in dependency order; an edit keeps its change and
// says so; an unknown step is refused; a plan is sent only with the right selection.

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbooks } from "./builtin/index.ts";
import { resolveCookbook } from "./resolve.ts";
import { applyNodeEdits, mayRequestPlan, planSkeletonOf } from "./plan-template.ts";
import type { SelectionRecord } from "./select.ts";

const ORCHESTRATOR = { provider: "openrouter" as const, id: "anthropic/claude-opus-5-5" };

function resolvedOf(cookbookId: string) {
  const cookbook = builtinCookbooks().find((candidate) => candidate.cookbookId === cookbookId);
  assert.ok(cookbook, cookbookId);
  const result = resolveCookbook(cookbook, { lengthMs: 30000 });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

test("every built-in cookbook gives a valid skeleton, in dependency order", () => {
  for (const cookbook of builtinCookbooks()) {
    const skeleton = planSkeletonOf(resolvedOf(cookbook.cookbookId), { orchestrator: ORCHESTRATOR, budgetUsd: 20 });
    assert.equal(skeleton.ok, true, `${cookbook.cookbookId}: ${skeleton.ok ? "" : skeleton.reasons.join("; ")}`);
    if (!skeleton.ok) continue;
    const seen = new Set<string>();
    for (const node of skeleton.plan.nodes) {
      for (const dependency of node.dependsOn) assert.ok(seen.has(dependency), `${node.id} comes after ${dependency}`);
      seen.add(node.id);
    }
    assert.equal(skeleton.plan.nodes.every((node) => node.model === null && node.estimateUsd === null), true, "a skeleton has no models or estimates yet");
  }
});

test("an edit keeps its change and says it was edited; an edit to a step that is not in the plan is refused", () => {
  const skeleton = planSkeletonOf(resolvedOf("ck_3d_data_explainer"), { orchestrator: ORCHESTRATOR, budgetUsd: 20 });
  assert.equal(skeleton.ok, true);
  if (!skeleton.ok) return;
  const edited = applyNodeEdits(skeleton.plan, { scenes: { title: "Aerial scenes", params: { pace: 1.3 } } });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  const scenes = edited.plan.nodes.find((node) => node.id === "scenes");
  assert.equal(scenes?.title, "Aerial scenes");
  assert.equal(scenes?.params.pace, 1.3);
  assert.match(scenes?.why ?? "", /\(edited\)$/);
  const unknown = applyNodeEdits(skeleton.plan, { nowhere: { title: "x" } });
  assert.equal(unknown.ok, false);
});

test("a plan is sent only with the right selection: a confirmed one in a normal run, the auto-accepted one in an automated loop", () => {
  const confirmed: SelectionRecord = { cookbookId: "ck_3d_data_explainer", version: 2, values: {}, valuesHash: "sha256:a", how: "confirmed", proposedCookbookId: "ck_3d_data_explainer" };
  const auto: SelectionRecord = { ...confirmed, how: "auto_accepted" };
  assert.equal(mayRequestPlan(null, "normal").ok, false, "no choice, no plan");
  assert.equal(mayRequestPlan(confirmed, "normal").ok, true);
  assert.equal(mayRequestPlan(auto, "normal").ok, false, "a normal run waits for the person");
  assert.equal(mayRequestPlan(auto, "automated_loop").ok, true);
  assert.equal(mayRequestPlan(confirmed, "automated_loop").ok, false);
});
