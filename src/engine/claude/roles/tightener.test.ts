import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { estimateClaudeUsd } from "../rates.ts";
import {
  tightener,
  tightenerAnswerSchema,
  tightenerInputSchema,
  tightenerUserContent,
  type TightenerInput,
} from "./tightener.ts";

function beat(overrides: Partial<TightenerInput> = {}): TightenerInput {
  return tightenerInputSchema.parse({
    beatId: "b1",
    text: "Stop scrolling: this blender crushes 29 grams of ice in seconds, and it is quiet.",
    emphasis: ["quiet"],
    claims: ["Crushes 29 grams of ice"],
    targetWords: 8,
    ...overrides,
  });
}

describe("the tightener role (Bible 6.3 step 5, 11.1)", () => {
  it("is a check call on tightener@1, Haiku, and its output is a short answer", () => {
    assert.equal(tightener.capability, "llm.check");
    assert.equal(tightener.stage, "voice");
    assert.equal(tightener.prompt.version, 1);
    assert.equal(tightener.maxOutputTokens, 300);
    assert.equal(estimateClaudeUsd("anthropic/claude-haiku-5.5", tightener.estimateTokens), 0.0025);
  });

  it("accepts a shorter beat that keeps its number and its emphasis word", () => {
    const longer = tightenerAnswerSchema(beat()).safeParse({
      text: "This blender crushes 29 grams of ice, and it is quiet.",
    });
    assert.equal(longer.success, false, "that text is 12 words, over the 8-word target");
    const kept = tightenerAnswerSchema(beat()).safeParse({
      text: "This blender crushes 29 grams, quiet.",
    });
    assert.equal(kept.success, true, kept.success ? "" : JSON.stringify(kept.error.issues));
  });

  it("refuses a text that drops a number of the beat, at the text", () => {
    const result = tightenerAnswerSchema(beat()).safeParse({
      text: "This blender crushes ice, quietly.",
    });
    assert.equal(result.success, false);
    assert.match(result.error?.issues[0]?.message ?? "", /the number 29 of the beat must be kept/);
  });

  it("refuses a text that drops an emphasis word", () => {
    const result = tightenerAnswerSchema(beat()).safeParse({
      text: "This blender crushes 29 grams.",
    });
    assert.equal(result.success, false);
    assert.ok(result.error?.issues.some((issue) => /emphasis word quiet/.test(issue.message)));
  });

  it("refuses an empty text, and a text with more words than the target", () => {
    assert.equal(tightenerAnswerSchema(beat()).safeParse({ text: "   " }).success, false);
    const long = "one two three four five six seven eight nine 29 quiet";
    assert.equal(tightenerAnswerSchema(beat()).safeParse({ text: long }).success, false);
  });

  it("sends the beat as one untrusted data block, with its word limit", () => {
    const parts = tightenerUserContent(beat());
    const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    assert.match(text, /<untrusted-data name="beat">/);
    assert.match(text, /"targetWords":8/);
  });

  it("sends the answer schema as a JSON schema with the single text key", () => {
    const schema = JSON.stringify(jsonSchemaFor(tightenerAnswerSchema(beat())));
    assert.match(schema, /"text"/);
  });

  it("pins the bytes of tightener@1", () => {
    assert.equal(
      loadPrompt(tightener.prompt).fileHash,
      "sha256:6f81a3fe5340bc318a709e379fcbe9848c8321ffba85264081c249604f29e717",
    );
  });
});
