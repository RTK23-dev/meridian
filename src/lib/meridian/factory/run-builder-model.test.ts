import assert from "node:assert/strict";
import test from "node:test";
import { budgets } from "../../../engine/config/budgets.ts";
import { DEFAULT_RUN_SETTINGS, MASTER_COST_FLOOR_TEXT, MASTER_COST_FLOOR_USD, parseRunSettings } from "./run-settings.ts";
import {
  checkedDefaults,
  checkedSettings,
  costPerMasterFromText,
  draftFromDefaults,
  draftProblems,
  settingsFromDraft,
  type BuilderDraft,
} from "./run-builder-model.ts";

const READY: BuilderDraft = {
  ...draftFromDefaults(DEFAULT_RUN_SETTINGS),
  niche: "skincare",
  formats: ["image"],
  platforms: ["instagram", "tiktok"],
};

test("a draft with a niche and a format can start, and its settings pass the server's own checks", () => {
  assert.deepEqual(draftProblems(READY), []);
  const checked = checkedSettings(READY);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(checked.settings.automation, "manual");
  assert.deepEqual(checked.settings.platforms, ["instagram", "tiktok"]);
  assert.deepEqual(parseRunSettings(checked.settings).ok, true);
});

test("a run with no niche, or no format, says why it cannot start", () => {
  const problems = draftProblems({ ...READY, niche: "   ", formats: [] });
  assert.ok(problems.some((item) => /Type a niche/.test(item)));
  assert.ok(problems.some((item) => /at least one format/.test(item)));
  assert.equal(checkedSettings({ ...READY, niche: "" }).ok, false);
});

test("full automation with no total cap is refused with the reason, and a cap above zero lets it start", () => {
  const unbounded = draftProblems({ ...READY, automation: "full", totalDollars: "" });
  assert.ok(unbounded.some((item) => /Full automation needs a total spend cap/.test(item)));
  const zeroCap = draftProblems({ ...READY, automation: "full", totalDollars: "0" });
  assert.equal(zeroCap.filter((item) => /Full automation/.test(item)).length, 1, "a zero cap is no cap");
  assert.deepEqual(draftProblems({ ...READY, automation: "full", totalDollars: "25.50" }), []);
});

test("caps are typed in dollars and stored as whole cents, and a blank cap is zero", () => {
  const settings = settingsFromDraft({ ...READY, dailyDollars: "3.5", totalDollars: "", maxVariants: "6" });
  assert.equal(settings.caps.dailyCents, 350);
  assert.equal(settings.caps.totalCents, 0);
  assert.equal(settings.caps.maxVariants, 6);
});

test("a negative or non-numeric cap and an out-of-range variant limit are refused", () => {
  assert.ok(draftProblems({ ...READY, dailyDollars: "-1" }).some((item) => /daily cap/.test(item)));
  assert.ok(draftProblems({ ...READY, totalDollars: "abc" }).some((item) => /total cap/.test(item)));
  assert.ok(draftProblems({ ...READY, maxVariants: "0" }).some((item) => /Max variants/.test(item)));
  assert.ok(draftProblems({ ...READY, maxVariants: "41" }).some((item) => /Max variants/.test(item)));
});

test("a blank provider is auto, and a provider id that is not an id is refused", () => {
  const settings = settingsFromDraft({ ...READY, formats: ["image", "video"], providers: { image: "  ", video: "higgsfield" } });
  assert.equal(settings.providers.image, "auto");
  assert.equal(settings.providers.video, "higgsfield");
  assert.ok(draftProblems({ ...READY, providers: { image: "Not An Id!" } }).some((item) => /image provider/.test(item)));
});

test("a format the run does not make has no provider entry", () => {
  const settings = settingsFromDraft({ ...READY, formats: ["image"], providers: { image: "auto", video: "higgsfield" } });
  assert.deepEqual(Object.keys(settings.providers), ["image"]);
});

test("the draft starts from the brand's defaults, so a run inherits what the brand set", () => {
  const draft = draftFromDefaults({ ...DEFAULT_RUN_SETTINGS, automation: "semi", intent: "ad", platforms: ["youtube"], caps: { dailyCents: 500, totalCents: 0, maxVariants: 12 } });
  assert.equal(draft.automation, "semi");
  assert.equal(draft.intent, "ad");
  assert.deepEqual(draft.platforms, ["youtube"]);
  assert.equal(draft.dailyDollars, "5");
  assert.equal(draft.totalDollars, "");
  assert.equal(draft.maxVariants, "12");
});

const FLOOR_BLOCK = "Every master costs at least $0.52: the fixed Claude, critic, render and media cost.";
const VIDEO: BuilderDraft = { ...READY, formats: ["video"], costPerMasterDollars: "0.75" };

