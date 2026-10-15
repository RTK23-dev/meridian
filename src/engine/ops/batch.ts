// Batch planning for `priority: batch` (Video Engine Bible 11.4, 20.3 item 6, 19 E6). The Batch API halves the price of a Claude call, but
// whether OpenRouter passes batch through is unverified (Bible 20.3 item 6). Until it is verified, and an executor exists in this repo, a
// batch request runs as normal calls: the planner says so, with the reason, and never pretends to batch.
//
// The planner returns mode "batch" only when a route says batch is supported AND an executor for it is built. The table below says neither
// for OpenRouter, so every plan today is normal calls. Unknown support is treated as not supported (fail closed). The route table itself
// (config/routes.ts) has no batch field, and this file does not add one: that change belongs to eng-contracts (STATUS.md request).

import type { RequestPriority } from "../jobs/settings.ts";

export type BatchStatus = "not_supported" | "unknown" | "supported";

export type BatchCapability = {
  provider: string;
  status: BatchStatus;
  /** True only when an executor that submits a batch and collects its results is built in this repository. */
  executorBuilt: boolean;
  /** Why the status is what it is, with the Bible reference. Shown to the operator, never to a model. */
  reason: string;
};

/** The batch support of each provider this engine routes to. OpenRouter: unverified (Bible 20.3 item 6), no executor. */
export const batchCapabilities: Readonly<Record<string, BatchCapability>> = {
  openrouter: {
    provider: "openrouter",
    status: "unknown",
    executorBuilt: false,
    reason: "OpenRouter batch support is unknown (Bible 20.3 item 6), so batch is not supported on this route",
  },
};

export type BatchPlan =
  | { mode: "normal_calls"; priority: RequestPriority; provider: string; batchStatus: BatchStatus; reason: string }
  | { mode: "batch"; priority: "batch"; provider: string; batchStatus: "supported"; reason: string };

/**
 * The plan for one request's calls on one provider. rush and normal requests are normal calls with no batch question to answer. A batch
 * request is normal calls too, unless its provider's batch support is verified and its executor exists. Its reason says which.
 */
export function planBatch(input: {
  priority: RequestPriority;
  provider: string;
  capabilities?: Readonly<Record<string, BatchCapability>>;
}): BatchPlan {
  const capability = (input.capabilities ?? batchCapabilities)[input.provider];
  if (input.priority !== "batch") {
    return {
      mode: "normal_calls",
      priority: input.priority,
      provider: input.provider,
      batchStatus: capability?.status ?? "unknown",
      reason: "priority is not batch, so the calls are normal calls",
    };
  }
  if (capability === undefined) {
    return {
      mode: "normal_calls",
      priority: "batch",
      provider: input.provider,
      batchStatus: "unknown",
      reason: `${input.provider} has no batch entry, so batch is not supported on this route; the calls run as normal calls`,
    };
  }
  if (capability.status === "supported" && capability.executorBuilt) {
    return { mode: "batch", priority: "batch", provider: input.provider, batchStatus: "supported", reason: "batch is supported on this route and its executor is built" };
  }
  const why =
    capability.status === "supported"
      ? "batch is supported on this route, but no executor is built, so the calls run as normal calls"
      : `${capability.reason}; the calls run as normal calls`;
  return { mode: "normal_calls", priority: "batch", provider: input.provider, batchStatus: capability.status, reason: why };
}

/** The batch counts of the report: how many batch requests ran, and as what. A request with no plan is not counted as batched. */
export type BatchReport = { batchRequests: number; asNormalCalls: number; asBatch: number; reason: string | null };

/** Summarises the plans of the batch requests in one read. It counts what the planner decided, so the report never claims a batch it did not make. */
export function summarizeBatch(plans: readonly BatchPlan[]): BatchReport {
  const batchPlans = plans.filter((plan) => plan.priority === "batch");
  const asBatch = batchPlans.filter((plan) => plan.mode === "batch").length;
  const reasons = [...new Set(batchPlans.filter((plan) => plan.mode === "normal_calls").map((plan) => plan.reason))];
  return {
    batchRequests: batchPlans.length,
    asNormalCalls: batchPlans.length - asBatch,
    asBatch,
    reason: reasons[0] ?? null,
  };
}
