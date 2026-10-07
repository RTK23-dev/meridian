import assert from "node:assert/strict";
import test from "node:test";
import { createFlow } from "./connector.ts";
import {
  createGradingNode,
  createPlannerNode,
  createGateNode,
  createPublishNode,
} from "./nodes.ts";
import { winnerScoreGradingEngine, heuristicGradingEngine } from "../grading/engine.ts";
import { matrixPlannerEngine } from "../planner/engine.ts";
import { testPublishEngine } from "../publishing/engine.ts";

test("Flow Connectors: n8n-style modular pipeline chains nodes smoothly", async () => {
  const flow = createFlow("factory-campaign-pipeline");

  // Step 1: Grading node
  flow.pipe(createGradingNode(winnerScoreGradingEngine(), "grade-winner"));

  const report = await flow.run(
    {
      evidence: {
        daysRunning: 45,
        stillRunning: true,
        iterationCount: 8,
        countries: 4,
        platforms: 2,
        advertiserSurvivorRate: 0.7,
        creativeQuality: 0.8,
      },
    },
    {
      organizationId: "org-test",
      brandId: "brand-test",
      correlationId: "corr-1",
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].nodeId, "grade-winner");
  assert.ok((report.finalOutput as any).overallScore > 0.6);
});

test("Flow Connectors: swappable engines allow swapping grading engine without changing pipeline structure", async () => {
  // Test with heuristic grading engine instead of winnerScore
  const flow = createFlow("heuristic-pipeline");
  flow.pipe(createGradingNode(heuristicGradingEngine(), "grade-heuristic"));

  const report = await flow.run(
    {
      scores: {
        brandFit: 0.9,
        historicalEvidence: 0.8,
        marketSignal: 0.7,
        novelty: 0.6,
        reproducibility: 0.8,
        saturation: 0.1,
        risk: 0.1,
      },
    },
    {
      organizationId: "org-test",
      brandId: "brand-test",
      correlationId: "corr-2",
    },
  );

  assert.equal(report.ok, true);
  assert.equal((report.finalOutput as any).engineId, "heuristic");
  assert.ok((report.finalOutput as any).overallScore >= 0.55);
});

test("Flow Connectors: multi-step flow (Planner -> Gate -> Publisher) executes or stops at gate", async () => {
  const flow = createFlow("plan-gate-publish");

  // 1. Planner node generates variants
  flow.pipe(createPlannerNode(matrixPlannerEngine(), "planner"));

  const planReport = await flow.run(
    {
      hooks: ["Hook 1", "Hook 2"],
      problems: ["Problem 1"],
      visuals: ["Visual 1"],
      offers: ["Offer 1"],
      ctas: ["CTA 1"],
      maxVariants: 2,
    },
    {
      organizationId: "org-test",
      brandId: "brand-test",
      correlationId: "corr-3",
    },
  );

  assert.equal(planReport.ok, true);
  assert.equal((planReport.finalOutput as any).variants.length, 2);

  // 2. Gate blocks close copies
  const gateFlow = createFlow("gate-flow");
  gateFlow.pipe(createGateNode({ maxHammingDistance: 8 }));

  const gateReport = await gateFlow.run(
    {
      // Missing frames routes to review / not pass
      variantFrames: [],
      sourceFrames: [],
    },
    {
      organizationId: "org-test",
      brandId: "brand-test",
      correlationId: "corr-4",
    },
  );

  assert.equal(gateReport.ok, false);
  assert.match(gateReport.error!, /Originality gate/);

  // 3. Publishing node with test publisher
  const pubFlow = createFlow("pub-flow");
  pubFlow.pipe(createPublishNode(testPublishEngine()));

  const pubReport = await pubFlow.run(
    {
      name: "Autumn Campaign",
      dailyBudgetCents: 5000,
      countries: ["US"],
      pageId: "page-1",
      link: "https://brand.test",
      message: "Check this out",
    },
    {
      organizationId: "org-test",
      brandId: "brand-test",
      correlationId: "corr-5",
    },
  );

  assert.equal(pubReport.ok, true);
  assert.equal((pubReport.finalOutput as any).engineId, "test");
  assert.equal((pubReport.finalOutput as any).stages.length, 4);
});

test("Flow Connectors: channel branch node selectively routes to user-chosen organic channels", async () => {
  const { createBranchNode, createOrganicPublishNode, createOrganicTelemetryNode } = await import("./nodes.ts");

  const branch = createBranchNode<{ videoBytes: Uint8Array; title: string }>((_data) => ({
    routePaid: false,
    routeOrganic: true,
    organicChannels: ["instagram-reels", "youtube-shorts"],
  }));

  const branchReport = await branch.execute(
    { videoBytes: new Uint8Array([1, 2, 3]), title: "Viral soap demo" },
    { organizationId: "org-test", brandId: "brand-test", correlationId: "corr-6" },
  );

  assert.equal(branchReport.ok, true);
  assert.equal(branchReport.data.routePaid, false);
  assert.equal(branchReport.data.routeOrganic, true);
  assert.deepEqual(branchReport.data.organicChannels, ["instagram-reels", "youtube-shorts"]);

  // Test organic publish node
  const publishNode = createOrganicPublishNode();
  const publishReport = await publishNode.execute(
    {
      mediaBytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "video/mp4",
      caption: "Brand organic post #trending",
      channelIds: branchReport.data.organicChannels,
    },
    { organizationId: "org-test", brandId: "brand-test", correlationId: "corr-7" },
  );

  assert.equal(publishReport.ok, true);
  assert.equal(publishReport.data.length, 2);
  assert.equal(publishReport.data[0]?.channelId, "instagram-reels");
  assert.equal(publishReport.data[1]?.channelId, "youtube-shorts");

  // Test telemetry node
  const telemetryNode = createOrganicTelemetryNode();
  const telemetryReport = await telemetryNode.execute(
    publishReport.data.map((p) => ({ channelId: p.channelId, externalId: p.externalId })),
    { organizationId: "org-test", brandId: "brand-test", correlationId: "corr-8" },
  );

  assert.equal(telemetryReport.ok, true);
  assert.equal(telemetryReport.data.length, 2);
  assert.ok((telemetryReport.data[0]?.metrics as any).views > 0);
  assert.ok((telemetryReport.data[1]?.metrics as any).threeSecondViews > 0);
});