test("the floor is the sum of the engine's four fixed per-master lines, not a copied number", () => {
  const cents = Object.values(budgets.fixedPerMasterUsd).reduce((sum, usd) => sum + Math.round(usd * 100), 0);
  assert.equal(Math.round(MASTER_COST_FLOOR_USD * 100), cents);
  assert.equal(MASTER_COST_FLOOR_TEXT, "0.52");
});

test("a cost per master is validated for null, below the floor, at the floor, too many decimals and non-numbers", () => {
  assert.deepEqual(costPerMasterFromText(""), { ok: true, value: null }, "blank is not set");
  assert.deepEqual(costPerMasterFromText("   "), { ok: true, value: null }, "spaces are blank");
  assert.deepEqual(costPerMasterFromText("0.52"), { ok: true, value: 0.52 }, "at the floor is allowed");
  assert.deepEqual(costPerMasterFromText("0.75"), { ok: true, value: 0.75 });
  assert.deepEqual(costPerMasterFromText("12"), { ok: true, value: 12 });
  assert.deepEqual(costPerMasterFromText(".8"), { ok: true, value: 0.8 });

  const below = costPerMasterFromText("0.51");
  assert.equal(below.ok, false);
  if (!below.ok) assert.equal(below.error, `The cost per master is below the floor. ${FLOOR_BLOCK}`);
  assert.equal(costPerMasterFromText("0").ok, false, "zero is below the floor");
  assert.equal(costPerMasterFromText("0.5").ok, false, "0.50 is below the floor");

  const decimals = costPerMasterFromText("0.755");
  assert.equal(decimals.ok, false);
  if (!decimals.ok) assert.match(decimals.error, /at most 2 decimals/);

  for (const text of ["abc", "-1", "1e3", "1,50", "$0.75"]) {
    const refused = costPerMasterFromText(text);
    assert.equal(refused.ok, false, `refused: ${text}`);
    if (!refused.ok) assert.match(refused.error, /must be a dollar amount, such as 0\.75/);
  }
});

test("a run that makes video cannot start without a cost per master, and the reason names the floor", () => {
  const blank = { ...VIDEO, costPerMasterDollars: "" };
  assert.deepEqual(draftProblems(blank), [`Type the cost per master (USD). ${FLOOR_BLOCK}`]);
  assert.equal(checkedSettings(blank).ok, false);
});

test("a run that makes video cannot start below the floor, and at the floor it can", () => {
  assert.deepEqual(draftProblems({ ...VIDEO, costPerMasterDollars: "0.51" }), [`The cost per master is below the floor. ${FLOOR_BLOCK}`]);
  assert.deepEqual(draftProblems({ ...VIDEO, costPerMasterDollars: "0.52" }), []);
  const checked = checkedSettings({ ...VIDEO, costPerMasterDollars: "0.52" });
  assert.equal(checked.ok, true);
  if (checked.ok) assert.equal(checked.settings.costPerMasterUsd, 0.52);
});

test("a mixed run that makes video needs the cost too, and an image-only run does not", () => {
  assert.deepEqual(draftProblems({ ...VIDEO, formats: ["image", "video"], costPerMasterDollars: "" }), [`Type the cost per master (USD). ${FLOOR_BLOCK}`]);
  assert.deepEqual(draftProblems({ ...READY, formats: ["image"], costPerMasterDollars: "" }), [], "an image-only run starts with no cost");
  assert.deepEqual(draftProblems({ ...READY, formats: ["carousel"], costPerMasterDollars: "" }), []);
  const settings = settingsFromDraft({ ...READY, formats: ["image"], costPerMasterDollars: "" });
  assert.equal(settings.costPerMasterUsd, null, "a run with no cost stores null, never a number");
});

test("the cost per master is saved from the draft, and a blank one is null", () => {
  assert.equal(settingsFromDraft({ ...VIDEO, costPerMasterDollars: "0.75" }).costPerMasterUsd, 0.75);
  assert.equal(settingsFromDraft({ ...VIDEO, costPerMasterDollars: "" }).costPerMasterUsd, null);
});

test("the brand's defaults may leave the cost blank, so saving them does not need one, but a bad cost still blocks saving", () => {
  assert.equal(checkedDefaults({ ...VIDEO, costPerMasterDollars: "" }).ok, true, "defaults are saved without a run's cost");
  assert.equal(checkedDefaults({ ...VIDEO, costPerMasterDollars: "0.1" }).ok, false, "a cost below the floor is refused in defaults too");
});

test("the draft starts from the brand's saved cost, and is blank when none is saved", () => {
  assert.equal(draftFromDefaults({ ...DEFAULT_RUN_SETTINGS, costPerMasterUsd: 0.9 }).costPerMasterDollars, "0.9");
  assert.equal(draftFromDefaults(DEFAULT_RUN_SETTINGS).costPerMasterDollars, "", "no default value is typed into the input");
});
