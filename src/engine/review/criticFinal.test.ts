import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../config/thresholds.ts";
import { RoleAnswerError } from "../claude/errors.ts";
import { criticFinal, criticFinalRecheck } from "../claude/roles/critic_final.ts";
import { estimateClaudeUsd } from "../claude/rates.ts";
import {
  FRAME_IMAGE_URL,
  REQUEST_ID,
  RESERVATION_ID,
  WORKSPACE,
  fixture,
  gatewayFor,
  json,
  ledgerWith,
  roleDeps,
} from "./test/helpers.ts";
import { criticFrameTimes } from "./gates/postRender.ts";
import { runCriticFinal, type CriticFinalRequest } from "./criticFinal.ts";

const VIDEO = "vid_01JABCDEFGHJKMNPQRSTVWXYZ0";
const DURATION = 24000;

/** Twelve frames at the times the gate samples, with the clip summary the EDL gives. */
function input(frameCount = 12) {
  const times = criticFrameTimes(DURATION).slice(0, frameCount);
  return {
    videoId: VIDEO,
    durationMs: DURATION,
    edlSummary: { clips: [{ layer: "base", startMs: 0, endMs: DURATION, component: null }] },
    frames: times.map((atMs) => ({ atMs, imageUrl: FRAME_IMAGE_URL })),
  };
}

function request(overrides: Partial<CriticFinalRequest> = {}): CriticFinalRequest {
  return { requestId: REQUEST_ID, workspaceId: WORKSPACE, reservationId: RESERVATION_ID, input: input(), ...overrides };
}

const okBody = fixture<unknown>("openrouter-critic-final-ok");
const unsureBody = fixture<unknown>("openrouter-critic-final-unsure");
const sonnetOkBody = fixture<unknown>("openrouter-critic-final-sonnet-ok");
const sonnetUnsureBody = fixture<unknown>("openrouter-critic-final-sonnet-unsure");

describe("critic_final: Haiku first, Sonnet when Haiku is unsure (Bible 12.3, 11.1)", () => {
  it("a confident Haiku answer is the outcome, with one call on the reservation and no re-check", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const run = await runCriticFinal(roleDeps(gateway, ledger), request());
    assert.equal(run.outcome.status, "answered");
    if (run.outcome.status === "answered") {
      assert.equal(run.outcome.answeredBy, "haiku");
      assert.equal(run.outcome.confidence, 0.91);
      assert.equal(run.outcome.rubric.captions_legible, 0.94);
    }
    assert.equal(run.rechecked, false);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0]?.model, "anthropic/claude-haiku-5.5");
    assert.equal(requests.length, 1);
    assert.equal((await ledger.listEntries(RESERVATION_ID)).length, 1);
  });

  it("Haiku unsure (below 0.6) sends the same input to Sonnet, and Sonnet's answer is the outcome", async () => {
    const { gateway, requests } = gatewayFor([json(200, unsureBody), json(200, sonnetOkBody)]);
    const ledger = await ledgerWith(0.2);
    const run = await runCriticFinal(roleDeps(gateway, ledger), request());
    assert.equal(run.rechecked, true);
    assert.equal(run.calls.length, 2, "one Haiku call and one Sonnet call");
    assert.equal(run.calls[0]?.model, "anthropic/claude-haiku-5.5");
    assert.equal(run.calls[1]?.model, "anthropic/claude-sonnet-5.5");
    assert.equal(requests.length, 2);
    assert.equal(run.outcome.status, "answered");
    if (run.outcome.status === "answered") {
      assert.equal(run.outcome.answeredBy, "sonnet");
      assert.equal(run.outcome.confidence, 0.93);
      assert.equal(run.outcome.rubric.hands, 0.4, "Sonnet's rubric decides, not Haiku's");
    }
    assert.equal((await ledger.listEntries(RESERVATION_ID)).length, 2, "both calls are on the ledger");
  });

  it("a Sonnet re-check that is still unsure is answered with its low confidence, so the gate escalates it", async () => {
    const { gateway } = gatewayFor([json(200, unsureBody), json(200, sonnetUnsureBody)]);
    const ledger = await ledgerWith(0.2);
    const run = await runCriticFinal(roleDeps(gateway, ledger), request());
    assert.equal(run.outcome.status, "answered");
    if (run.outcome.status === "answered") {
      assert.equal(run.outcome.answeredBy, "sonnet");
      assert.equal(run.outcome.confidence, 0.5);
      assert.ok(run.outcome.confidence < thresholds.escalation.criticConfidence.value);
    }
  });

  it("a Sonnet re-check the budget refuses is missing evidence, never a pass", async () => {
    // Enough for Haiku's estimate, and not for Sonnet's after Haiku reconciles to its actual cost.
    const haikuUsd = estimateClaudeUsd("anthropic/claude-haiku-5.5", criticFinal.estimateTokens);
    const { gateway, requests } = gatewayFor([json(200, unsureBody)]);
    const ledger = await ledgerWith(haikuUsd + 0.001);
    const run = await runCriticFinal(roleDeps(gateway, ledger), request());
    assert.equal(run.outcome.status, "not_answered");
    assert.equal(run.rechecked, true);
    assert.equal(run.calls.length, 1, "only Haiku was called");
    assert.equal(requests.length, 1);
    assert.match(run.outcome.status === "not_answered" ? run.outcome.reason : "", /Sonnet re-check was refused/);
  });

  it("a first call the budget refuses is not answered, and no re-check is tried", async () => {
    const { gateway, requests } = gatewayFor([]);
    const ledger = await ledgerWith(0);
    const run = await runCriticFinal(roleDeps(gateway, ledger), request());
    assert.equal(run.outcome.status, "not_answered");
    assert.equal(run.rechecked, false);
    assert.equal(run.calls.length, 0);
    assert.equal(requests.length, 0, "nothing is sent when the reservation does not cover the call");
  });

  it("frames that do not match the contract are not answered, and nothing is sent", async () => {
    const { gateway, requests } = gatewayFor([]);
    const ledger = await ledgerWith(0.1);
    const run = await runCriticFinal(roleDeps(gateway, ledger), request({ input: input(11) }));
    assert.equal(run.outcome.status, "not_answered");
    assert.match(run.outcome.status === "not_answered" ? run.outcome.reason : "", /do not match the final Critic contract/);
    assert.equal(requests.length, 0);
  });

  it("two invalid answers from Haiku fail the stage (RoleAnswerError), so the job retries it, and no answer is invented", async () => {
    const invalid = { ...(okBody as Record<string, unknown>) };
    const bad = {
      ...invalid,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"rubric\":{\"hands\":0.9},\"confidence\":0.9}" } }],
    };
    const { gateway } = gatewayFor([json(200, bad), json(200, bad)]);
    const ledger = await ledgerWith(0.1);
    await assert.rejects(runCriticFinal(roleDeps(gateway, ledger), request()), (error: unknown) => error instanceof RoleAnswerError);
  });

  it("the re-check is the same role and prompt as the first call, on the Sonnet route", () => {
    assert.equal(criticFinalRecheck.role, criticFinal.role);
    assert.equal(criticFinalRecheck.schemaName, criticFinal.schemaName);
    assert.notEqual(criticFinalRecheck.capability, criticFinal.capability);
  });
});
