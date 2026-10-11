import type { FlowContext, FlowNode, NodeExecutionResult } from "./connector.ts";
import { secretForCategory } from "../credentials/resolve.ts";
import type { SourceAdapter, SourceAdItem } from "../factory/sources.ts";
import type { GradingEngine, GradingInput, GradingResult } from "../grading/engine.ts";
import type { PlannerEngine, VariantPlanningInput, VariantPlanningResult } from "../planner/engine.ts";
import type { VideoEngine } from "../video/engine.ts";
import type { PublishEngine, PublishPausedRequest, PublishEngineResult } from "../publishing/engine.ts";
import { compareOriginalityAgainstSource } from "../factory/gates.ts";
import type { HypitJobContract } from "../hypit/contract.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

/** Source Ingestion Connector Node */
export function createSourceNode(adapter: SourceAdapter, id = "source-node"): FlowNode<{ niche?: string; limit?: number }, SourceAdItem[]> {
  return {
    id,
    name: `Source (${adapter.name})`,
    type: "source",
    async execute(input): Promise<NodeExecutionResult<SourceAdItem[]>> {
      const check = await adapter.checkConnection();
      if (!check.connected) {
        return {
          ok: false,
          data: [],
          error: `Source adapter "${adapter.name}" is not connected: ${check.reason ?? "Missing credentials"}`,
          logs: [`Connected: false`],
        };
      }
      const fetchResult = await adapter.fetchAds({ niche: input.niche, limit: input.limit ?? 20 });
      if (fetchResult.status !== "connected") {
        const errorMsg = fetchResult.status === "failed" ? fetchResult.error : fetchResult.reason;
        return {
          ok: false,
          data: [],
          error: errorMsg,
        };
      }
      return {
        ok: true,
        data: fetchResult.ads,
        logs: [`Fetched ${fetchResult.ads.length} records from ${adapter.name}`],
      };
    },
  };
}

/** Grading / Scoring Connector Node */
export function createGradingNode(engine: GradingEngine, id = "grading-node"): FlowNode<GradingInput, GradingResult> {
  return {
    id,
    name: `Grading (${engine.name})`,
    type: "grade",
    async execute(input): Promise<NodeExecutionResult<GradingResult>> {
      const result = await engine.grade(input);
      return {
        ok: result.passed,
        data: result,
        logs: [`Graded overall score: ${result.overallScore.toFixed(3)} (passed: ${result.passed})`, ...result.reasons],
        error: result.passed ? undefined : `Item did not meet passing score threshold (${result.overallScore.toFixed(3)}).`,
      };
    },
  };
}

/** Variant Planner Connector Node */
export function createPlannerNode(engine: PlannerEngine, id = "planner-node"): FlowNode<VariantPlanningInput, VariantPlanningResult> {
  return {
    id,
    name: `Planner (${engine.name})`,
    type: "plan",
    async execute(input): Promise<NodeExecutionResult<VariantPlanningResult>> {
      const plan = await engine.planVariants(input);
      return {
        ok: true,
        data: plan,
        logs: [`Planned ${plan.variants.length} creative variants from ${plan.totalCombinations} combinations`],
      };
    },
  };
}

