// The Connections view: every light is the server's state, overlap names which provider is used, OpenRouter's reach is counted from the
// feature map, and Google's one key covers both of its vault entries.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderCategory, ProviderConfigSummary } from "../../lib/meridian/settings/provider-config.ts";
import { connectionsView, FEATURES, PROVIDERS, type EngineStatus } from "./connections-model.ts";

const usable = (category: ProviderCategory, source: "workspace" | "deployment" = "workspace"): ProviderConfigSummary => ({
  category,
  configured: true,
  source,
  credentialState: "usable",
  keyFingerprint: "...ab12",
  settings: {},
  capabilities: [],
});
const engines = (engineId: string, ready = true): EngineStatus => ({
  active: { engineId },
  engines: [{ id: engineId, health: { status: ready ? "READY" : "NOT_CONFIGURED" } }],
});
const feature = (view: ReturnType<typeof connectionsView>, id: string) => view.features.find((row) => row.id === id)!;
const provider = (view: ReturnType<typeof connectionsView>, id: string) => view.providers.find((row) => row.id === id)!;

describe("connections view", () => {
  it("with nothing set, every required feature needs a key and the optional ones say so; storage falls back to the server's disk", () => {
    const view = connectionsView({ summaries: {}, engines: engines("openrouter-decisions", false) });
    for (const row of view.features) {
      if (row.id === "storage") assert.equal(row.light, "working");
      else assert.equal(row.light, row.optional ? "optional" : "missing", row.id);
    }
    assert.equal(feature(view, "writing").line, "Needs OpenRouter");
    assert.equal(feature(view, "decisions").line, "OpenRouter is chosen but has no key");
  });

  it("one OpenRouter key readies writing, image understanding and the video engine's models, and the OpenRouter decision engine", () => {
    const view = connectionsView({ summaries: { openrouter: usable("openrouter") }, engines: engines("openrouter-decisions") });
    for (const id of ["writing", "research_analysis", "brand_brain", "image_understanding", "decisions", "video_direction", "video_images", "video_clips", "voice"]) {
      assert.equal(feature(view, id).light, "working", id);
      assert.equal(feature(view, id).usedProvider, "openrouter", id);
    }
    assert.equal(feature(view, "studio_images").light, "missing");
    assert.deepEqual(view.openRouterUnlocks, {
      count: 10,
      of: FEATURES.length,
      missing: ["Speech to text", "Studio images", "Studio video", "Competitor ad research"],
    });
    assert.equal(provider(view, "openrouter").status, "ready");
    assert.ok(provider(view, "openrouter").usedFor.includes("Decisions and scoring"));
  });

  it("shows overlap when two keys could answer decisions, names the one used, and marks the other key as not used", () => {
    const view = connectionsView({ summaries: { openrouter: usable("openrouter"), jev: usable("jev") }, engines: engines("jev") });
    const decisions = feature(view, "decisions");
    assert.equal(decisions.light, "overlap");
    assert.equal(decisions.usedProvider, "typesafe");
    assert.deepEqual(decisions.alsoUsable, ["openrouter"]);
    assert.equal(decisions.line, "TypeSafe JEV (also set: OpenRouter)");
    assert.equal(provider(view, "typesafe").unused, false);
    assert.equal(provider(view, "openrouter").unused, false, "OpenRouter still serves writing");
  });

  it("marks an Anthropic key as not used, because every route reaches Claude through OpenRouter", () => {
    const view = connectionsView({ summaries: { openrouter: usable("openrouter"), anthropic: usable("anthropic") }, engines: engines("openrouter-decisions") });
    assert.equal(provider(view, "anthropic").unused, true);
    assert.deepEqual(provider(view, "anthropic").usedFor, []);
  });

  it("treats Google as one key: both entries ready, one of the two is partly set, an unusable entry is red", () => {
    const both = connectionsView({ summaries: { perception: usable("perception"), production: usable("production") }, engines: null });
    assert.equal(provider(both, "google").status, "ready");
    assert.equal(feature(both, "studio_images").light, "working");
    const half = connectionsView({ summaries: { perception: usable("perception") }, engines: null });
    assert.equal(provider(half, "google").status, "partial");
    const broken = connectionsView({
      summaries: { perception: { ...usable("perception"), credentialState: "unusable", credentialReason: "The saved Gemini credential has expired." } },
      engines: null,
    });
    assert.equal(provider(broken, "google").status, "unusable");
    assert.equal(provider(broken, "google").reason, "The saved Gemini credential has expired.");
  });

  it("names a server-shared key as shared, never as the workspace's own, and offers no remove for it", () => {
    const view = connectionsView({ summaries: { openrouter: usable("openrouter", "deployment") }, engines: engines("openrouter-decisions") });
    assert.equal(provider(view, "openrouter").status, "shared");
    assert.equal(provider(view, "openrouter").removable, false);
  });

  it("lists every keyed provider category exactly once", () => {
    const categories = PROVIDERS.flatMap((row) => row.categories);
    assert.equal(new Set(categories).size, categories.length);
    for (const row of FEATURES) for (const id of row.candidates) assert.ok(PROVIDERS.some((p) => p.id === id), `${row.id} names ${id}`);
  });
  it("OpenRouter serves reference analysis only once a model is chosen for it, and then it comes before a Google key", () => {
    const keyOnly = connectionsView({ summaries: { openrouter: usable("openrouter") }, engines: null });
    assert.equal(feature(keyOnly, "perception").light, "missing");
    assert.equal(feature(keyOnly, "perception").line, "Choose a model under Models");
    const chosen = connectionsView({ summaries: { openrouter: usable("openrouter") }, engines: null, chosenTasks: new Set(["reference_analysis"]) });
    assert.equal(feature(chosen, "perception").light, "working");
    assert.equal(feature(chosen, "perception").usedProvider, "openrouter");
    const both = connectionsView({
      summaries: { openrouter: usable("openrouter"), perception: usable("perception"), production: usable("production") },
      engines: null,
      chosenTasks: new Set(["reference_analysis"]),
    });
    assert.equal(feature(both, "perception").usedProvider, "openrouter", "the explicit choice wins, as the runtime does");
    assert.equal(feature(both, "perception").light, "overlap");
    const googleOnly = connectionsView({ summaries: { openrouter: usable("openrouter"), perception: usable("perception"), production: usable("production") }, engines: null });
    assert.equal(feature(googleOnly, "perception").usedProvider, "google", "with no model chosen, the Google key reads references");
  });
});
