// Batch planning for `priority: batch` (Video Engine Bible 11.4, 20.3 item 6). OpenRouter's batch support is unknown, so a batch request
// runs as normal calls and the plan says why. A batch is planned only where the route is verified and an executor exists.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { batchCapabilities, planBatch, summarizeBatch, type BatchCapability, type BatchPlan } from "./batch.ts";

describe("batch planning (Bible 11.4, 20.3 item 6)", () => {
  test("a request that is not batch priority runs as normal calls, with no batch question to answer", () => {
    const plan = planBatch({ priority: "normal", provider: "openrouter" });
    assert.equal(plan.mode, "normal_calls");
    assert.match(plan.reason, /priority is not batch/);
  });

  test("a batch request on OpenRouter is not batched: the plan says the route does not support it", () => {
    const plan = planBatch({ priority: "batch", provider: "openrouter" });
    assert.equal(plan.mode, "normal_calls");
    assert.equal(plan.priority, "batch");
    assert.equal(plan.batchStatus, "unknown");
    assert.match(plan.reason, /not supported on this route/);
    assert.equal(batchCapabilities.openrouter?.executorBuilt, false);
  });

  test("a provider with no batch entry is refused as not supported, never assumed to batch", () => {
    const plan = planBatch({ priority: "batch", provider: "anthropic" });
    assert.equal(plan.mode, "normal_calls");
    assert.match(plan.reason, /has no batch entry/);
  });

  test("a batch is planned only when support is verified and the executor is built", () => {
    const verified: Record<string, BatchCapability> = {
      anthropic: { provider: "anthropic", status: "supported", executorBuilt: true, reason: "verified" },
      other: { provider: "other", status: "supported", executorBuilt: false, reason: "verified" },
    };
    const batched = planBatch({ priority: "batch", provider: "anthropic", capabilities: verified });
    assert.equal(batched.mode, "batch");
    assert.equal(batched.batchStatus, "supported");
    const noExecutor = planBatch({ priority: "batch", provider: "other", capabilities: verified });
    assert.equal(noExecutor.mode, "normal_calls");
    assert.match(noExecutor.reason, /no executor is built/);
  });

  test("the report counts what the planner decided, and gives a reason only when some batch request ran as normal calls", () => {
    const verified: Record<string, BatchCapability> = { anthropic: { provider: "anthropic", status: "supported", executorBuilt: true, reason: "verified" } };
    const plans: BatchPlan[] = [
      planBatch({ priority: "batch", provider: "openrouter" }),
      planBatch({ priority: "batch", provider: "openrouter" }),
      planBatch({ priority: "normal", provider: "openrouter" }),
      planBatch({ priority: "batch", provider: "anthropic", capabilities: verified }),
    ];
    const report = summarizeBatch(plans);
    assert.equal(report.batchRequests, 3, "the normal-priority request is not a batch request");
    assert.equal(report.asBatch, 1);
    assert.equal(report.asNormalCalls, 2);
    assert.match(report.reason ?? "", /not supported on this route/);
    assert.deepEqual(summarizeBatch([planBatch({ priority: "normal", provider: "openrouter" })]), { batchRequests: 0, asNormalCalls: 0, asBatch: 0, reason: null });
  });
});
