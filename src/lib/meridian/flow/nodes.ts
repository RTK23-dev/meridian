import type { FlowContext, FlowNode, NodeExecutionResult } from "./connector.ts";
import type { SourceAdapter, NormalizedAdRecord } from "../factory/sources.ts";
import type { GradingEngine, GradingInput, GradingResult } from "../grading/engine.ts";
import type { PlannerEngine, VariantPlanningInput, VariantPlanningResult } from "../planner/engine.ts";
import type { VideoEngine } from "../video/engine.ts";
import type { PublishEngine, PublishPausedRequest, PublishEngineResult } from "../publishing/engine.ts";
import { compareOriginalityAgainstSource } from "../factory/gates.ts";
import type { HypitJobContract } from "../hypit/contract.ts";

/** Source Ingestion Connector Node */
export function createSourceNode(adapter: SourceAdapter, id = "source-node"): FlowNode<{ limit?: number }, NormalizedAdRecord[]> {
  return {
    id,
    name: `Source (${adapter.id})`,
    type: "source",
    async execute(input, context): Promise<NodeExecutionResult<NormalizedAdRecord[]>> {
      const status = adapter.status();
      if (status.status !== "CONFIGURED") {
        return {
          ok: false,
          data: [],
          error: `Source adapter "${adapter.id}" is not configured: ${status.detail}`,
          logs: [`Adapter status: ${status.status}`],
        };
      }
      const records = await adapter.fetchRecentAds({ limit: input.limit ?? 20 });
      return {
        ok: true,
        data: records,
        logs: [`Fetched ${records.length} records from ${adapter.id}`],
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

      const submit = await engine.submit(contract, {} as any);
      if (!submit.ok || !submit.job?.providerJobId) {
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Video submission failed: ${submit.error || "No job ID returned"}`,
        };
      }

      const poll = await engine.poll(submit.job.providerJobId, {} as any);
      if (!poll.ok || poll.job?.status !== "succeeded") {
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Video rendering failed or still pending.`,
        };
      }

      const artifact = await engine.collect(submit.job.providerJobId, {} as any);
      if (!artifact.ok || !artifact.artifact) {
        return {
          ok: false,
          data: { artifactBytes: new Uint8Array(), mime: "", durationMs: 0 },
          error: `Could not collect completed video artifact: ${artifact.error || "Artifact missing"}`,
        };
      }

      return {
        ok: true,
        data: {
          artifactBytes: artifact.artifact.bytes,
          mime: artifact.artifact.mime,
          durationMs: artifact.artifact.durationMs,
        },
        logs: [`Produced artifact: ${artifact.artifact.bytes.byteLength} bytes (${artifact.artifact.mime})`],
      };
    },
  };
}

/** Originality and Rights Gate Connector Node */
export function createGateNode(
  options: { maxHammingDistance?: number; maxEmbeddingCosine?: number } = {},
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
        maxHammingDistance: options.maxHammingDistance,
        maxEmbeddingCosine: options.maxEmbeddingCosine,
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
