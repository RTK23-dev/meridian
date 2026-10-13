import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RUN_SETTINGS, parseRunSettings } from "./run-settings.ts";
import { checkedSettings, draftFromDefaults, draftProblems, settingsFromDraft, type BuilderDraft } from "./run-builder-model.ts";

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
