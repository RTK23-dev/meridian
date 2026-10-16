// The render fallback policy (Bible 6.11 as amended): HyperFrames twice, then Shotstack for a component-free EDL, else
// review. The HyperFrames attempts are stubs that fail or pass; the Shotstack attempt is the real renderEdlWithShotstack
// over recorded responses. No request leaves the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { FIXTURE_IDS } from "../contracts/fixtures/index.ts";
import type { RenderOutcome } from "./hyperframesCloud.ts";
import { HYPERFRAMES_ATTEMPT_LIMIT, isRenderFailure, nextRenderStep, renderWithFallback, type RenderFailure } from "./fallback.ts";
import { renderEdlWithShotstack, type ShotstackRenderOutcome } from "./shotstack.ts";
import {
  componentEdl,
  componentFreeEdl,
  downloadExchange,
  DOWNLOAD_URL,
  expectedBody,
  pollExchange,
  reservedLedger,
  scriptedGateway,
  shotstackDepsFor,
  submitExchange,
} from "./test/shotstackHarness.ts";

const NOW = "2026-10-13T09:05:00.000Z";

const hfFailure = (attempt: number): RenderFailure => ({
  route: "hyperframes",
  attempt,
  message: "render poll failed (HTTP 503)",
  retryable: true,
  stage: "render poll",
});
const shotstackFailure: RenderFailure = { route: "shotstack", attempt: 1, message: "render failed", retryable: true, stage: "render" };

const providerFailure = (message = "render hfr_1 failed: source could not be fetched") =>
  new EngineError("provider", message, { retryable: true, stage: "render" });

/** A fake HyperFrames attempt that fails the first `failures` times, then gives a placeholder outcome. */
function hyperframesStub(failures: number, outcome: RenderOutcome = placeholderOutcome()) {
  const calls: number[] = [];
  return {
    calls,
    attempt: async (attempt: number): Promise<RenderOutcome> => {
      calls.push(attempt);
      if (calls.length <= failures) throw providerFailure();
      return outcome;
    },
  };
}

function placeholderOutcome(): RenderOutcome {
  return {
    video: {
      videoId: FIXTURE_IDS.video,
      edlId: componentFreeEdl.edlId,
      uri: "store://renders/hyperframes.mp4",
      renderer: "hyperframes-cloud",
      durationMs: 24000,
      bytes: 10,
      estimateUsd: 0.05,
      costUsd: null,
      idempotencyKey: `sha256:${"a".repeat(64)}`,
    },
    renderId: "hfr_placeholder",
    alerts: [],
  };
}

describe("nextRenderStep", () => {
  it("starts with the first HyperFrames attempt", () => {
    assert.deepEqual(nextRenderStep({ failures: [], componentFree: true }), { next: "hyperframes", attempt: 1 });
  });

  it("tries HyperFrames a second time after one failure", () => {
    assert.deepEqual(nextRenderStep({ failures: [hfFailure(1)], componentFree: true }), { next: "hyperframes", attempt: 2 });
  });

  it("after two HyperFrames failures, sends a component-free EDL to Shotstack", () => {
    assert.deepEqual(nextRenderStep({ failures: [hfFailure(1), hfFailure(2)], componentFree: true }), { next: "shotstack" });
  });

  it("after two HyperFrames failures, sends an EDL with a custom component to review", () => {
    assert.deepEqual(nextRenderStep({ failures: [hfFailure(1), hfFailure(2)], componentFree: false }), {
      next: "review",
      reason: "custom_components",
    });
  });

  it("after a failed Shotstack render, goes to review and does not try again", () => {
    assert.deepEqual(nextRenderStep({ failures: [hfFailure(1), hfFailure(2), shotstackFailure], componentFree: true }), {
      next: "review",
      reason: "renderers_failed",
    });
  });

  it("allows two HyperFrames attempts (Bible 6.11)", () => {
    assert.equal(HYPERFRAMES_ATTEMPT_LIMIT, 2);
  });
});

describe("isRenderFailure", () => {
  it("counts a provider error and nothing else", () => {
    assert.equal(isRenderFailure(providerFailure()), true);
    assert.equal(isRenderFailure(new EngineError("conflict", "render refused by the budget")), false);
    assert.equal(isRenderFailure(new EngineError("config", "hyperframes is not connected")), false);
    assert.equal(isRenderFailure(new EngineError("invalid_input", "the composition is above the size limit")), false);
    assert.equal(isRenderFailure(new TypeError("a bug in a caller")), false);
  });
});

