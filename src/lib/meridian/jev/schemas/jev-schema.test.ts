import assert from "node:assert/strict";
import test from "node:test";
import { creativeJudgmentResponseSchemaV1 } from "./creative-judgment.v1.ts";
import { creativeReviewResponseSchemaV1 } from "./creative-review.v1.ts";
import { validateJevModelResponse, JevValidationError } from "./validation.ts";

test("validateJevModelResponse: parses valid creative judgment response and generates hashes", () => {
  const validJson = JSON.stringify({
    decision: "APPROVE",
    creativeMechanism: "3-step visual demo",
    recommendedFormats: [
      { format: "carousel", rationale: "Progressive disclosure", priority: 1 },
    ],
    formatSuitability: {
      carousel: { suitable: true, rationale: "Progressive disclosure" },
      image: { suitable: false, rationale: "Too static" },
      video: { suitable: true, rationale: "Video works well" },
    },
    conceptStrengthScore: 0.92,
    evidenceRefs: ["ev-1", "ev-2"],
  });

  const result = validateJevModelResponse(
    creativeJudgmentResponseSchemaV1,
    validJson,
    {
      inputText: "User brief input prompt",
      questionVersion: "v1.2",
      schemaVersion: "creative-judgment.v1",
      provider: "typesafe_direct",
      model: "gemini-2.5-flash",
    }
  );

  assert.equal(result.data.decision, "APPROVE");
  assert.equal(result.data.creativeMechanism, "3-step visual demo");
  assert.equal(result.data.recommendedFormats.length, 1);
  assert.equal(result.provenance.schemaVersion, "creative-judgment.v1");
  assert.ok(result.provenance.inputHash.length === 64, "Input hash must be SHA-256");
  assert.ok(result.provenance.responseHash.length === 64, "Response hash must be SHA-256");
});

test("validateJevModelResponse: rejects malformed JSON with JevValidationError", () => {
  assert.throws(
    () => {
      validateJevModelResponse(
        creativeJudgmentResponseSchemaV1,
        "{ malformed json string without close bracket",
        {
          questionVersion: "v1",
          schemaVersion: "creative-judgment.v1",
          provider: "typesafe_direct",
          model: "gemini-2.5-flash",
        }
      );
    },
    (err: any) => {
      assert.ok(err instanceof JevValidationError);
      assert.match(err.message, /Malformed JEV JSON syntax/);
      return true;
    }
  );
});

test("validateJevModelResponse: rejects semantically incomplete responses", () => {
  // Missing creativeMechanism and recommendedFormats
  const incompleteJson = JSON.stringify({
    decision: "APPROVE",
    conceptStrengthScore: 0.9,
  });

  assert.throws(
    () => {
      validateJevModelResponse(
        creativeJudgmentResponseSchemaV1,
        incompleteJson,
        {
          questionVersion: "v1",
          schemaVersion: "creative-judgment.v1",
          provider: "typesafe_direct",
          model: "gemini-2.5-flash",
        }
      );
    },
    (err: any) => {
      assert.ok(err instanceof JevValidationError);
      assert.match(err.message, /failed schema validation/);
      return true;
    }
  );
});

test("validateJevModelResponse: validates creative review responses", () => {
  const validReview = JSON.stringify({
    decision: "APPROVE",
    checks: {
      claimsVerified: true,
      originalityPassed: true,
      rightsCleared: true,
      craftAndSlopPassed: true,
    },
    violations: [],
    reasons: ["Meets all standards"],
  });

  const res = validateJevModelResponse(
    creativeReviewResponseSchemaV1,
    validReview,
    {
      questionVersion: "v1",
      schemaVersion: "creative-review.v1",
      provider: "typesafe_direct",
      model: "gemini-2.5-flash",
    }
  );

  assert.equal(res.data.decision, "APPROVE");
  assert.equal(res.data.checks.claimsVerified, true);
});
