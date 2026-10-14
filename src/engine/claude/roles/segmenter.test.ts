import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { estimateClaudeUsd } from "../rates.ts";
import { fixture } from "../test/helpers.ts";
import {
  SEGMENTER_ESTIMATE_TOKENS,
  SEGMENTER_MAX_OUTPUT_TOKENS,
  segmenter,
  segmenterAnswerSchema,
  segmenterInputSchema,
  segmenterUserContent,
  type SegmenterInput,
} from "./segmenter.ts";

function validInput(): SegmenterInput {
  return segmenterInputSchema.parse(fixture("segmenter-input"));
}

function answerFor(input: SegmenterInput, segments: unknown[]) {
  return segmenterAnswerSchema(input).safeParse({ segments });
}

const goodSegment = { segId: "s1", startMs: 0, endMs: 3000, wordIds: ["w1", "w2"], shotType: "talking_head", layers: { base: "a person" } };

describe("segmenter input contract", () => {
  it("accepts the fixture", () => {
    assert.equal(segmenterInputSchema.safeParse(fixture("segmenter-input")).success, true);
  });

  it("refuses a frame that is not a base64 data URL of an image, so no remote URL reaches the model", () => {
    const base = fixture("segmenter-input") as Record<string, unknown>;
    const frames = [{ atMs: 500, imageUrl: "https://example.com/a.png" }];
    const result = segmenterInputSchema.safeParse({ ...base, frames });
    assert.equal(result.success, false);
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join(".")), ["frames.0.imageUrl"]);
  });

  it("refuses frames out of order, cuts outside the video, and duplicate word ids", () => {
    const base = fixture("segmenter-input") as { frames: Array<{ atMs: number; imageUrl: string }>; transcript: unknown[] } & Record<string, unknown>;
    const reversed = segmenterInputSchema.safeParse({ ...base, frames: [...base.frames].reverse() });
    assert.ok(reversed.error?.issues.some((issue) => issue.path.join(".") === "frames.1.atMs"));
    const cutOutside = segmenterInputSchema.safeParse({ ...base, cutsMs: [3000, 12000] });
    assert.ok(cutOutside.error?.issues.some((issue) => issue.path.join(".") === "cutsMs.1"));
    const duplicate = segmenterInputSchema.safeParse({ ...base, transcript: [base.transcript[0], base.transcript[0]] });
    assert.ok(duplicate.error?.issues.some((issue) => issue.path.join(".") === "transcript.1.wordId"));
  });
});

/** The model's answer in the recorded good response, parsed from its content string. */
function goldenAnswer(): { segments: Array<Record<string, unknown>> } {
  const body = fixture("openrouter-segmenter-ok") as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(body.choices[0]?.message.content ?? "null") as { segments: Array<Record<string, unknown>> };
}

describe("segmenter answer contract", () => {
  it("accepts the golden answer and drops fields that code measures", () => {
    const answer = goldenAnswer();
    const first = answer.segments[0];
    assert.ok(first);
    first.motion = 9;
    const parsed = segmenterAnswerSchema(validInput()).safeParse(answer);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && "motion" in (parsed.data.segments[0] ?? {}), false);
  });

  it("refuses a word id the transcript does not have, at the word's path", () => {
    const result = answerFor(validInput(), [{ ...goodSegment, wordIds: ["w1", "w404"] }]);
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join(".")), ["segments.0.wordIds.1"]);
  });

  it("refuses segments that overlap, run past the video, or reuse a segId", () => {
    const input = validInput();
    const overlap = answerFor(input, [goodSegment, { ...goodSegment, segId: "s2", startMs: 2000, endMs: 5000 }]);
    assert.deepEqual(overlap.error?.issues.map((issue) => issue.path.join(".")), ["segments.1.startMs"]);
    const past = answerFor(input, [{ ...goodSegment, endMs: 12001 }]);
    assert.deepEqual(past.error?.issues.map((issue) => issue.path.join(".")), ["segments.0.endMs"]);
    const reused = answerFor(input, [goodSegment, { ...goodSegment, startMs: 3000, endMs: 4000 }]);
    assert.deepEqual(reused.error?.issues.map((issue) => issue.path.join(".")), ["segments.1.segId"]);
  });

  it("is sent to the model as a JSON schema with no motion, brightness or loudness", () => {
    const schema = JSON.stringify(jsonSchemaFor(segmenterAnswerSchema(validInput())));
    assert.doesNotMatch(schema, /"motion"|"brightness"|"loudnessLufs"/);
    assert.match(schema, /"wordIds"/);
  });
});

describe("segmenter role", () => {
  it("is an analysis call on the prompt version 1, with a 3000-token output that matches its estimate", () => {
    assert.equal(segmenter.capability, "llm.analysis");
    assert.equal(segmenter.prompt.role, "segmenter");
    assert.equal(segmenter.prompt.version, 1);
    assert.equal(segmenter.maxOutputTokens, SEGMENTER_MAX_OUTPUT_TOKENS);
    assert.equal(segmenter.estimateTokens.output, SEGMENTER_ESTIMATE_TOKENS.output);
    assert.equal(SEGMENTER_MAX_OUTPUT_TOKENS, 3000);
  });

  it("estimates one call at the Sonnet rate: 26k in and 3k out is $0.082", () => {
    assert.equal(estimateClaudeUsd("anthropic/claude-sonnet-5.5", segmenter.estimateTokens), 0.082);
  });

  it("names the prompt file it loads", () => {
    assert.equal(loadPrompt(segmenter.prompt).id, "segmenter@1");
  });

  it("puts each frame after a label with its time, as an image part, in order", () => {
    const input = validInput();
    const parts = segmenterUserContent(input);
    const images = parts.filter((part) => part.type === "image_url");
    assert.deepEqual(
      images.map((part) => (part.type === "image_url" ? part.image_url.url : "")),
      input.frames.map((frame) => frame.imageUrl),
    );
    const labels = parts.filter((part) => part.type === "text" && /^Frame \d+ at/.test(part.text));
    assert.deepEqual(
      labels.map((part) => (part.type === "text" ? part.text : "")),
      ["Frame 1 at 500 ms:", "Frame 2 at 4000 ms:", "Frame 3 at 8000 ms:"],
    );
  });
});
