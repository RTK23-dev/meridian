import assert from "node:assert/strict";
import test from "node:test";
import { buildGuide, currentStep, GUIDE_STEPS, guideSummary, type GuideFacts } from "./guide.ts";

const readyEngine = { label: "TypeSafe JEV", chosen: true, ready: true, reason: "" };
const none = { perception: "not_configured", production: "not_configured", meta_graph: "not_configured", google_drive: "not_configured" } as const;

function facts(overrides: Partial<GuideFacts> = {}): GuideFacts {
  return { brandCount: 0, engine: { label: "TypeSafe JEV", chosen: false, ready: false, reason: "" }, providers: { ...none }, ...overrides };
}

function statusOf(steps: ReturnType<typeof buildGuide>, id: string) {
  return steps.find((step) => step.id === id)?.status;
}

test("an empty workspace starts at the first brand, and the engine waits behind it", () => {
  const steps = buildGuide(facts());
  assert.equal(statusOf(steps, "brand"), "current");
  assert.equal(statusOf(steps, "engine"), "todo");
  assert.equal(statusOf(steps, "sources"), "optional");
  assert.equal(currentStep(steps)?.id, "brand");
  assert.equal(guideSummary(steps).headline, "0 of 2 required steps are done. Next: create your first brand.");
});

test("after the brand exists, no engine chosen makes the engine the current step and says how to choose", () => {
  const steps = buildGuide(facts({ brandCount: 1 }));
  assert.equal(statusOf(steps, "brand"), "done");
  assert.equal(statusOf(steps, "engine"), "current");
  const engine = steps.find((step) => step.id === "engine");
  assert.match(engine?.detail ?? "", /No engine is chosen/);
  assert.match(engine?.detail ?? "", /OpenAI Decisions uses an OpenAI key/);
});

test("a chosen engine that cannot answer yet stays current and carries its reason", () => {
  const steps = buildGuide(facts({ brandCount: 2, engine: { label: "OpenAI Decisions", chosen: true, ready: false, reason: "No key is saved for this workspace." } }));
  const engine = steps.find((step) => step.id === "engine");
  assert.equal(engine?.status, "current");
  assert.equal(engine?.detail, "OpenAI Decisions is chosen, but it cannot answer yet. No key is saved for this workspace.");
});

test("a ready engine finishes the engine step, and the required steps then read as done", () => {
  const steps = buildGuide(facts({ brandCount: 1, engine: readyEngine }));
  assert.equal(statusOf(steps, "engine"), "done");
  const summary = guideSummary(steps);
  assert.equal(summary.requiredDone, summary.requiredTotal);
  assert.equal(summary.headline, "Every required step is done. The optional steps can wait.");
  assert.equal(currentStep(steps)?.id, "sources", "the next thing to do is the first optional step that is not done");
});

test("optional steps never block the required summary", () => {
  const steps = buildGuide(facts({ brandCount: 1, engine: readyEngine }));
  assert.equal(guideSummary(steps).requiredDone, 2);
  assert.ok(steps.filter((step) => !step.required).every((step) => step.status !== "todo"));
});

test("a keyed source in use completes the sources step; an unusable key does not", () => {
  const usable = buildGuide(facts({ brandCount: 1, engine: readyEngine, providers: { ...none, meta_ad_library: "usable" } }));
  assert.equal(statusOf(usable, "sources"), "done");
  assert.match(usable.find((step) => step.id === "sources")?.detail ?? "", /1 keyed source is in use/);

  const shared = buildGuide(facts({ brandCount: 1, engine: readyEngine, providers: { ...none, youtube: "deployment_shared_default" } }));
  assert.equal(statusOf(shared, "sources"), "done", "a key the deployment shares is in use");

  const unusable = buildGuide(facts({ brandCount: 1, engine: readyEngine, providers: { ...none, youtube: "unusable" } }));
  assert.equal(statusOf(unusable, "sources"), "current", "an unusable key is not in use, so the step is the next one to do");
});

test("media needs both the perception and the production keys", () => {
  const one = buildGuide(facts({ providers: { ...none, perception: "usable" } }));
  assert.equal(statusOf(one, "media"), "optional");
  const both = buildGuide(facts({ providers: { ...none, perception: "usable", production: "usable" } }));
  assert.equal(statusOf(both, "media"), "done");
});

test("publishing is optional, and a Meta or a TikTok paid-ad key each completes it", () => {
  const none_ = buildGuide(facts({ providers: { ...none } }));
  assert.equal(statusOf(none_, "publish"), "optional", "nothing published yet, and the step never blocks setup");
  assert.equal(statusOf(buildGuide(facts({ providers: { ...none, meta_graph: "usable" } })), "publish"), "done");
  assert.equal(statusOf(buildGuide(facts({ providers: { ...none, tiktok: "usable" } })), "publish"), "done");
});

test("storage reads the Drive state", () => {
  const steps = buildGuide(facts({ providers: { ...none, google_drive: "deployment_shared_default" } }));
  assert.equal(statusOf(steps, "storage"), "done");
});

test("when the facts did not load, the affected steps are unknown and never current", () => {
  const steps = buildGuide(facts({ brandCount: null, engine: null, providers: null }));
  assert.equal(statusOf(steps, "brand"), "unknown");
  assert.equal(statusOf(steps, "engine"), "unknown");
  assert.equal(statusOf(steps, "sources"), "unknown");
  assert.equal(currentStep(steps), null);
  assert.match(guideSummary(steps).headline, /could not be checked/);
});

test("the provider facts alone can be unknown while the brand is known", () => {
  const steps = buildGuide(facts({ brandCount: 1, engine: readyEngine, providers: null }));
  assert.equal(statusOf(steps, "brand"), "done");
  assert.equal(statusOf(steps, "sources"), "unknown");
  assert.equal(currentStep(steps), null, "an unknown step is not offered as the next one");
});

test("at most one step is current, and every step explains what it is and why", () => {
  for (const sample of [facts(), facts({ brandCount: 1 }), facts({ brandCount: 1, engine: readyEngine })]) {
    const steps = buildGuide(sample);
    assert.ok(steps.filter((step) => step.status === "current").length <= 1);
  }
  for (const definition of GUIDE_STEPS) {
    assert.ok(definition.title.length > 0, `${definition.id} has a title`);
    assert.ok(definition.what.length > 40, `${definition.id} says what it is`);
    assert.ok(definition.why.length > 20, `${definition.id} says why it matters`);
  }
});
