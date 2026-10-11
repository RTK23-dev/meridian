import assert from "node:assert/strict";
import test from "node:test";
import { guideFacts } from "./facts.ts";
import { buildGuide } from "./guide.ts";

// Only the fields the model reads: a summary with a state and a source, and an engine status.
function summary(credentialState: "usable" | "unusable" | "not_configured", source: "workspace" | "deployment" | "none" = "none") {
  return {
    configured: credentialState === "usable",
    credentialState,
    credentialReason: credentialState === "unusable" ? "The saved key cannot be decrypted." : null,
    source,
    keyFingerprint: credentialState === "usable" ? "...abcd" : null,
    settings: { baseUrlConfigured: true },
  } as never;
}

function summaries(overrides: Record<string, unknown> = {}) {
  const base = {
    jev: summary("not_configured"),
    openai: summary("not_configured"),
    perception: summary("not_configured"),
    production: summary("not_configured"),
    hypit: summary("not_configured"),
    meta_ad_library: summary("not_configured"),
    meta_graph: summary("not_configured"),
    instagram: summary("not_configured"),
    youtube: summary("not_configured"),
    search: summary("not_configured"),
    twitter: summary("not_configured"),
    linkedin: summary("not_configured"),
    pinterest: summary("not_configured"),
    tiktok: summary("not_configured"),
    licensed: summary("not_configured"),
    storage: { configured: false, settings: {} },
    ...overrides,
  };
  return base as never;
}

const engines = (source: "workspace" | "deployment" | "default", health: string) => ({
  active: { engineId: "jev", source },
  engines: [
    { id: "jev", label: "TypeSafe JEV", health: { status: health, message: health === "READY" ? undefined : "No key is saved." } },
    { id: "openai-decisions", label: "OpenAI Decisions", health: { status: "NOT_CONFIGURED", message: "No key." } },
  ],
}) as never;

test("the default engine is not a choice, so the guide asks for one", () => {
  const facts = guideFacts({ brandCount: 1, summaries: summaries(), engines: engines("default", "READY") });
  assert.equal(facts.engine?.chosen, false);
  assert.equal(buildGuide(facts).find((step) => step.id === "engine")?.status, "current");
});

test("a chosen and ready engine completes the engine step", () => {
  const facts = guideFacts({ brandCount: 1, summaries: summaries(), engines: engines("workspace", "READY") });
  assert.equal(facts.engine?.ready, true);
  assert.equal(buildGuide(facts).find((step) => step.id === "engine")?.status, "done");
});

test("a saved workspace key marks its row in use, and an unusable key does not", () => {
  const facts = guideFacts({
    brandCount: 1,
    summaries: summaries({ meta_ad_library: summary("usable", "workspace"), youtube: summary("unusable") }),
    engines: engines("workspace", "READY"),
  });
  assert.equal(facts.providers?.meta_ad_library, "usable");
  assert.equal(facts.providers?.youtube, "unusable");
  assert.equal(buildGuide(facts).find((step) => step.id === "sources")?.status, "done");
});

test("providers that have not loaded leave the provider steps unknown", () => {
  const facts = guideFacts({ brandCount: 1, summaries: null, engines: engines("workspace", "READY") });
  assert.equal(facts.providers, null);
  assert.equal(buildGuide(facts).find((step) => step.id === "sources")?.status, "unknown");
});

test("an unloaded engine status leaves the engine step unknown", () => {
  const facts = guideFacts({ brandCount: 1, summaries: summaries(), engines: null });
  assert.equal(facts.engine, null);
  assert.equal(buildGuide(facts).find((step) => step.id === "engine")?.status, "unknown");
});
