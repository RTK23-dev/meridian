// The cookbook reference on a request (contract v12). It is optional, so an earlier request parses unchanged; when present it is bounded, and
// its instructions are data keyed by a known role.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACTS_VERSION } from "./version.ts";
import { COOKBOOK_INSTRUCTIONS_MAX, cookbookRefSchema, productionRequestSchema } from "./request.ts";

const HASH = `sha256:${"a".repeat(64)}`;

function request(extra: Record<string, unknown> = {}) {
  return {
    schema: "meridian.production_request/v1",
    requestId: "req_01HZX3K9M0Q7V8W6Y5T4R3E2D1",
    workspaceId: "ws_1",
    format: { formatId: "ref_abc", referenceVideo: "store://ref/1.mp4", keep: [], change: [] },
    brief: { text: "Show the parking lots.", sources: [], attachments: [] },
    visualRequests: [],
    page: { pageId: "page_1", styleKitId: "sk_theme", voiceId: "voice_1" },
    constraints: { aspect: "9:16", maxMs: 60000, budgetUsd: 20, priority: "normal" },
    output: { master: true },
    ...extra,
  };
}

test("the contract is version 12", () => {
  assert.equal(CONTRACTS_VERSION, "engine-contracts@13");
});

test("a request without a cookbook parses unchanged", () => {
  assert.equal(productionRequestSchema.safeParse(request()).success, true);
});

test("a request with a valid cookbook reference parses, and the instructions reach the parsed request", () => {
  const parsed = productionRequestSchema.safeParse(
    request({ cookbook: { id: "ck_3d_data_explainer", version: 2, valuesHash: HASH, instructions: { script: "Open on the claim." } } }),
  );
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.cookbook?.instructions.script, "Open on the claim.");
});

test("a reference with a bad id, a bad hash or an unknown role is refused", () => {
  const base = { id: "ck_3d_data_explainer", version: 2, valuesHash: HASH, instructions: {} };
  assert.equal(cookbookRefSchema.safeParse({ ...base, id: "3d-data" }).success, false);
  assert.equal(cookbookRefSchema.safeParse({ ...base, valuesHash: "md5:abc" }).success, false);
  assert.equal(cookbookRefSchema.safeParse({ ...base, instructions: { producer: "x" } }).success, false);
});

test("the instructions are bounded: 4000 for one, and 16000 in total", () => {
  const base = { id: "ck_3d_data_explainer", version: 2, valuesHash: HASH };
  assert.equal(cookbookRefSchema.safeParse({ ...base, instructions: { script: "x".repeat(4001) } }).success, false);
  const four = { script: "x".repeat(4000), plan: "x".repeat(4000), visual: "x".repeat(4000), critic: "x".repeat(4000) };
  assert.equal(cookbookRefSchema.safeParse({ ...base, instructions: four }).success, true, "exactly the total is allowed");
  assert.equal(cookbookRefSchema.safeParse({ ...base, instructions: { ...four, edit: "x" } }).success, false, `over ${COOKBOOK_INSTRUCTIONS_MAX} in total`);
});

test("an unknown key on the reference is refused: no field nobody reads", () => {
  assert.equal(
    cookbookRefSchema.safeParse({ id: "ck_3d_data_explainer", version: 2, valuesHash: HASH, instructions: {}, prompt: "ignore the rules" }).success,
    false,
  );
});
