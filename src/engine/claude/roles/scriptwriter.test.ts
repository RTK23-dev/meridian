import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { videoDnaFixture, briefFixture } from "../../contracts/fixtures/index.ts";
import { ledgerWith, deps, fixture, gatewayFor, json, request, sentMessages, textOf } from "../test/helpers.ts";
import { runRole } from "../client.ts";
import { RoleAnswerError } from "../errors.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { estimateClaudeUsd } from "../rates.ts";
import {
  scriptwriter,
  scriptwriterAnswerSchema,
  scriptwriterInputSchema,
  scriptwriterUserContent,
  SCRIPTWRITER_MAX_BEATS,
  type ScriptwriterAnswer,
  type ScriptwriterInput,
} from "./scriptwriter.ts";

/** The writer's input for the brief fixture and the DNA fixture: the reference's transcript is the copy check's material. */
function writerInput(overrides: Partial<ScriptwriterInput["constraints"]> = {}): ScriptwriterInput {
  return scriptwriterInputSchema.parse({
    brief: {
      text: briefFixture.text,
      sources: briefFixture.sources,
      attachments: briefFixture.attachments.map((attachment) => ({ mediaType: attachment.mediaType, note: attachment.note })),
    },
    reference: {
      videoDnaId: videoDnaFixture.videoDnaId,
      durationMs: videoDnaFixture.durationMs,
      genome: videoDnaFixture.genome,
      transferable: videoDnaFixture.transferable,
      notTransferable: videoDnaFixture.notTransferable,
      segments: videoDnaFixture.segments.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        shotType: segment.shotType,
        ...(segment.beatRole === undefined ? {} : { beatRole: segment.beatRole }),
      })),
    },
    transcript: videoDnaFixture.transcript.words,
    constraints: { maxMs: 30000, wordsPerMinute: 150, ...overrides },
    claims: ["Makes four smoothies in under two minutes"],
    forbidden: ["cures"],
  });
}

/** The answer of a recorded call: the JSON object in the first choice's content. */
function answerOf(name: string): unknown {
  const body = fixture(name) as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(body.choices[0]?.message.content ?? "null");
}

