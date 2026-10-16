import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { estimateClaudeUsd } from "../rates.ts";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import { loadPrompt } from "../../prompts/load.ts";
import {
  CRITIC_TAKE_ESTIMATE_TOKENS,
  CRITIC_TAKE_MAX_OUTPUT_TOKENS,
  CRITIC_TAKE_PROMPT,
  SLOP_RUBRIC_ITEMS,
  criticTake,
  criticTakeAnswerSchema,
  criticTakeInputSchema,
  criticTakeUserContent,
  type CriticTakeInput,
} from "./critic_take.ts";

const FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function frames(count: number, times: number[] = [500, 1200, 1900, 2600, 3300, 4000]) {
  return times.slice(0, count).map((atMs) => ({ atMs, imageUrl: FRAME }));
}

function validInput(): CriticTakeInput {
  return criticTakeInputSchema.parse({
    shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
    visualType: "product_hero",
    durationMs: 4100,
    frames: frames(6),
  });
}

const goodRubric = { hands: 0.9, faces: 0.9, anatomy: 0.9, physics: 0.9, plastic_skin: 0.9, morphing_objects: 0.9, background_warping: 0.9 };

describe("critic_take input contract", () => {
  it("accepts six frames inside the take, in time order", () => {
    assert.equal(validInput().frames.length, thresholds.take.rubricFrames);
  });

  it("refuses a frame count other than the rubric count (Bible 6.7: six frames)", () => {
    const five = criticTakeInputSchema.safeParse({ shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0", visualType: "product_hero", durationMs: 4100, frames: frames(5) });
    assert.equal(five.success, false);
    const seven = criticTakeInputSchema.safeParse({
      shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
      visualType: "product_hero",
      durationMs: 9000,
      frames: [...frames(6), { atMs: 4500, imageUrl: FRAME }],
    });
    assert.equal(seven.success, false);
  });

  it("refuses a frame at or after the end of the take, and frames out of order", () => {
    const pastEnd = criticTakeInputSchema.safeParse({
      shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
      visualType: "product_hero",
      durationMs: 4000,
      frames: frames(6),
    });
    assert.deepEqual(
      pastEnd.error?.issues.map((issue) => issue.path.join(".")),
      ["frames.5.atMs"],
    );
    const reversed = criticTakeInputSchema.safeParse({
      shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
      visualType: "product_hero",
      durationMs: 4100,
      frames: [...frames(6)].reverse(),
    });
    assert.ok(reversed.error?.issues.some((issue) => issue.message === "frames must be in ascending time order"));
  });

  it("refuses a remote frame URL, so the model's host never fetches anything", () => {
    const result = criticTakeInputSchema.safeParse({
      shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
      visualType: "product_hero",
      durationMs: 4100,
      frames: [{ atMs: 500, imageUrl: "https://example.com/frame.png" }, ...frames(6).slice(1)],
    });
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join(".")), ["frames.0.imageUrl"]);
  });
});

describe("critic_take answer contract", () => {
  it("accepts the seven rubric scores and a confidence, each from 0 to 1", () => {
    assert.equal(criticTakeAnswerSchema.safeParse({ rubric: goodRubric, confidence: 0.9 }).success, true);
  });

  it("has exactly the seven rubric items of Bible 12.2", () => {
    assert.deepEqual([...SLOP_RUBRIC_ITEMS], [
      "hands",
      "faces",
      "anatomy",
      "physics",
      "plastic_skin",
      "morphing_objects",
      "background_warping",
    ]);
    const missing = { ...goodRubric } as Partial<typeof goodRubric>;
    delete missing.hands;
    const result = criticTakeAnswerSchema.safeParse({ rubric: missing, confidence: 0.9 });
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join(".")), ["rubric.hands"]);
  });

  it("refuses a score outside 0 to 1, a text score and an unknown key", () => {
    assert.equal(criticTakeAnswerSchema.safeParse({ rubric: { ...goodRubric, faces: 1.2 }, confidence: 0.9 }).success, false);
    assert.equal(criticTakeAnswerSchema.safeParse({ rubric: { ...goodRubric, faces: "high" }, confidence: 0.9 }).success, false);
    assert.equal(criticTakeAnswerSchema.safeParse({ rubric: goodRubric, confidence: 0.9, notes: "looks fine" }).success, false);
    assert.equal(criticTakeAnswerSchema.safeParse({ rubric: { ...goodRubric, extra: 0.5 }, confidence: 0.9 }).success, false);
  });

  it("is sent to the model as a strict JSON schema, with every rubric key required", () => {
    const schema = jsonSchemaFor(criticTakeAnswerSchema) as { additionalProperties?: boolean; required?: string[] };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...(schema.required ?? [])].sort(), ["confidence", "rubric"]);
    assert.doesNotMatch(JSON.stringify(schema), /"notes"/);
  });
});

describe("critic_take role", () => {
  it("is a check call (Haiku) on prompt version 1, reading the take's frames", () => {
    assert.equal(criticTake.role, "critic_take");
    assert.equal(criticTake.capability, "llm.check");
    assert.equal(criticTake.stage, "check_take");
    assert.deepEqual(criticTake.prompt, CRITIC_TAKE_PROMPT);
  });

  it("prices one call at Haiku's rate: 8k in and 0.5k out is $0.0105, and the output cap matches the estimate", () => {
    assert.equal(criticTake.maxOutputTokens, CRITIC_TAKE_MAX_OUTPUT_TOKENS);
    assert.equal(criticTake.estimateTokens.output, CRITIC_TAKE_ESTIMATE_TOKENS.output);
    assert.equal(estimateClaudeUsd("anthropic/claude-haiku-5.5", criticTake.estimateTokens), 0.0105);
  });

  it("loads prompt critic_take@1 with the four parts of Bible 11.2", () => {
    const prompt = loadPrompt(CRITIC_TAKE_PROMPT);
    assert.equal(prompt.id, "critic_take@1");
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"), `missing ${heading}`);
    }
    for (const item of SLOP_RUBRIC_ITEMS) {
      assert.match(prompt.text, new RegExp(`\`${item}\``), `the prompt does not name ${item}`);
    }
  });

  it("sends the take as an untrusted block and each frame as an image, in order, with its time", () => {
    const input = validInput();
    const parts = criticTakeUserContent(input);
    const block = parts.find((part) => part.type === "text" && part.text.includes('<untrusted-data name="take">'));
    assert.ok(block && block.type === "text");
    assert.match(block.text, /"frameTimesMs":\[500,1200,1900,2600,3300,4000\]/);
    const images = parts.filter((part) => part.type === "image_url");
    assert.equal(images.length, 6);
    const labels = parts.filter((part) => part.type === "text" && /^Frame \d+ at/.test(part.text));
    assert.equal(labels.length, 6);
    assert.equal(labels[0]?.type === "text" ? labels[0].text : "", "Frame 1 at 500 ms:");
  });

  it("keeps a free-text field out of the answer, so no model prose reaches a retry or a review item", () => {
    assert.doesNotMatch(criticTake.retryRule, /notes|explanation|reason/i);
  });
});