describe("renderWithFallback", () => {
  it("a passing HyperFrames render is final: no fallback is tried", async () => {
    const hf = hyperframesStub(0);
    let shotstackCalls = 0;
    const result = await renderWithFallback(componentFreeEdl, {
      hyperframes: hf.attempt,
      shotstack: async () => {
        shotstackCalls += 1;
        throw new Error("not expected");
      },
    });
    assert.equal(result.status, "rendered");
    assert.equal(result.status === "rendered" && result.route, "hyperframes");
    assert.deepEqual(result.failures, []);
    assert.deepEqual(hf.calls, [1]);
    assert.equal(shotstackCalls, 0);
  });

  it("one HyperFrames failure is retried on HyperFrames with attempt 2, and the failure is kept", async () => {
    const hf = hyperframesStub(1);
    const result = await renderWithFallback(componentFreeEdl, { hyperframes: hf.attempt, shotstack: async () => { throw new Error("not expected"); } });
    assert.equal(result.status === "rendered" && result.route, "hyperframes");
    assert.deepEqual(hf.calls, [1, 2]);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.route, "hyperframes");
    assert.equal(result.failures[0]?.attempt, 1);
  });

  it("two HyperFrames failures on a component-free EDL fall back to Shotstack, which delivers", async () => {
    const hf = hyperframesStub(2);
    const scripted = scriptedGateway([
      submitExchange({ body: expectedBody() }),
      pollExchange("done", { url: DOWNLOAD_URL }),
      downloadExchange(),
    ]);
    const { ledger, reservationId } = await reservedLedger();
    const deps = shotstackDepsFor(scripted.gateway, ledger);
    const result = await renderWithFallback(componentFreeEdl, {
      hyperframes: hf.attempt,
      shotstack: () => renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, deps),
    });

    assert.deepEqual(scripted.problems, []);
    assert.deepEqual(hf.calls, [1, 2]);
    assert.equal(result.status, "rendered");
    if (result.status !== "rendered" || result.route !== "shotstack") assert.fail("expected a Shotstack render");
    assert.equal(result.outcome.video.renderer, "shotstack");
    assert.deepEqual(
      result.failures.map((failure) => [failure.route, failure.attempt]),
      [
        ["hyperframes", 1],
        ["hyperframes", 2],
      ],
    );
    assert.equal(result.outcome.dropped.length, 3, "the features Shotstack did not draw are in the outcome for the manifest");
  });

  it("a forced HyperFrames failure on an EDL with a custom component goes to review, and Shotstack is not called", async () => {
    const hf = hyperframesStub(2);
    let shotstackCalls = 0;
    const result = await renderWithFallback(componentEdl, {
      hyperframes: hf.attempt,
      shotstack: async (): Promise<ShotstackRenderOutcome> => {
        shotstackCalls += 1;
        throw new Error("not expected");
      },
    });
    assert.equal(result.status, "review");
    assert.equal(result.status === "review" && result.reason, "custom_components");
    assert.equal(result.failures.length, 2);
    assert.equal(shotstackCalls, 0);
    assert.deepEqual(hf.calls, [1, 2]);
  });

  it("a failed Shotstack render goes to review, with every failure recorded", async () => {
    const hf = hyperframesStub(2);
    const scripted = scriptedGateway([submitExchange({ body: expectedBody() }), pollExchange("failed", { error: "render failed" })]);
    const { ledger, reservationId } = await reservedLedger();
    const deps = shotstackDepsFor(scripted.gateway, ledger);
    const result = await renderWithFallback(componentFreeEdl, {
      hyperframes: hf.attempt,
      shotstack: () => renderEdlWithShotstack({ reservationId, edl: componentFreeEdl, estimateUsd: 0.1, now: NOW }, deps),
    });
    assert.equal(result.status, "review");
    assert.equal(result.status === "review" && result.reason, "renderers_failed");
    assert.deepEqual(
      result.failures.map((failure) => failure.route),
      ["hyperframes", "hyperframes", "shotstack"],
    );
    assert.deepEqual(deps.stored, []);
  });

  it("a budget refusal stops the chain at once: no second attempt and no fallback", async () => {
    let hfCalls = 0;
    let shotstackCalls = 0;
    await assert.rejects(
      renderWithFallback(componentFreeEdl, {
        hyperframes: async () => {
          hfCalls += 1;
          throw new EngineError("conflict", "render refused by the budget: the request line is spent", { stage: "render" });
        },
        shotstack: async () => {
          shotstackCalls += 1;
          throw new Error("not expected");
        },
      }),
      (error) => error instanceof EngineError && error.kind === "conflict",
    );
    assert.equal(hfCalls, 1);
    assert.equal(shotstackCalls, 0);
  });

  it("a missing key stops the chain at once, so nothing is sent on another renderer's money", async () => {
    let hfCalls = 0;
    await assert.rejects(
      renderWithFallback(componentFreeEdl, {
        hyperframes: async () => {
          hfCalls += 1;
          throw new EngineError("config", "no HeyGen key is available", { stage: "render" });
        },
        shotstack: async () => {
          throw new Error("not expected");
        },
      }),
      (error) => error instanceof EngineError && error.kind === "config",
    );
    assert.equal(hfCalls, 1);
  });

  it("a bug in an attempt is thrown, not counted as a render failure", async () => {
    const bug = new TypeError("cannot read properties of undefined");
    let hfCalls = 0;
    await assert.rejects(
      renderWithFallback(componentFreeEdl, {
        hyperframes: async () => {
          hfCalls += 1;
          throw bug;
        },
        shotstack: async () => {
          throw new Error("not expected");
        },
      }),
      bug,
    );
    assert.equal(hfCalls, 1);
  });
});