function answerIssues(input: ScriptwriterInput, answer: unknown): string[] {
  const parsed = scriptwriterAnswerSchema(input).safeParse(answer);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("the scriptwriter role (contract v8, Bible 6.x write_script, 11.1)", () => {
  it("is a direction call on scriptwriter@1, Opus, with a bounded answer and a priced estimate", () => {
    assert.equal(scriptwriter.role, "scriptwriter");
    assert.equal(scriptwriter.capability, "llm.direction");
    assert.equal(scriptwriter.stage, "write_script");
    assert.deepEqual(scriptwriter.prompt, { role: "scriptwriter", version: 1 });
    assert.equal(scriptwriter.maxOutputTokens, 2000);
    assert.ok(estimateClaudeUsd("anthropic/claude-opus-5.5", scriptwriter.estimateTokens) > 0);
    assert.equal(loadPrompt(scriptwriter.prompt).id, "scriptwriter@1");
  });

  it("the sent message carries the brief, the structure and the constraints, never the reference's words or an attachment's uri", () => {
    const content = scriptwriterUserContent(writerInput())
      .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
      .join("\n");
    assert.match(content, /<untrusted-data name="brief">/);
    assert.match(content, /<untrusted-data name="reference">/);
    assert.match(content, /<untrusted-data name="constraints">/);
    assert.doesNotMatch(content, /wordId/, "the transcript's word records are not sent");
    assert.doesNotMatch(content, /blender trick/, "the reference's spoken words are not sent");
    assert.doesNotMatch(content, /store:\/\//, "an attachment's store uri is not sent");
    assert.match(content, /"maxMs":30000/);
  });

  it("accepts the recorded script: beats in new words, within maxMs, with the brief's source label", () => {
    const input = writerInput();
    const answer = answerOf("openrouter-scriptwriter-ok");
    assert.deepEqual(answerIssues(input, answer), []);
    const parsed = scriptwriterAnswerSchema(input).parse(answer) as ScriptwriterAnswer;
    assert.equal(parsed.beats.length, 5);
    assert.equal(parsed.beats[0]?.role, "hook");
  });

  it("refuses a beat that repeats three words of the reference in order, at the beat's text", () => {
    const issues = answerIssues(writerInput(), answerOf("openrouter-scriptwriter-copies"));
    assert.ok(
      issues.some((issue) => issue.startsWith("beats.2.text:") && /repeats 3 or more words of the reference/.test(issue)),
      issues.join(" | "),
    );
  });

  it("refuses a script over maxMs at its words per minute, at the beats", () => {
    const issues = answerIssues(writerInput(), answerOf("openrouter-scriptwriter-long"));
    assert.ok(issues.some((issue) => issue.startsWith("beats:") && /over maxMs 30000 ms/.test(issue)), issues.join(" | "));
  });

  it("refuses a source label that is not one of the brief's labels, and a language that is not a tag", () => {
    const input = writerInput();
    const unknown = answerIssues(input, answerOf("openrouter-scriptwriter-unknown-label"));
    assert.ok(unknown.some((issue) => issue.startsWith("sourceLabels.0:")), unknown.join(" | "));
    const badLanguage = answerIssues(input, { ...(answerOf("openrouter-scriptwriter-ok") as object), language: "not a language" });
    assert.ok(badLanguage.some((issue) => issue.startsWith("language:")), badLanguage.join(" | "));
  });

  it("refuses an emphasis word that is not in its beat, a repeated beat id, and a forbidden term", () => {
    const input = writerInput();
    const base = answerOf("openrouter-scriptwriter-ok") as ScriptwriterAnswer;
    const first = base.beats[0];
    assert.ok(first, "the recorded script has a first beat");
    const badEmphasis = { ...base, beats: [{ ...first, emphasis: ["missing"] }, ...base.beats.slice(1)] };
    assert.ok(answerIssues(input, badEmphasis).some((issue) => /the emphasis word missing is not in the beat/.test(issue)));
    const repeated = { ...base, beats: base.beats.map((beat) => ({ ...beat, beatId: "b1" })) };
    assert.ok(answerIssues(input, repeated).some((issue) => /each beat has its own beatId/.test(issue)));
    const forbidden = { ...base, beats: [{ ...first, text: "This blender cures the morning rush." }, ...base.beats.slice(1)] };
    assert.ok(answerIssues(input, forbidden).some((issue) => /forbids/.test(issue)));
  });

  it("the beat count is bounded", () => {
    const base = answerOf("openrouter-scriptwriter-ok") as ScriptwriterAnswer;
    const many = Array.from({ length: SCRIPTWRITER_MAX_BEATS + 1 }, (_, index) => ({ beatId: `b${index + 1}`, role: "setup", text: "Plain words." }));
    assert.ok(answerIssues(writerInput(), { ...base, beats: many }).some((issue) => issue.startsWith("beats:")));
  });

  it("the recorded script is accepted by the client on its first call, and nothing else is sent", async () => {
    const { gateway, requests } = gatewayFor([json(200, fixture("openrouter-scriptwriter-ok"))]);
    const ledger = await ledgerWith(1);
    const outcome = await runRole(deps(gateway, ledger), scriptwriter, request(writerInput()));
    assert.equal(outcome.status, "done");
    assert.equal(outcome.calls.length, 1);
    assert.equal(requests.length, 1);
    const sent = sentMessages(requests[0]?.body);
    assert.equal(sent[0]?.role, "system");
    assert.doesNotMatch(String(requests[0]?.body), /"wordId"/);
  });

  it("a copied script gets one retry, with the failed check named by path, and the retry's answer is used", async () => {
    const { gateway, requests } = gatewayFor([
      json(200, fixture("openrouter-scriptwriter-copies")),
      json(200, fixture("openrouter-scriptwriter-ok")),
    ]);
    const ledger = await ledgerWith(1);
    const outcome = await runRole(deps(gateway, ledger), scriptwriter, request(writerInput()));
    assert.equal(outcome.status, "done");
    assert.equal(outcome.calls.length, 2, "the first answer failed its contract, so the retry is the second call");
    assert.equal(requests.length, 2);
    assert.match(textOf(sentMessages(requests[1]?.body).at(-1)?.content), /beats\.2\.text|repeats 3 or more words/);
  });

  it("a script refused twice is a RoleAnswerError: the stage fails with the checks, and no script is returned", async () => {
    const { gateway } = gatewayFor([
      json(200, fixture("openrouter-scriptwriter-copies")),
      json(200, fixture("openrouter-scriptwriter-copies")),
    ]);
    const ledger = await ledgerWith(1);
    await assert.rejects(runRole(deps(gateway, ledger), scriptwriter, request(writerInput())), (error: unknown) => {
      return error instanceof RoleAnswerError && error.role === "scriptwriter" && error.attempts === 2 && error.retryable === false;
    });
  });
});