/** Production / Video Assembly Connector Node */
export function createProductionNode(engine: VideoEngine, id = "production-node"): FlowNode<HypitJobContract, { artifactBytes: Uint8Array; mime: string; durationMs: number }> {
  return {
    id,
    name: `Production (${engine.id})`,
    type: "produce",
    async execute(contract, context): Promise<NodeExecutionResult<{ artifactBytes: Uint8Array; mime: string; durationMs: number }>> {
      const status = engine.status();
      if (status.status !== "CONFIGURED") {
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Video engine "${engine.id}" is not configured: ${status.detail}`,
        };
      }

      const token = await secretForCategory("hypit", context.organizationId);
      if (!token.secret) {
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Video engine "${engine.id}" has no workspace key: ${token.reason}`,
        };
      }
      const submit = await engine.submit(contract, {} as any, token.secret);
      if (!submit.ok || !submit.job?.providerJobId) {
        const errorMsg = "error" in submit ? String(submit.error) : "No job ID returned";
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Video submission failed: ${errorMsg}`,
        };
      }

      const poll = await engine.poll(submit.job.providerJobId, {} as any, token.secret);
      if (!poll.ok || poll.job?.status !== "succeeded") {
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Video rendering failed or still pending.`,
        };
      }

      const artifact = await engine.collect(submit.job.providerJobId, {} as any, token.secret);
      if (!artifact.ok || !artifact.artifact) {
        const errorMsg = "error" in artifact ? String(artifact.error) : "Artifact missing";
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Could not collect completed video artifact: ${errorMsg}`,
        };
      }

      return {
        ok: true,
        data: {
          artifactBytes: artifact.artifact.bytes,
          mime: artifact.artifact.mime,
          durationMs: artifact.artifact.durationMs ?? 0,
        },
        logs: [`Produced artifact: ${artifact.artifact.bytes.byteLength} bytes (${artifact.artifact.mime})`],
      };
    },
  };
}

/** Originality and Rights Gate Connector Node */
export function createGateNode(
  _options: { maxHammingDistance?: number; maxEmbeddingCosine?: number } = {},
  id = "gate-node",
): FlowNode<{ variantFrames?: Uint8Array[]; sourceFrames?: Uint8Array[]; variantEmbedding?: number[]; sourceEmbedding?: number[] }, { passed: boolean; reason: string }> {
  return {
    id,
    name: "Originality Gate",
    type: "gate",
    async execute(input): Promise<NodeExecutionResult<{ passed: boolean; reason: string }>> {
      const check = compareOriginalityAgainstSource({
        variantFrames: input.variantFrames,
        sourceFrames: input.sourceFrames,
        variantEmbedding: input.variantEmbedding,
        sourceEmbedding: input.sourceEmbedding,
      });

      if (check.result === "block") {
        return {
          ok: false,
          data: { passed: false, reason: check.reason },
          error: `Originality gate blocked candidate: ${check.reason}`,
          logs: [`Gate result: block (${check.reason})`],
        };
      }

      if (check.result === "review") {
        return {
          ok: false,
          data: { passed: false, reason: check.reason },
          error: `Originality gate routed candidate to human review: ${check.reason}`,
          logs: [`Gate result: human review required (${check.reason})`],
        };
      }

      return {
        ok: true,
        data: { passed: true, reason: check.reason },
        logs: [`Originality gate passed: ${check.reason}`],
      };
    },
  };
}

/** Publishing Connector Node */
export function createPublishNode(engine: PublishEngine, id = "publish-node"): FlowNode<PublishPausedRequest, PublishEngineResult> {
  return {
    id,
    name: `Publishing (${engine.name})`,
    type: "publish",
    async execute(request): Promise<NodeExecutionResult<PublishEngineResult>> {
      const status = engine.status(request.env);
      if (status.status !== "CONFIGURED") {
        return {
          ok: false,
          data: { engineId: engine.id, ok: false, stages: [], error: status.detail },
          error: `Publish engine "${engine.id}" is not connected: ${status.detail}`,
        };
      }

      const result = await engine.publishPaused(request);
      return {
        ok: result.ok,
        data: result,
        logs: [`Published paused stages: ${result.stages.map((s) => `${s.objectType}:${s.status}`).join(", ")}`],
        error: result.ok ? undefined : result.error || "Failed to publish paused stages.",
      };
    },
  };
}

/** Branching / Channel Router Connector Node (selectively directs content to chosen destinations) */
export function createBranchNode<T = unknown>(
  predicate: (data: T, context: FlowContext) => { routePaid: boolean; routeOrganic: boolean; organicChannels?: string[] },
  id = "branch-node",
): FlowNode<T, { payload: T; routePaid: boolean; routeOrganic: boolean; organicChannels: string[] }> {
  return {
    id,
    name: "Channel Router",
    type: "branch",
    async execute(input, context): Promise<NodeExecutionResult<{ payload: T; routePaid: boolean; routeOrganic: boolean; organicChannels: string[] }>> {
      const routing = predicate(input, context);
      const organicChannels = routing.organicChannels ?? [];
      return {
        ok: true,
        data: {
          payload: input,
          routePaid: routing.routePaid,
          routeOrganic: routing.routeOrganic,
          organicChannels,
        },
        logs: [`Route decision -> Paid: ${routing.routePaid}, Organic: ${routing.routeOrganic} (Channels: ${organicChannels.join(", ") || "none"})`],
      };
    },
  };
}

/** Organic Social Multi-Channel Publishing Connector Node */
export function createOrganicPublishNode(
  options: { channelIds?: string[] } = {},
  id = "organic-publish-node",
): FlowNode<
  {
    mediaBytes: Uint8Array;
    mimeType: string;
    caption: string;
    title?: string;
    tags?: string[];
    aspectRatio?: "9:16" | "1:1" | "16:9" | "4:5";
    channelIds?: string[];
    creativeId?: string;
  },
  { channelId: string; externalId: string; status: string; postUrl?: string }[]
> {
  return {
    id,
    name: "Organic Social Publisher",
    type: "publish",
    async execute(input, context): Promise<NodeExecutionResult<{ channelId: string; externalId: string; status: string; postUrl?: string }[]>> {
      const { publishToSelectedChannels } = await import("../distribution/registry.ts");
      const targetChannels = input.channelIds ?? options.channelIds ?? ["instagram-reels", "youtube-shorts"];
      
      const publishResults = await publishToSelectedChannels({
        selectedChannelIds: targetChannels,
        request: {
          brandId: context.brandId,
          organizationId: context.organizationId,
          creativeId: input.creativeId,
          mediaBytes: input.mediaBytes,
          mimeType: input.mimeType,
          caption: input.caption,
          title: input.title,
          tags: input.tags,
          aspectRatio: input.aspectRatio ?? "9:16",
          allowTestProvider: isTestingRuntimeNow(),
        },
      });

      const successful = publishResults.filter((r) => r.receipt.status === "published" || r.receipt.status === "scheduled");
      const mapped = publishResults.map((r) => ({
        channelId: r.channelId,
        externalId: r.receipt.externalId,
        status: r.receipt.status,
        postUrl: r.receipt.postUrl,
      }));

      return {
        ok: successful.length > 0,
        data: mapped,
        logs: mapped.map((m) => `[${m.channelId}] Status: ${m.status} (ID: ${m.externalId})`),
        error: successful.length === 0 ? "All targeted organic channels failed to publish." : undefined,
      };
    },
  };
}

/** Organic Social Telemetry Ingestion Connector Node */
export function createOrganicTelemetryNode(
  id = "organic-telemetry-node",
): FlowNode<
  { channelId: string; externalId: string }[],
  { channelId: string; externalId: string; metrics: Record<string, unknown> | null }[]
> {
  return {
    id,
    name: "Organic Telemetry Ingestor",
    type: "telemetry",
    async execute(targets): Promise<NodeExecutionResult<{ channelId: string; externalId: string; metrics: Record<string, unknown> | null }[]>> {
      const { getDistributionChannel } = await import("../distribution/registry.ts");
      const results: { channelId: string; externalId: string; metrics: Record<string, unknown> | null }[] = [];

      for (const target of targets) {
        const channel = getDistributionChannel(target.channelId);
        if (!channel) continue;
        const metrics = await channel.fetchMetrics(target.externalId);
        results.push({
          channelId: target.channelId,
          externalId: target.externalId,
          metrics,
        });
      }

      return {
        ok: true,
        data: results,
        logs: results.map((r) =>
          r.metrics === null
            ? `[${r.channelId}] Telemetry not observed for ${r.externalId}`
            : `[${r.channelId}] Ingested telemetry for ${r.externalId}`,
        ),
      };
    },
  };
}

