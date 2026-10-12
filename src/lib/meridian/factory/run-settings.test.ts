import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUN_SETTINGS,
  automationFromBrainLevel,
  automationFromFactoryLevel,
  automationFromStudioAutonomy,
  mergeRunSettings,
  parseRunSettings,
} from "./run-settings.ts";

test("run settings accept a partial override and lay it over the defaults", () => {
  const parsed = parseRunSettings({ automation: "semi", formats: ["video", "image", "video"], platforms: ["instagram", "tiktok"] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.automation, "semi");
  assert.deepEqual(parsed.value.formats, ["video", "image"], "duplicate formats are collapsed");
  assert.deepEqual(parsed.value.platforms, ["instagram", "tiktok"]);
  assert.equal(parsed.value.intent, DEFAULT_RUN_SETTINGS.intent, "a key that is not given keeps its default");
});

test("run settings refuse an unknown value with the reason, and never coerce it", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ automation: "autonomous" }, /Automation must be one of manual, semi, full/],
    [{ intent: "viral" }, /Intent must be one of/],
    [{ formats: [] }, /at least one format/],
    [{ formats: ["audio"] }, /Formats must be/],
    [{ platforms: ["Instagram"] }, /platform id/],
    [{ providers: { video: "BAD ID" } }, /provider must be auto or a provider id/],
    [{ providers: { audio: "auto" } }, /can only be set for/],
    [{ caps: { dailyCents: -1 } }, /daily cap must be a whole number/],
    [{ caps: { totalCents: 1.5 } }, /total cap must be a whole number/],
    [{ caps: { maxVariants: 0 } }, /Max variants per run/],
  ];
  for (const [input, message] of cases) {
    const parsed = parseRunSettings(input);
    assert.equal(parsed.ok, false, `refused: ${JSON.stringify(input)}`);
    if (!parsed.ok) assert.match(parsed.error, message);
  }
});

test("run settings refuse something that is not an object", () => {
  const parsed = parseRunSettings("full");
  assert.equal(parsed.ok, false);
});

test("the run's own override beats the brand default, which beats the built-in default", () => {
  const brand = { automation: "semi" as const, caps: { dailyCents: 500, totalCents: 5000, maxVariants: 8 } };
  const run = { automation: "full" as const, caps: { dailyCents: 0, totalCents: 1000, maxVariants: 8 } };
  const effective = mergeRunSettings(brand, run);
  assert.equal(effective.automation, "full");
  assert.equal(effective.caps.totalCents, 1000);
  assert.equal(effective.caps.dailyCents, 0, "the run's zero replaces the brand's daily cap, so the run has no daily cap");
  assert.equal(effective.intent, DEFAULT_RUN_SETTINGS.intent);
  assert.equal(mergeRunSettings(null, null).automation, "manual", "with no defaults at all, a run is manual");
});

test("old automation vocabularies map onto the one model", () => {
  assert.equal(automationFromFactoryLevel(0), "manual");
  assert.equal(automationFromFactoryLevel(1), "manual");
  assert.equal(automationFromFactoryLevel(2), "semi");
  assert.equal(automationFromFactoryLevel(3), "full");

  assert.equal(automationFromStudioAutonomy("manual"), "manual");
  assert.equal(automationFromStudioAutonomy("semi_automatic"), "semi");
  assert.equal(automationFromStudioAutonomy("fully_automatic"), "full");

  assert.equal(automationFromBrainLevel("manual"), "manual");
  assert.equal(automationFromBrainLevel("assisted"), "manual");
  assert.equal(automationFromBrainLevel("automated"), "semi");
  assert.equal(automationFromBrainLevel("autonomous"), "full");
});
