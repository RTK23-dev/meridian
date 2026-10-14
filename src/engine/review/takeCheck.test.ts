import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { notConnectedScorer, type SimilarityScorer } from "./take/similarity.ts";
import type { SimilarityOutcome, TakeGoldMetrics } from "./take/types.ts";
import {
  PALETTE,
  REQUEST_ID,
  RESERVATION_ID,
  TAKE_DURATION_MS,
  TAKE_ID,
  TAKE_ID_2,
  WORKSPACE,
  everyKeyProven,
  fixture,
  gatewayFor,
  json,
  ledgerWith,
  presenterShot,
  productShot,
  provenMetrics,
  recordedScorer,
  recordedScores,
  roleDeps,
  takeFrames,
} from "./test/helpers.ts";
import { runTakeCheck, type TakeCheckRequest } from "./takeCheck.ts";
import { pickBestTake } from "./gates/take.ts";

const TAKE_ID_3 = "take_01JABCDEFGHJKMNPQRSTVWXYZ3";

const recorded = fixture<Record<string, Record<string, unknown>>>("take-measurements");
const okBody = fixture<{ choices: Array<{ message: { content: string } }> } & Record<string, unknown>>("openrouter-critic-take-ok");
const handsBody = fixture<unknown>("openrouter-critic-take-hands");

/** The same recorded answer with a different confidence, for the best-of-two test. */
function okWithConfidence(confidence: number): unknown {
  const rubric = JSON.parse(okBody.choices[0]?.message.content ?? "{}") as { rubric: unknown };
  return {
    ...okBody,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ rubric: rubric.rubric, confidence }) } }],
  };
}

function request(overrides: Partial<TakeCheckRequest> = {}): TakeCheckRequest {
  return {
    requestId: REQUEST_ID,
    workspaceId: WORKSPACE,
    reservationId: RESERVATION_ID,
    takeId: TAKE_ID,
    takeDurationMs: TAKE_DURATION_MS,
    shot: productShot(),
    measurements: recorded.clean,
    frames: takeFrames(),
    paletteHex: PALETTE,
    metrics: {},
    ...overrides,
  };
}

describe("runTakeCheck: a clean take end to end (Bible 6.7)", () => {
  it("a clean take with a connected scorer and a clean Critic is accepted, with one Critic call on the ledger", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const scorer = recordedScorer(recordedScores("clean"));
    const run = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer }, request());
    assert.equal(run.verdict.action, "accept");
    assert.equal(run.verdict.pass, true);
    assert.equal(run.gate.pass, true);
    assert.equal(run.calls.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(run.critic.status, "answered");
    assert.deepEqual(scorer.requests.map((item) => item.kind), ["product_vs_hero", "palette_vs_style_kit"]);
  });

  it("the Critic gets the take's duration and the six frames, and the scorer gets the same frames", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const scorer = recordedScorer(recordedScores("clean"));
    await runTakeCheck({ role: roleDeps(gateway, ledger), scorer }, request());
    const sent = JSON.stringify(JSON.parse(String(requests[0]?.body)));
    assert.match(sent, /\\"durationMs\\":4100/);
    const first = scorer.requests[0];
    assert.equal(first?.frames.length, 6);
  });
});

describe("runTakeCheck: a warped product and the gold rule", () => {
  it("a warped product with no proven gold set is escalated to review, not blocked", async () => {
    const { gateway } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const run = await runTakeCheck(
      { role: roleDeps(gateway, ledger), scorer: recordedScorer(recordedScores("warped_product")) },
      request(),
    );
    assert.equal(run.verdict.pass, false);
    assert.equal(run.verdict.action, "escalate");
    assert.deepEqual(run.unprovenFailures, ["product_match"]);
  });

  it("with the product gold set proven, the same warped take is redone with product_match as the hint", async () => {
    const { gateway } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const metrics: TakeGoldMetrics = { "take:product_match": provenMetrics() };
    const run = await runTakeCheck(
      { role: roleDeps(gateway, ledger), scorer: recordedScorer(recordedScores("warped_product")) },
      request({ metrics }),
    );
    assert.equal(run.verdict.action, "redo");
    assert.deepEqual(run.provenFailures, ["product_match"]);
  });

  it("the recorded hands answer escalates the take on rubric_hands, with no gold set to block on", async () => {
    const { gateway } = gatewayFor([json(200, handsBody)]);
    const ledger = await ledgerWith(0.1);
    const run = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer: recordedScorer(recordedScores("clean")) }, request());
    assert.equal(run.verdict.action, "escalate");
    assert.deepEqual(run.unprovenFailures, ["rubric_hands"]);
  });
});

