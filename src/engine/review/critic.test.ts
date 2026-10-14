import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../config/thresholds.ts";
import { EngineError } from "../contracts/errors.ts";
import { RoleAnswerError } from "../claude/errors.ts";
import type { SlopRubricItem } from "../claude/roles/critic_take.ts";
import {
  FRAME_IMAGE_URL,
  TAKE_DURATION_MS,
  criticRequestBase,
  fixture,
  gatewayFor,
  json,
  ledgerWith,
  roleDeps,
  takeFrames,
} from "./test/helpers.ts";
import { criticRows, runCritic, type CriticOutcome } from "./critic.ts";

const SHOT = "shot_01JABCDEFGHJKMNPQRSTVWXYZ0";

type Rubric = Record<SlopRubricItem, number>;

function criticInput(frames: unknown = takeFrames()) {
  return { shotId: SHOT, visualType: "product_hero", durationMs: TAKE_DURATION_MS, frames };
}

/** The model's answer inside a recorded OpenRouter body (choices[0].message.content, parsed). */
function answerIn(body: unknown): { rubric: Rubric; confidence: number } {
  const recorded = body as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(recorded.choices[0]?.message.content ?? "null") as { rubric: Rubric; confidence: number };
}

const okBody = fixture<unknown>("openrouter-critic-take-ok");
const handsBody = fixture<unknown>("openrouter-critic-take-hands");
const unsureBody = fixture<unknown>("openrouter-critic-take-unsure");
const invalidBody = fixture<unknown>("openrouter-critic-take-invalid");

describe("runCritic: one Claude call on the request's budget (Bible 6.7 step 3)", () => {
  it("a clean recorded answer is answered, with its rubric and confidence, and one entry on the ledger", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.05);
    const run = await runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() });
    assert.equal(run.outcome.status, "answered");
    if (run.outcome.status === "answered") {
      assert.equal(run.outcome.rubric.hands, 0.92);
      assert.equal(run.outcome.confidence, 0.91);
    }
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0]?.model, "anthropic/claude-haiku-5.5");
    assert.equal(run.calls[0]?.promptVersion, "critic_take@1");
    assert.equal(requests.length, 1);
    const entries = await ledger.listEntries(criticRequestBase().reservationId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.actualUsd, 0.0118);
  });

  it("sends the six frames as images, and the take as an untrusted block", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.05);
    await runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() });
    const sent = JSON.parse(String(requests[0]?.body)) as { messages: Array<{ role: string; content: unknown }> };
    const serialised = JSON.stringify(sent.messages.find((message) => message.role === "user")?.content ?? "");
    assert.equal(serialised.split(FRAME_IMAGE_URL).length - 1, 6);
    assert.ok(serialised.includes('<untrusted-data name=\\"take\\">'));
  });

  it("an answer that breaks the contract is retried once, and the retry's answer is used", async () => {
    const { gateway } = gatewayFor([json(200, invalidBody), json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const run = await runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() });
    assert.equal(run.outcome.status, "answered");
    assert.equal(run.calls.length, 2);
    assert.equal(run.calls[0]?.verdict, "invalid_answer");
    assert.equal(run.calls[1]?.verdict, "answered");
  });

  it("the failed checks kept from an invalid answer are paths and codes, never the model's own text", async () => {
    const { gateway } = gatewayFor([json(200, invalidBody), json(200, okBody)]);
    const ledger = await ledgerWith(0.1);
    const run = await runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() });
    assert.ok((run.calls[0]?.issues.length ?? 0) > 0);
    assert.equal(JSON.stringify(run.calls[0]?.issues).includes("the hands look fine"), false);
  });

  it("two answers that break the contract throw RoleAnswerError: the stage fails, and the job retries it", async () => {
    const { gateway } = gatewayFor([json(200, invalidBody), json(200, invalidBody)]);
    const ledger = await ledgerWith(0.1);
    await assert.rejects(
      runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() }),
      (error: unknown) => error instanceof RoleAnswerError && error.attempts === 2,
    );
  });

  it("a paused reservation refuses the call: not_answered, and nothing is sent", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.05, { paused: true });
    const run = await runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() });
    assert.equal(run.outcome.status, "not_answered");
    assert.equal(requests.length, 0);
    assert.equal(run.calls.length, 0);
  });

  it("frames that do not match the Critic contract are not_answered before any reservation or call", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)]);
    const ledger = await ledgerWith(0.05);
    const run = await runCritic(roleDeps(gateway, ledger), {
      ...criticRequestBase(),
      input: criticInput(takeFrames().slice(0, 5)),
    });
    assert.equal(run.outcome.status, "not_answered");
    assert.match(run.outcome.status === "not_answered" ? run.outcome.reason : "", /do not match the Critic contract/);
    assert.equal(requests.length, 0);
  });

  it("a provider that is not connected throws config before any call, so a missing key never passes", async () => {
    const { gateway, requests } = gatewayFor([json(200, okBody)], { keys: {} });
    const ledger = await ledgerWith(0.05);
    await assert.rejects(
      runCritic(roleDeps(gateway, ledger), { ...criticRequestBase(), input: criticInput() }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
    assert.equal(requests.length, 0);
  });
});

describe("criticRows: the Critic's checks (Bible 12.2)", () => {
  function answered(rubric: Partial<Rubric>, confidence: number): CriticOutcome {
    const full: Rubric = {
      hands: 0.9,
      faces: 0.9,
      anatomy: 0.9,
      physics: 0.9,
      plastic_skin: 0.9,
      morphing_objects: 0.9,
      background_warping: 0.9,
      ...rubric,
    };
    return { status: "answered", rubric: full, confidence };
  }

  it("a clean rubric passes every rubric item and the confidence, and the items share the rubric gold set", () => {
    const rows = criticRows(answered({}, 0.9));
    assert.equal(rows.length, 8);
    assert.ok(rows.every((row) => row.check.pass && row.evidence === "measured"));
    const items = rows.filter((row) => row.check.rule.startsWith("rubric_"));
    assert.equal(items.length, 7);
    assert.ok(items.every((row) => row.gold === "take:slop_rubric"));
  });

  it("the recorded hands answer fails rubric_hands alone, against the configured item limit", () => {
    const answer = answerIn(handsBody);
    const rows = criticRows({ status: "answered", rubric: answer.rubric, confidence: answer.confidence });
    const failing = rows.filter((row) => !row.check.pass).map((row) => row.check.rule);
    assert.deepEqual(failing, ["rubric_hands"]);
    assert.equal(rows.find((row) => row.check.rule === "rubric_hands")?.check.limit, thresholds.take.slopRubricItemMin.value);
  });

  it("an unsure Critic (confidence below the escalation threshold) is an escalation, with no gold set to block on", () => {
    const answer = answerIn(unsureBody);
    const rows = criticRows({ status: "answered", rubric: answer.rubric, confidence: answer.confidence });
    const confidence = rows.find((row) => row.check.rule === "critic_confidence");
    assert.equal(confidence?.check.pass, false);
    assert.equal(confidence?.gold, null);
    assert.match(confidence?.check.detail ?? "", /unsure/);
  });

  it("a Critic with no answer is missing evidence on rubric_answered, and nothing else", () => {
    const rows = criticRows({ status: "not_answered", reason: "the Critic call was refused" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.check.rule, "rubric_answered");
    assert.equal(rows[0]?.check.pass, false);
    assert.equal(rows[0]?.evidence, "missing");
    assert.equal(rows[0]?.gold, null);
    assert.match(rows[0]?.check.detail ?? "", /^not evaluated: /);
  });
});
