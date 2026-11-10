// The five code-drawn style cookbooks: each is valid, listed as a built-in, free in agent mode with its defaults and with the person's own
// voice or music, and names a style kit that exists. Their controls set the scene spec's choices.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODED_STYLE_KITS } from "../../../../engine/compose/styles/kits.ts";
import { pixelExplainer } from "../../../../engine/presets/pixel-explainer.ts";
import { resolveCookbook, type ResolvedCookbook } from "../resolve.ts";
import { validateCookbook } from "../validate.ts";
import { builtinCookbooks, isBuiltinId } from "./index.ts";
import { CODED_STYLE_COOKBOOKS, lineDiagramCookbook, paperCutStoryCookbook, stackedDataChartCookbook } from "./coded-styles.ts";

function resolved(cookbook: (typeof CODED_STYLE_COOKBOOKS)[number], values: Record<string, string | number | boolean> = {}): ResolvedCookbook {
  const result = resolveCookbook(cookbook, { values, lengthMs: 20000 });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

test("all five are valid built-ins with their own ids", () => {
  assert.equal(CODED_STYLE_COOKBOOKS.length, 5);
  assert.equal(new Set(CODED_STYLE_COOKBOOKS.map((cookbook) => cookbook.cookbookId)).size, 5);
  for (const cookbook of CODED_STYLE_COOKBOOKS) {
    const checked = validateCookbook(cookbook);
    assert.equal(checked.ok, true, checked.ok ? "" : `${cookbook.cookbookId}: ${checked.issues.join("; ")}`);
    assert.equal(isBuiltinId(cookbook.cookbookId), true);
    assert.ok(builtinCookbooks().some((candidate) => candidate.cookbookId === cookbook.cookbookId));
  }
});

test("each is free in agent mode by default, and stays free with the person's own voice and music", () => {
  for (const cookbook of CODED_STYLE_COOKBOOKS) {
    const free = resolved(cookbook);
    assert.deepEqual(free.modes, ["agent"], cookbook.cookbookId);
    assert.equal(free.badge, "Free in agent mode", cookbook.cookbookId);
    assert.match(free.agentBrief, /no paid provider call/);
    const own = resolved(cookbook, { voice_way: "upload", music_way: "upload" });
    assert.deepEqual(own.modes, ["agent"], cookbook.cookbookId);
    assert.equal(own.steps.find((step) => step.id === "voice_over")?.enabled, true);
    assert.equal(own.steps.find((step) => step.id === "music_mix")?.enabled, true);
  }
});

test("each names a style kit that exists, and checks loudness and the loop", () => {
  const kits = new Set([...Object.values(CODED_STYLE_KITS).map((kit) => kit.styleKitId), pixelExplainer.styleKit.styleKitId]);
  for (const cookbook of CODED_STYLE_COOKBOOKS) {
    assert.ok(cookbook.style && kits.has(cookbook.style.styleKitId), cookbook.cookbookId);
    const measures = cookbook.checks.map((check) => check.measure);
    assert.ok(measures.includes("integratedLufs") && measures.includes("loopDistance") && measures.includes("durationMs"), cookbook.cookbookId);
  }
});

test("the controls set the scene spec's choices and the length", () => {
  const paper = resolved(paperCutStoryCookbook, { scene: "city", time: "dusk", length: "20" });
  const scene = paper.steps.find((step) => step.id === "scene");
  assert.equal(scene?.params.scene, "city");
  assert.equal(scene?.params.time, "dusk");
  assert.equal(scene?.params.length_ms, 20000);
  assert.equal(resolved(lineDiagramCookbook, { layout: "flow" }).steps.find((step) => step.id === "scene")?.params.layout, "flow");
  assert.equal(resolved(stackedDataChartCookbook, { token: "cash" }).steps.find((step) => step.id === "scene")?.params.token, "cash");
});

test("the stacked chart's instructions keep figures honest: the brief's own, sourced or marked illustrative, every stack counted", () => {
  const text = stackedDataChartCookbook.instructions.map((instruction) => instruction.text).join(" ");
  assert.match(text, /ILLUSTRATIVE DATA/);
  assert.match(text, /every stack is counted/);
});