describe("runTakeCheck: missing evidence routes to review", () => {
  it("a scorer that is not connected escalates the take, and the Critic still runs", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const run = await runTakeCheck(
      { role: roleDeps(gateway, ledger), scorer: notConnectedScorer() },
      request({ metrics: everyKeyProven() }),
    );
    assert.equal(run.verdict.pass, false);
    assert.equal(run.verdict.action, "escalate");
    assert.deepEqual(run.missing, ["product_match", "palette_match"]);
    assert.equal(requests.length, 1);
  });

  it("frames that do not match the contract make the Critic and the similarity checks missing, with no Critic call", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const scorer = recordedScorer(recordedScores("clean"));
    const run = await runTakeCheck(
      { role: roleDeps(gateway, ledger), scorer },
      request({ frames: takeFrames().slice(0, 5), metrics: everyKeyProven() }),
    );
    assert.equal(run.verdict.action, "escalate");
    assert.equal(requests.length, 0);
    assert.equal(scorer.requests.length, 0);
    assert.deepEqual(run.missing.sort(), ["palette_match", "product_match", "rubric_answered"]);
  });

  it("a refused Critic call (a paused reservation) escalates with rubric_answered missing", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1, { paused: true });
    const run = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer: recordedScorer(recordedScores("clean")) }, request());
    assert.equal(run.verdict.action, "escalate");
    assert.deepEqual(run.missing, ["rubric_answered"]);
    assert.equal(requests.length, 0);
  });

  it("a scorer that fails with a provider error is not swallowed: the stage fails, and the job can retry", async () => {
    const { gateway } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const broken: SimilarityScorer = {
      id: "similarity:down",
      async score(): Promise<SimilarityOutcome> {
        throw new EngineError("provider", "the scorer timed out", { retryable: true, stage: "check_take" });
      },
    };
    await assert.rejects(
      runTakeCheck({ role: roleDeps(gateway, ledger), scorer: broken }, request()),
      (error: unknown) => error instanceof EngineError && error.retryable === true,
    );
  });
});

describe("runTakeCheck: input and tenancy", () => {
  it("a shot that does not parse is invalid_input before anything is called", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    await assert.rejects(
      runTakeCheck({ role: roleDeps(gateway, ledger), scorer: notConnectedScorer() }, request({ shot: { shotId: "nope" } })),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(requests.length, 0);
  });

  it("a persona shot checks the persona against its portrait", async () => {
    const { gateway } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const scorer = recordedScorer({ face_vs_persona: 0.88, palette_vs_style_kit: 0.82 });
    const run = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer }, request({ shot: presenterShot() }));
    assert.equal(run.verdict.action, "accept");
    assert.deepEqual(scorer.requests.map((item) => item.kind), ["face_vs_persona", "palette_vs_style_kit"]);
  });
});

describe("runTakeCheck: best of two takes (Bible 6.7 step 4)", () => {
  it("of two passing takes, the one with the higher Critic confidence is the best; a failing take is never chosen", async () => {
    const { gateway } = gatewayFor([json(200, okWithConfidence(0.8)), json(200, okBody), json(200, handsBody)]);
    const ledger = await ledgerWith(0.5);
    const scorer = (): SimilarityScorer => recordedScorer(recordedScores("clean"));
    const first = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer: scorer() }, request({ takeId: TAKE_ID }));
    const second = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer: scorer() }, request({ takeId: TAKE_ID_2, frames: takeFrames(10) }));
    const third = await runTakeCheck({ role: roleDeps(gateway, ledger), scorer: scorer() }, request({ takeId: TAKE_ID_3, frames: takeFrames(20) }));
    assert.equal(first.verdict.action, "accept");
    assert.equal(first.verdict.confidence, 0.8);
    assert.equal(second.verdict.action, "accept");
    assert.equal(second.verdict.confidence, 0.91);
    assert.equal(third.verdict.action, "escalate");
    const best = pickBestTake([first.verdict, second.verdict, third.verdict]);
    assert.equal(best?.takeId, TAKE_ID_2);
    assert.equal(best?.confidence, 0.91);
  });
});

