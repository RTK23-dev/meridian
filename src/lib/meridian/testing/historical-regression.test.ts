import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterJevClient } from "../jev/client.ts";
import { recordTelemetry } from "../learning/telemetry-engine.ts";
import { extractOrganicMetrics } from "../organic/learning-bridge.ts";
import { VeoProvider } from "../production/providers/veo.ts";
import { HiggsfieldProvider } from "../production/providers/higgsfield.ts";
import { accountProviderState } from "../providers/boundaries.ts";
import { createEvidenceBundle } from "../evidence/bundle.ts";
import { asEvidenceValue } from "../evidence/types.ts";

// 1. Never manufacture evidence: views stays undefined when not observed, never 5000
test("Regression: missing metrics stay undefined and never default to 5000 or fake constants", () => {
  const scraped = {
    likes: 42,
    comments: 5,
    // views not present
  };

  const metrics = extractOrganicMetrics(scraped);
  assert.equal(metrics.views, null);
  assert.equal(metrics.threeSecondViews, null);
  assert.equal(metrics.completionRate, null);
  assert.notEqual(metrics.views, 5000);
});

// 2. Never fabricate completionRate (0.25) or 3s views (0.45 * views)
test("Regression: bridge does not calculate threeSecondViews as 0.45 * views or completionRate as 0.25", () => {
  const metrics = extractOrganicMetrics({ views: 10000, likes: 200 });
  assert.equal(metrics.views, 10000);
  assert.equal(metrics.threeSecondViews, null);
  assert.equal(metrics.completionRate, null);
  assert.notEqual(metrics.threeSecondViews, 4500);
  assert.notEqual(metrics.completionRate, 0.25);
});

// 3. JEV noul never invents confidence = 0.85
test("Regression: JEV client normalizes noul directly without fabricated confidence", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        model: "typesafe/jev-1.13",
        answers: {
          q_test: {
            type: "noul",
            noul: 0.88,
          },
        },
      }),
      { status: 200 },
    );

  const client = new OpenRouterJevClient({
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  });

  const res = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: { description: "User speaking naturally", availableEvidence: [] },
    questions: {
      q_test: {
        id: "q_test",
        version: "1.0.0",
        type: "noul",
        instructions: "Is this authentic?",
        criteria: { true: "authentic", false: "staged" },
        evidenceRequirements: [],
      },
    },
  });

  const answer = res.answers["q_test"]!;
  assert.equal(answer.type, "noul");
  assert.equal(answer.noul, 0.88);
  assert.equal(answer.confidence, undefined);
  assert.notEqual(answer.confidence, 0.85);
});

// 4. Simulated telemetry must be rejected by production learning
test("Regression: production telemetry engine rejects synthetic/simulated telemetry", async () => {
  const fakeSql = (() => {}) as any;

  await assert.rejects(
    async () => {
      await recordTelemetry(fakeSql, {
        organizationId: "org-1",
        brandId: "brand-1",
        creativeId: "creative-1",
        platform: "instagram",
        accountId: "ig-1",
        views: 1000,
        metadata: { synthetic: true },
      });
    },
    /Synthetic or simulated telemetry/,
  );

  await assert.rejects(
    async () => {
      await recordTelemetry(fakeSql, {
        organizationId: "org-1",
        brandId: "brand-1",
        creativeId: "creative-1",
        platform: "instagram",
        accountId: "ig-1",
        views: 1000,
        metadata: { simulated: true },
      });
    },
    /Synthetic or simulated telemetry/,
  );
});

// 5. Channel readiness reports NOT_CONNECTED without credentials (no '|| true' fake connection)
test("Regression: account provider state is NOT_CONNECTED when credentials are absent", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};
  const metaState = accountProviderState("meta", emptyEnv);
  assert.equal(metaState.status, "NOT_CONNECTED");

  const tiktokState = accountProviderState("tiktok", emptyEnv);
  assert.equal(tiktokState.status, "NOT_CONNECTED");

  const googleState = accountProviderState("google", emptyEnv);
  assert.equal(googleState.status, "NOT_CONNECTED");
});

// 6. Unconfigured providers return NOT_CONFIGURED and no job id
test("Regression: unconfigured production providers return NOT_CONFIGURED without job id", async () => {
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalGoogle = process.env.GOOGLE_API_KEY;
  const originalHf = process.env.HIGGSFIELD_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.HIGGSFIELD_API_KEY;

  try {
    const veo = new VeoProvider();
    const veoJob = await veo.submitJob({
      id: "spec-1",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Spec",
      format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    });
    assert.equal(veoJob.status, "NOT_CONFIGURED");
    assert.equal(veoJob.jobId, "");

    const hf = new HiggsfieldProvider();
    const hfJob = await hf.submitJob({
      id: "spec-2",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Spec",
      format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    });
    assert.equal(hfJob.status, "NOT_CONFIGURED");
    assert.equal(hfJob.jobId, "");
  } finally {
    if (originalGemini) process.env.GEMINI_API_KEY = originalGemini;
    if (originalGoogle) process.env.GOOGLE_API_KEY = originalGoogle;
    if (originalHf) process.env.HIGGSFIELD_API_KEY = originalHf;
  }
});

// 7. JEV client fails closed without falling back to chat completions
test("Regression: JEV client fails closed on remote API error and does NOT fallback to chat completions", async () => {
  let calledUrl = "";
  const failingFetch: typeof fetch = async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ error: "Internal JEV Error" }), { status: 500 });
  };

  const client = new OpenRouterJevClient({
    apiKey: "test-key",
    fetchImpl: failingFetch,
  });

  const res = await client.decide({
    organizationId: "org-1",
    brandId: "brand-1",
    state: { description: "Some state", availableEvidence: [] },
    questions: {
      q_test: {
        id: "q_test",
        version: "1.0.0",
        type: "noul",
        instructions: "Is this real?",
        criteria: { true: "real", false: "fake" },
        evidenceRequirements: [],
      },
    },
  });

  const answer = res.answers["q_test"]!;
  assert.equal(answer.status, "abstain_uncertain");
  assert.ok(answer.abstainReason?.includes("500"));
  assert.ok(calledUrl.includes("/decisions"));
  assert.ok(!calledUrl.includes("/chat/completions"));
});

// 8. Epistemic states are preserved in EvidenceBundle
test("Regression: EvidenceValue preserves epistemic state and uncertainty", () => {
  const bundle = createEvidenceBundle({
    organizationId: "org-1",
    brandId: "brand-1",
    source: {
      platform: "instagram",
      externalId: "post-1",
      sourceAdapter: "instagram_graph",
      capturedAt: new Date().toISOString(),
    },
    content: {
      type: "video",
    },
    performance: {
      views: asEvidenceValue(15000, "OBSERVED"),
      likes: asEvidenceValue(1200, "OBSERVED"),
      shares: asEvidenceValue(350, "INFERRED", { lower: 200, upper: 500 }),
    },
    provenance: {
      adapterId: "instagram_graph",
      capturedAt: new Date().toISOString(),
    },
  });

  const viewsEvidence = bundle.performance?.views;
  assert.ok(typeof viewsEvidence === "object" && viewsEvidence !== null);
  assert.equal(viewsEvidence.state, "OBSERVED");
  assert.equal(viewsEvidence.value, 15000);

  const sharesEvidence = bundle.performance?.shares;
  assert.ok(typeof sharesEvidence === "object" && sharesEvidence !== null);
  assert.equal(sharesEvidence.state, "INFERRED");
  assert.equal(sharesEvidence.uncertainty?.lower, 200);
});
