import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { estimateClaudeUsd } from "../rates.ts";
import { loadPrompt } from "../../prompts/load.ts";
import {
  CRAFT_RUBRIC_ITEMS,
  CRITIC_FINAL_ESTIMATE_TOKENS,
  CRITIC_FINAL_MAX_OUTPUT_TOKENS,
  CRITIC_FINAL_PROMPT,
  FINAL_RUBRIC_ITEMS,
  criticFinal,
  criticFinalAnswerSchema,
  criticFinalInputSchema,
  criticFinalRecheck,
  criticFinalUserContent,
  type CriticFinalInput,
} from "./critic_final.ts";
import { SLOP_RUBRIC_ITEMS } from "./critic_take.ts";

const FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const VIDEO = "vid_01JABCDEFGHJKMNPQRSTVWXYZ0";

function frames(count = 12, durationMs = 24000): Array<{ atMs: number; imageUrl: string }> {
  return Array.from({ length: count }, (_, index) => ({ atMs: Math.floor(((index + 0.5) * durationMs) / count), imageUrl: FRAME }));
}

function validInput(): CriticFinalInput {
  return criticFinalInputSchema.parse({
    videoId: VIDEO,
    durationMs: 24000,
    edlSummary: { clips: [{ layer: "base", startMs: 0, endMs: 3000, component: null }] },
    frames: frames(),
  });
}

const goodRubric = {
  hands: 0.9,
  faces: 0.9,
  anatomy: 0.9,
  physics: 0.9,
  plastic_skin: 0.9,
  morphing_objects: 0.9,
  background_warping: 0.9,
  captions_legible: 0.9,
  framing_in_safe_area: 0.9,
};

describe("critic_final input contract (Bible 12.3: twelve frames of the rendered video)", () => {
  it("accepts exactly twelve frames inside the video, in time order", () => {
    assert.equal(validInput().frames.length, thresholds.postRender.criticFinalFrames);
    assert.equal(thresholds.postRender.criticFinalFrames, 12);
  });

  it("refuses any other frame count", () => {
    const eleven = criticFinalInputSchema.safeParse({ videoId: VIDEO, durationMs: 24000, edlSummary: { clips: [] }, frames: frames(11) });
    assert.equal(eleven.success, false);
    const thirteen = criticFinalInputSchema.safeParse({ videoId: VIDEO, durationMs: 24000, edlSummary: { clips: [] }, frames: frames(13) });
    assert.equal(thirteen.success, false);
  });

  it("refuses a frame at or after the end of the video, and frames out of order", () => {
    const pastEnd = criticFinalInputSchema.safeParse({
      videoId: VIDEO,
      durationMs: 1000,
      edlSummary: { clips: [] },
      frames: frames(12, 24000),
    });
    assert.ok(pastEnd.error?.issues.some((issue) => issue.message === "a frame must fall inside the video"));
    const reversed = criticFinalInputSchema.safeParse({
      videoId: VIDEO,
      durationMs: 24000,
      edlSummary: { clips: [] },
      frames: [...frames()].reverse(),
    });
    assert.ok(reversed.error?.issues.some((issue) => issue.message === "frames must be in ascending time order"));
  });

  it("refuses a remote frame URL: only inline image data reaches the model", () => {
    const remote = criticFinalInputSchema.safeParse({
      videoId: VIDEO,
      durationMs: 24000,
      edlSummary: { clips: [] },
      frames: frames().map((frame, index) => (index === 0 ? { ...frame, imageUrl: "https://example.test/frame.png" } : frame)),
    });
    assert.equal(remote.success, false);
  });
});

