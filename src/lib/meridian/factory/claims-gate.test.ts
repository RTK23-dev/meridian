import assert from "node:assert/strict";
import test from "node:test";
import { claimsGate } from "./gates.ts";
import { recordedClaimsOf } from "./template.ts";
import { executeFactoryJob, variantGateVerdicts } from "./worker.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";

test("the claims check never passes without claim text: missing or empty claims are review", () => {
  assert.equal(claimsGate({ claims: null, approvedClaims: ["washes hands"], bannedWords: ["cure"] }).result, "review");
  assert.equal(claimsGate({ claims: [], approvedClaims: ["washes hands"], bannedWords: ["cure"] }).result, "review");
  assert.equal(claimsGate({ claims: ["   "], approvedClaims: ["washes hands"], bannedWords: [] }).result, "review");
});

test("recorded claims are checked: an approved claim passes, an unapproved claim and a banned word block", () => {
  assert.equal(claimsGate({ claims: ["Washes hands"], approvedClaims: ["washes hands"], bannedWords: [] }).result, "pass");
  assert.equal(claimsGate({ claims: ["cures eczema"], approvedClaims: ["washes hands"], bannedWords: [] }).result, "block");
  assert.equal(claimsGate({ claims: ["washes hands and may cure"], approvedClaims: ["washes hands and may cure"], bannedWords: ["cure"] }).result, "block");
});

test("the storyboard's recorded claims are read only when a list of text is present", () => {
  assert.equal(recordedClaimsOf(JSON.stringify({ schema: "meridian.storyboard.v1", beats: [] })), null);
  assert.equal(recordedClaimsOf(JSON.stringify({ claims: [] })), null);
  assert.equal(recordedClaimsOf(JSON.stringify({ claims: ["  ", 4] })), null);
  assert.deepEqual(recordedClaimsOf(JSON.stringify({ claims: ["washes hands"] })), ["washes hands"]);
  assert.equal(recordedClaimsOf("not json"), null);
  assert.equal(recordedClaimsOf(""), null);
});

/**
 * A stub database for the gate job. It answers the run lookup, the kill-switch lookup and the brand's product claims, and it
 * returns the variants given. It records the gate result written to each variant.
 */
function gateDatabase(variants: Array<{ id: string; storyboard: string | null }>, productClaims: { allowed: string; prohibited: string }) {
  const gateWrites: Array<{ id: string; result: string }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("select id, status, niche, level from factory_runs")) {
      return [{ id: "run-1", status: "running", niche: "skincare", level: 3 }];
    }
    if (text.includes("from factory_kill_switches")) return [];
    if (text.includes("from products p")) return [{ allowed_claims: productClaims.allowed, prohibited_claims: productClaims.prohibited }];
    if (text.includes("from factory_variants v")) return variants;
    if (text.includes("update factory_variants set gate_result")) {
      gateWrites.push({ id: String(values[1]), result: String(values[0]) });
      return [];
    }
    return [];
  }) as unknown as Sql;
  return { sql, gateWrites };
}

const GATE_JOB: ExecutableJob = {
  id: "job-gate",
  organization_id: "org-1",
  brand_id: "brand-1",
  job_type: "factory.gate",
  payload: JSON.stringify({ runId: "run-1" }),
  attempts: 0,
  max_attempts: 3,
};

test("the claims verdict follows the recorded claim text: block for a banned or unapproved claim, review for none, pass for an approved one", () => {
  const rules = { approved: ["Washes hands daily"], banned: ["cures"] };
  const claimsOf = (storyboard: string | null) => variantGateVerdicts({ storyboard, rules }).find((verdict) => verdict.gate === "claims");
  assert.equal(claimsOf(JSON.stringify({ claims: ["This cures eczema"] }))?.result, "block");
  assert.equal(claimsOf(JSON.stringify({ claims: ["Lasts a year"] }))?.result, "block");
  assert.equal(claimsOf(JSON.stringify({ schema: "meridian.storyboard.v1", beats: [] }))?.result, "review");
  assert.equal(claimsOf(null)?.result, "review");
  assert.equal(claimsOf(JSON.stringify({ claims: ["Washes hands daily"] }))?.result, "pass");
});

test("the gate job blocks a variant with a banned recorded claim and never passes a variant without claim text", async () => {
  // Rights evidence is not recorded by this job, so every variant is blocked by the rights check. The claims check is
  // verified above. Here the job must still never write a pass for a variant with no claim text.
  const { sql, gateWrites } = gateDatabase(
    [
      { id: "v-banned", storyboard: JSON.stringify({ claims: ["This cures eczema"] }) },
      { id: "v-no-claims", storyboard: JSON.stringify({ schema: "meridian.storyboard.v1", beats: [] }) },
    ],
    { allowed: "Washes hands daily", prohibited: "cures" },
  );
  assert.equal(await executeFactoryJob(sql, GATE_JOB, { runId: "run-1" }), "gated:2");
  const byId = new Map(gateWrites.map((write) => [write.id, write.result]));
  assert.equal(byId.get("v-banned"), "block", "a recorded banned claim blocks the variant");
  assert.notEqual(byId.get("v-no-claims"), "pass", "a variant with no recorded claim text is never passed");
  assert.equal([...byId.values()].includes("pass"), false);
});

test("the gate job checks a recorded claim that is not on the brand's approved list", async () => {
  const { sql, gateWrites } = gateDatabase(
    [{ id: "v-unapproved", storyboard: JSON.stringify({ claims: ["Lasts a year"] }) }],
    { allowed: "Washes hands daily", prohibited: "" },
  );
  await executeFactoryJob(sql, GATE_JOB, { runId: "run-1" });
  assert.deepEqual(gateWrites, [{ id: "v-unapproved", result: "block" }]);
});
