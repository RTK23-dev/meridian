import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateClaudeUsd } from "../rates.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import {
  DIRECTOR_CHECK_ESTIMATE_TOKENS,
  DIRECTOR_CHECK_MAX_OUTPUT_TOKENS,
  DIRECTOR_CHECK_PROMPT,
  directorCheck,
  directorCheckAnswerSchema,
  directorCheckInputSchema,
  directorCheckUserContent,
} from "./director_check.ts";

const SHOT_ID = "shot_01JABCDEFGHJKMNPQRSTVWXYZ0";

const INPUT = directorCheckInputSchema.parse({
  requestBudgetUsd: 4,
  reservedUsd: 0.9595,
  genome: { hook_mechanism: "claim in the first second" },
  persona: { description: "Late-20s home cook" },
  shots: [
    {
      shotId: SHOT_ID,
      beatRole: "hook",
      durationMs: 3000,
      visualType: "ugc_presenter",
      candidates: ["ugc_presenter", "kinetic_type"],
      generated: true,
      prompt: "Home cook, relaxed, no text in frame.",
      showsProduct: false,
    },
  ],
});

const good = { ok: true, swaps: [{ shotId: SHOT_ID, toType: "kinetic_type" }], promptEdits: [] };

describe("director_check input contract", () => {
  it("accepts the plan table with its genome and persona", () => {
    assert.equal(INPUT.shots.length, 1);
  });

  it("refuses a shot with a type outside the catalogue", () => {
    const result = directorCheckInputSchema.safeParse({
      ...INPUT,
      shots: [{ ...INPUT.shots[0], visualType: "fashion_show" }],
    });
    assert.equal(result.success, false);
  });
});

describe("director_check answer contract", () => {
  it("accepts the three keys, with any shot id and any type name (the plan checks them against its own shots)", () => {
    assert.equal(directorCheckAnswerSchema.safeParse(good).success, true);
    assert.equal(
      directorCheckAnswerSchema.safeParse({ ok: false, swaps: [{ shotId: "shot_unknown", toType: "banana" }], promptEdits: [] }).success,
      true,
    );
  });

  it("refuses any key other than ok, swaps and promptEdits, so no reason or note reaches a Decision", () => {
    assert.equal(directorCheckAnswerSchema.safeParse({ ...good, reason: "the presenter reads better" }).success, false);
    assert.equal(
      directorCheckAnswerSchema.safeParse({ ...good, swaps: [{ shotId: SHOT_ID, toType: "kinetic_type", reason: "clearer" }] }).success,
      false,
    );
  });

  it("refuses a missing key and a non-boolean verdict", () => {
    assert.equal(directorCheckAnswerSchema.safeParse({ swaps: [], promptEdits: [] }).success, false);
    assert.equal(directorCheckAnswerSchema.safeParse({ ok: "yes", swaps: [], promptEdits: [] }).success, false);
  });

  it("is sent to the model as a strict JSON schema with exactly the three keys", () => {
    const schema = jsonSchemaFor(directorCheckAnswerSchema) as { additionalProperties?: boolean; required?: string[] };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...(schema.required ?? [])].sort(), ["ok", "promptEdits", "swaps"]);
  });
});

describe("director_check role", () => {
  it("is a direction call (Opus) on prompt version 1, with its output cap equal to the priced output", () => {
    assert.equal(directorCheck.role, "director_check");
    assert.equal(directorCheck.capability, "llm.direction");
    assert.deepEqual(directorCheck.prompt, DIRECTOR_CHECK_PROMPT);
    assert.equal(directorCheck.maxOutputTokens, DIRECTOR_CHECK_MAX_OUTPUT_TOKENS);
    assert.equal(directorCheck.estimateTokens.output, DIRECTOR_CHECK_ESTIMATE_TOKENS.output);
  });

  it("prices one call at Opus's rate: 8k in and 1k out is $0.052", () => {
    assert.equal(estimateClaudeUsd("anthropic/claude-opus-5.5", directorCheck.estimateTokens), 0.052);
  });

  it("loads prompt director_check@1 with the four parts of Bible 11.2", () => {
    const prompt = loadPrompt(DIRECTOR_CHECK_PROMPT);
    assert.equal(prompt.id, "director_check@1");
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"), `missing ${heading}`);
    }
  });

  it("pins the bytes of director_check@1: an edit is a new version (Bible 11.3)", () => {
    assert.equal(loadPrompt(DIRECTOR_CHECK_PROMPT).fileHash, "sha256:60e86b7829527b43bceb0d74adce5f0511c81251caa410e7d1c09f6e6cde4a79");
  });

  it("sends the plan table as one untrusted data block", () => {
    const parts = directorCheckUserContent(INPUT);
    assert.ok(parts.some((part) => part.type === "text" && part.text.includes('<untrusted-data name="plan">')));
  });
});