describe("critic_final answer contract (nine rubric scores and a confidence, nothing else)", () => {
  it("lists the seven slop items and the two craft items, in that order", () => {
    assert.deepEqual([...SLOP_RUBRIC_ITEMS], ["hands", "faces", "anatomy", "physics", "plastic_skin", "morphing_objects", "background_warping"]);
    assert.deepEqual([...CRAFT_RUBRIC_ITEMS], ["captions_legible", "framing_in_safe_area"]);
    assert.equal(FINAL_RUBRIC_ITEMS.length, 9);
  });

  it("accepts the nine scores and a confidence", () => {
    assert.equal(criticFinalAnswerSchema.safeParse({ rubric: goodRubric, confidence: 0.8 }).success, true);
  });

  it("refuses a missing item, an extra key, free text and an out-of-range score", () => {
    const { captions_legible: _dropped, ...missing } = goodRubric;
    assert.equal(criticFinalAnswerSchema.safeParse({ rubric: missing, confidence: 0.8 }).success, false);
    assert.equal(criticFinalAnswerSchema.safeParse({ rubric: { ...goodRubric, extra: 1 }, confidence: 0.8 }).success, false);
    assert.equal(criticFinalAnswerSchema.safeParse({ rubric: goodRubric, confidence: 0.8, note: "looks fine" }).success, false);
    assert.equal(criticFinalAnswerSchema.safeParse({ rubric: { ...goodRubric, hands: 1.2 }, confidence: 0.8 }).success, false);
  });
});

describe("critic_final roles (Bible 11.1: Haiku first, Sonnet when unsure)", () => {
  it("the first call is Haiku on llm.check, the re-check is Sonnet on llm.analysis, both the same role and prompt", () => {
    assert.equal(criticFinal.capability, "llm.check");
    assert.equal(criticFinalRecheck.capability, "llm.analysis");
    assert.equal(criticFinal.role, "critic_final");
    assert.equal(criticFinalRecheck.role, "critic_final");
    assert.deepEqual(criticFinal.prompt, CRITIC_FINAL_PROMPT);
    assert.deepEqual(criticFinalRecheck.prompt, CRITIC_FINAL_PROMPT);
    assert.equal(criticFinal.stage, "post_render_review");
    assert.equal(criticFinal.schemaName, criticFinalRecheck.schemaName);
  });

  it("the output cap equals the output tokens priced in the estimate (Bible 11.1: 1k out)", () => {
    assert.equal(CRITIC_FINAL_MAX_OUTPUT_TOKENS, CRITIC_FINAL_ESTIMATE_TOKENS.output);
    assert.deepEqual(CRITIC_FINAL_ESTIMATE_TOKENS, { input: 15000, output: 1000 });
  });

  it("prices the Sonnet re-check at Sonnet's rate, above the Haiku call", () => {
    const haiku = estimateClaudeUsd("anthropic/claude-haiku-5.5", criticFinal.estimateTokens);
    const sonnet = estimateClaudeUsd("anthropic/claude-sonnet-5.5", criticFinalRecheck.estimateTokens);
    assert.ok(sonnet > haiku, `Sonnet ${sonnet} should cost more than Haiku ${haiku}`);
  });
});

describe("critic_final prompt and user content", () => {
  it("loads version 1 with the four parts of Bible 11.2", () => {
    const prompt = loadPrompt(CRITIC_FINAL_PROMPT);
    assert.equal(prompt.id, "critic_final@1");
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"), `missing ${heading}`);
    }
  });

  it("names every rubric item the answer schema requires, so the prompt and the contract agree", () => {
    const prompt = loadPrompt(CRITIC_FINAL_PROMPT);
    for (const item of FINAL_RUBRIC_ITEMS) {
      assert.ok(prompt.text.includes(`\`${item}\``), `the prompt does not name ${item}`);
    }
  });

  it("sends the block as untrusted data, then twelve labelled images", () => {
    const parts = criticFinalUserContent(validInput());
    const block = parts[1];
    assert.equal(block?.type, "text");
    if (block?.type === "text") {
      assert.match(block.text, /<untrusted-data/);
      assert.match(block.text, /"frameTimesMs"/);
      assert.match(block.text, /"videoId"/);
    }
    assert.equal(parts.filter((part) => part.type === "image_url").length, 12);
    assert.equal(parts.filter((part) => part.type === "text" && /^Frame \d+ at \d+ ms:$/.test(part.text)).length, 12);
  });
});
