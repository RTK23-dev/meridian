import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateClaudeUsd } from "../rates.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import {
  REQUEST_CLASSIFIER_ESTIMATE_TOKENS,
  REQUEST_CLASSIFIER_MAX_OUTPUT_TOKENS,
  REQUEST_CLASSIFIER_PROMPT,
  requestClassifier,
  requestClassifierAnswerSchema,
  requestClassifierInputSchema,
  requestClassifierUserContent,
  type RequestClassifierInput,
} from "./request_classifier.ts";

const INPUT: RequestClassifierInput = requestClassifierInputSchema.parse({
  requests: [
    { index: 0, beatId: "b3", want: "the blender on a clean kitchen counter", strength: "must" },
    { index: 1, beatId: "b1", want: "a woman talking to the camera", strength: "may" },
  ],
});

const good = { classifications: [{ index: 0, properties: ["real_product"] }, { index: 1, properties: ["person_talking"] }] };

describe("request_classifier input contract", () => {
  it("accepts requests whose index is their position", () => {
    assert.equal(INPUT.requests.length, 2);
  });

  it("refuses an index that is not the request's position", () => {
    const result = requestClassifierInputSchema.safeParse({
      requests: [{ index: 3, beatId: "b1", want: "x", strength: "may" }],
    });
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join(".")), ["requests.0.index"]);
  });
});

describe("request_classifier answer contract", () => {
  const answer = requestClassifierAnswerSchema(INPUT);

  it("accepts one classification per request, each with at least one property", () => {
    assert.equal(answer.safeParse(good).success, true);
  });

  it("refuses a request the answer skips, and a request it classifies twice", () => {
    assert.equal(answer.safeParse({ classifications: [{ index: 0, properties: ["real_product"] }] }).success, false);
    assert.equal(
      answer.safeParse({
        classifications: [
          { index: 0, properties: ["real_product"] },
          { index: 0, properties: ["person_talking"] },
        ],
      }).success,
      false,
    );
  });

  it("refuses an index the input does not have, an empty property list, and a property outside the list", () => {
    assert.equal(answer.safeParse({ classifications: [...good.classifications, { index: 7, properties: ["text_led"] }] }).success, false);
    assert.equal(answer.safeParse({ classifications: [{ index: 0, properties: [] }, { index: 1, properties: ["text_led"] }] }).success, false);
    assert.equal(answer.safeParse({ classifications: [{ index: 0, properties: ["fashion"] }, { index: 1, properties: ["text_led"] }] }).success, false);
  });

  it("refuses prose: an extra key is not part of the contract, so a reason never reaches a gate", () => {
    assert.equal(answer.safeParse({ ...good, reason: "the product is clearly visible" }).success, false);
    assert.equal(
      answer.safeParse({ classifications: [{ index: 0, properties: ["real_product"], note: "x" }, { index: 1, properties: ["text_led"] }] }).success,
      false,
    );
  });

  it("is sent to the model as a strict JSON schema", () => {
    const schema = jsonSchemaFor(requestClassifierAnswerSchema(INPUT)) as { additionalProperties?: boolean; required?: string[] };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["classifications"]);
  });
});

describe("request_classifier role", () => {
  it("is a check call (Haiku) on prompt version 1, with its output cap equal to the priced output", () => {
    assert.equal(requestClassifier.role, "request_classifier");
    assert.equal(requestClassifier.capability, "llm.check");
    assert.deepEqual(requestClassifier.prompt, REQUEST_CLASSIFIER_PROMPT);
    assert.equal(requestClassifier.maxOutputTokens, REQUEST_CLASSIFIER_MAX_OUTPUT_TOKENS);
    assert.equal(requestClassifier.estimateTokens.output, REQUEST_CLASSIFIER_ESTIMATE_TOKENS.output);
  });

  it("prices one call at Haiku's rate: 1k in and 0.3k out is $0.0025", () => {
    assert.equal(estimateClaudeUsd("anthropic/claude-haiku-5.5", requestClassifier.estimateTokens), 0.0025);
  });

  it("loads prompt request_classifier@1 with the four parts of Bible 11.2 and the property list", () => {
    const prompt = loadPrompt(REQUEST_CLASSIFIER_PROMPT);
    assert.equal(prompt.id, "request_classifier@1");
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"), `missing ${heading}`);
    }
    assert.match(prompt.text, /`real_product`/);
  });

  it("pins the bytes of request_classifier@1: an edit is a new version (Bible 11.3)", () => {
    assert.equal(loadPrompt(REQUEST_CLASSIFIER_PROMPT).fileHash, "sha256:567d27cca05d228d946923db7bf63856b79077e7dc25caa7159864caa1e64d49");
  });

  it("sends the requests as one untrusted data block", () => {
    const parts = requestClassifierUserContent(INPUT);
    const block = parts.find((part) => part.type === "text" && part.text.includes('<untrusted-data name="requests">'));
    assert.ok(block);
  });
});
