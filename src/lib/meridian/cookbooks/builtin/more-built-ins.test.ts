// The UGC product cookbook (K26) and the voice-led list (K27): both validate; their choices change what they need and whether they run free.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isBuiltinId, builtinCookbooks } from "./index.ts";
import { ugcProductCookbook, voiceListicleCookbook } from "./more-built-ins.ts";
import { resolveCookbook, type ResolvedCookbook } from "../resolve.ts";
import { validateCookbook } from "../validate.ts";

function resolved(cookbook: typeof ugcProductCookbook, values: Record<string, string | boolean> = {}): ResolvedCookbook {
  const result = resolveCookbook(cookbook, { values, lengthMs: 30000 });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

test("both cookbooks are valid, and both are built-ins the library lists", () => {
  for (const cookbook of [ugcProductCookbook, voiceListicleCookbook]) {
    const checked = validateCookbook(cookbook);
    assert.equal(checked.ok, true, checked.ok ? "" : checked.issues.join("; "));
    assert.equal(isBuiltinId(cookbook.cookbookId), true);
    assert.ok(builtinCookbooks().some((candidate) => candidate.cookbookId === cookbook.cookbookId));
  }
});

test("the UGC cookbook runs free with the person's footage and product kit; an AI presenter or product shots turn that off", () => {
  const free = resolved(ugcProductCookbook);
  assert.deepEqual(free.modes, ["agent", "engine"]);
  assert.equal(free.steps.find((step) => step.id === "presenter_shot")?.enabled, false);
  assert.equal(free.steps.find((step) => step.id === "footage_cut")?.enabled, true);
  const avatar = resolved(ugcProductCookbook, { presenter_way: "avatar" });
  assert.deepEqual(avatar.modes, ["engine"]);
  assert.equal(avatar.steps.find((step) => step.id === "presenter_shot")?.enabled, true);
  const shots = resolved(ugcProductCookbook, { product_shots: true });
  assert.deepEqual(shots.modes, ["engine"]);
  assert.equal(shots.steps.find((step) => step.id === "product_shots")?.enabled, true);
});

test("the UGC hook is a set parameter of the script step", () => {
  assert.equal(resolved(ugcProductCookbook, { hook_type: "question" }).steps.find((step) => step.id === "script")?.params.hook_type, "question");
});

test("the voice-led list runs free with the person's recording; an AI voice is priced per character, so its cost is unknown", () => {
  const recorded = resolved(voiceListicleCookbook);
  assert.deepEqual(recorded.modes, ["agent", "engine"]);
  const ai = resolved(voiceListicleCookbook, { voice_way: "tts" });
  assert.deepEqual(ai.modes, ["engine"]);
  assert.equal(ai.badge, "Price unknown");
});

test("stock clips are a paid visual, and turn agent mode off", () => {
  const stock = resolved(voiceListicleCookbook, { clips_way: "stock" });
  assert.deepEqual(stock.modes, ["engine"]);
  assert.equal(stock.steps.find((step) => step.id === "stock_clips")?.enabled, true);
});
