import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateClaudeUsd } from "../rates.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import {
  PLANNER_ESTIMATE_TOKENS,
  PLANNER_MAX_OUTPUT_TOKENS,
  PLANNER_PROMPT,
  planner,
  plannerAnswerSchema,
  plannerInputSchema,
  plannerUserContent,
  type PlannerInput,
} from "./planner.ts";

const ASKED = {
  prompt: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
  both: "shot_01JABCDEFGHJKMNPQRSTVWX1Z0",
  query: "shot_01JABCDEFGHJKMNPQRSTVWX2Z0",
};

function input(): PlannerInput {
  const shot = (shotId: string, prompt: boolean, query: boolean) => ({
    shotId,
    durationMs: 2000,
    beatRole: "item" as const,
    wants: ["the product on a clean counter"],
    candidates: prompt && query ? (["product_hero", "stock_footage"] as const) : prompt ? (["product_hero"] as const) : (["stock_footage"] as const),
    prompt,
    query,
    showsProduct: false,
    pinnedFrame: false,
  });
  return plannerInputSchema.parse({
    style: { palette: { primary: "#1B1B1B" }, motionIntensity: 2 },
    characters: [],
    productColours: ["black"],
    shots: [shot(ASKED.prompt, true, false), shot(ASKED.both, true, true), shot(ASKED.query, false, true)],
  });
}

const good = {
  shots: [
    { shotId: ASKED.prompt, prompt: "Slow push-in on a clean counter, soft light, no text in frame." },
    { shotId: ASKED.both, prompt: "Side pan on a counter, no text in frame.", query: "kitchen counter" },
    { shotId: ASKED.query, query: "clean kitchen" },
  ],
};

describe("planner input contract", () => {
  it("accepts a shot that needs a prompt or a query, and refuses one that needs neither", () => {
    assert.equal(input().shots.length, 3);
    const neither = plannerInputSchema.safeParse({
      style: { palette: {}, motionIntensity: 0 },
      characters: [],
      productColours: [],
      shots: [{ shotId: ASKED.prompt, durationMs: 2000, beatRole: "item", wants: [], candidates: ["coded_graphics"], prompt: false, query: false, showsProduct: false, pinnedFrame: false }],
    });
    assert.equal(neither.success, false);
  });

  it("has no field for the script's words: the input describes shots by their facts and the viewer's requests only", () => {
    const shotKeys = Object.keys(input().shots[0]).sort();
    assert.deepEqual(shotKeys, ["beatRole", "candidates", "durationMs", "pinnedFrame", "prompt", "query", "shotId", "showsProduct", "wants"]);
  });
});

describe("planner answer contract", () => {
  const answer = plannerAnswerSchema(input());

  it("accepts every asked-for text, each shot once", () => {
    assert.equal(answer.safeParse(good).success, true);
  });

  it("refuses a shot the input does not ask for, a repeated shot, and a shot left out", () => {
    assert.equal(answer.safeParse({ shots: [...good.shots, { shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZZ", prompt: "x" }] }).success, false);
    assert.equal(answer.safeParse({ shots: [...good.shots, good.shots[0]] }).success, false);
    assert.equal(answer.safeParse({ shots: good.shots.slice(1) }).success, false);
  });

  it("refuses a missing prompt or query the input asks for", () => {
    assert.equal(answer.safeParse({ shots: [{ shotId: ASKED.prompt }, good.shots[1], good.shots[2]] }).success, false);
    assert.equal(answer.safeParse({ shots: [good.shots[0], good.shots[1], { shotId: ASKED.query }] }).success, false);
  });

  it("refuses a prompt that asks for text, a sign, a logo or a price to be drawn, and says so by path, not by the words", () => {
    const withSign = { shots: [{ shotId: ASKED.prompt, prompt: "A sign reading OPEN in the window." }, good.shots[1], good.shots[2]] };
    const result = answer.safeParse(withSign);
    assert.equal(result.success, false);
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join(".")), ["shots.0.prompt"]);
    assert.equal(result.error?.issues[0]?.message.includes("OPEN"), false, "the issue never repeats the model's words");
    const withPrice = { shots: [{ shotId: ASKED.prompt, prompt: "A price tag of $19 on the counter." }, good.shots[1], good.shots[2]] };
    assert.equal(answer.safeParse(withPrice).success, false);
  });

  it("accepts a prompt that says there is no text in frame", () => {
    assert.equal(answer.safeParse(good).success, true);
  });

  it("refuses an answer with a free-text key, at the top or inside a shot: the answer is data for the next stage", () => {
    assert.equal(answer.safeParse({ ...good, notes: "the counter looks clean" }).success, false);
    assert.equal(answer.safeParse({ shots: [{ ...good.shots[0], notes: "clean" }, good.shots[1], good.shots[2]] }).success, false);
  });

  it("is sent to the model as a JSON schema for the shot list", () => {
    const schema = jsonSchemaFor(plannerAnswerSchema(input())) as { required?: string[] };
    assert.deepEqual(schema.required, ["shots"]);
  });
});

describe("planner role", () => {
  it("is a direction call (Opus) on prompt version 1, with its output cap equal to the priced output", () => {
    assert.equal(planner.role, "planner");
    assert.equal(planner.capability, "llm.direction");
    assert.deepEqual(planner.prompt, PLANNER_PROMPT);
    assert.equal(planner.maxOutputTokens, PLANNER_MAX_OUTPUT_TOKENS);
    assert.equal(planner.estimateTokens.output, PLANNER_ESTIMATE_TOKENS.output);
  });

  it("prices one call at Opus's rate: 20k in and 4k out is $0.16", () => {
    assert.equal(estimateClaudeUsd("anthropic/claude-opus-5.5", planner.estimateTokens), 0.16);
  });

  it("loads prompt planner@1 with the four parts of Bible 11.2", () => {
    const prompt = loadPrompt(PLANNER_PROMPT);
    assert.equal(prompt.id, "planner@1");
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"), `missing ${heading}`);
    }
  });

  it("pins the bytes of planner@1: an edit is a new version (Bible 11.3)", () => {
    assert.equal(loadPrompt(PLANNER_PROMPT).fileHash, "sha256:608e613e2b7b323a7cb7945ccddc1289a7eb3204caf290626f274f936235a2cc");
  });

  it("sends the plan as one untrusted data block", () => {
    const parts = plannerUserContent(input());
    assert.ok(parts.some((part) => part.type === "text" && part.text.includes('<untrusted-data name="plan">')));
  });
});
