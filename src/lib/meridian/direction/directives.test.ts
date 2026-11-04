import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../../../engine/contracts/hash.ts";
import { COOKBOOK_INSTRUCTION_ROLES, COOKBOOK_INSTRUCTIONS_MAX, cookbookRefSchema } from "../../../engine/contracts/request.ts";
import { instructionSchema } from "../cookbooks/schema.ts";
import { DIRECTION_CODEX_VERSION } from "./codex.ts";
import { DIRECTION_BUDGETS, PIPELINE_DIRECTIVE_CHARS, ROLE_TEXT_MAX, directionDirectives, directiveHeader, withDirection } from "./directives.ts";

test("every role's direction fits its budget, starts with the header and names the codex version", () => {
  const total = Object.values(DIRECTION_BUDGETS).reduce((sum, budget) => sum + budget, 0);
  assert.ok(total <= COOKBOOK_INSTRUCTIONS_MAX, `the default budgets sum to ${total}`);
  for (const role of COOKBOOK_INSTRUCTION_ROLES) {
    const text = directionDirectives(role, { format: "story", hookFamily: "story_cliff", niche: "finance" });
    assert.ok(text.length <= DIRECTION_BUDGETS[role], `${role}: ${text.length} characters`);
    assert.ok(text.startsWith(directiveHeader()), role);
    assert.ok(text.includes(DIRECTION_CODEX_VERSION), role);
    assert.ok(text.split("\n").length > 2, `${role} carries at least two rules`);
    assert.equal(instructionSchema.safeParse({ role, text }).success, true, `${role} is a valid cookbook instruction`);
  }
});

test("the script direction is deterministic, leads with the trust rules, and carries the chosen format and hook family", () => {
  const options = { format: "test_experiment" as const, hookFamily: "challenge_test" as const, niche: "tech" as const };
  const text = directionDirectives("script", options);
  assert.equal(text, directionDirectives("script", options));
  const lines = text.split("\n").slice(1);
  assert.match(lines[0] ?? "", /Never invent a claim/);
  assert.ok(text.includes("Format: Challenge or test."));
  assert.ok(text.includes("Hook family: Test or challenge."));
  assert.ok(text.includes("For this niche, watch for: Spec lists"));
});

test("a small budget drops whole rules, never part of one", () => {
  const full = directionDirectives("script");
  const small = directionDirectives("script", {}, 600);
  assert.ok(small.length <= 600);
  for (const line of small.split("\n").slice(1)) assert.ok(full.includes(line), `"${line}" is a whole line of the full text`);
});

test("direction is added under a cookbook's own instructions and stays inside the engine's limits", () => {
  const own = { script: "Keep the cookbook's three cases in order.".repeat(20), critic: "Check the cases are in order." };
  const merged = withDirection(own, { format: "listicle" });
  assert.ok(merged.script?.startsWith(own.script), "the cookbook's own text comes first, whole");
  assert.ok(merged.critic?.startsWith(own.critic));
  for (const role of COOKBOOK_INSTRUCTION_ROLES) assert.ok((merged[role]?.length ?? 0) <= ROLE_TEXT_MAX, role);
  const total = Object.values(merged).reduce((sum, text) => sum + (text?.length ?? 0), 0);
  assert.ok(total <= COOKBOOK_INSTRUCTIONS_MAX, `the total is ${total}`);
  const ref = cookbookRefSchema.safeParse({ id: "ck_direction_test", version: 1, valuesHash: contentHash({}), instructions: merged });
  assert.equal(ref.success, true, "the merged instructions are a valid cookbook reference for a request");
});

test("a role whose own text leaves no room gets no direction, rather than a fragment", () => {
  const own = { script: "x".repeat(ROLE_TEXT_MAX - 50) };
  const merged = withDirection(own, { roles: ["script"] });
  assert.equal(merged.script, own.script);
});

test("the total stays under the engine's limit even when the cookbook already uses most of it", () => {
  const own = { script: "a".repeat(3900), plan: "b".repeat(3900), visual: "c".repeat(3900), voice: "d".repeat(3000) };
  const merged = withDirection(own);
  const total = Object.values(merged).reduce((sum, text) => sum + (text?.length ?? 0), 0);
  assert.ok(total <= COOKBOOK_INSTRUCTIONS_MAX, `the total is ${total}`);
  assert.equal(merged.script, own.script);
});

test("the video's own context comes right after the trust rules, so the engine's 4,000 characters keep it", () => {
  const text = directionDirectives("script", { format: "s_tier_ranking", hookFamily: "contrarian", job: "convert" });
  assert.ok(text.length <= 4000);
  assert.ok(text.includes("Format: S-tier ranking."), "the format survives the cookbook budget");
  assert.ok(text.includes("This video's job is to convert"));
  const lines = text.split("\n");
  const formatAt = lines.findIndex((line) => line.includes("Format: S-tier ranking."));
  const tripleAt = lines.findIndex((line) => line.includes("Triple hook"));
  assert.ok(formatAt > 0 && (tripleAt === -1 || formatAt < tripleAt));
});

test("the pipeline's own prompts carry more of the codex than the engine's cookbook budget allows", () => {
  const cookbook = directionDirectives("script", { job: "reach" });
  const pipeline = directionDirectives("script", { job: "reach" }, PIPELINE_DIRECTIVE_CHARS);
  assert.ok(pipeline.length > cookbook.length);
  for (const phrase of ["Zig-zag", "villain", "Saves turn into follows"]) assert.ok(pipeline.includes(phrase), phrase);
  assert.ok(directionDirectives("voice").includes("20% more powerfully"), "the voice role carries the delivery rule");
  assert.match(directionDirectives("agent", {}, PIPELINE_DIRECTIVE_CHARS), /one job/i);
});
