import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { generateHypitStudioVideo } from "./hypit-run.ts";

function sql(): Sql {
  return Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("from hypit_jobs")) return [];
      if (text.includes("insert into hypit_jobs")) return [];
      if (text.includes("insert into creative_records") || text.includes("insert into assets")) {
        throw new Error("A creative was stored without a Hypit video.");
      }
      return [];
    },
    { query: async () => [] },
  ) as Sql;
}

const brief = {
  id: "brief-live",
  title: "Demonstration",
  angle: "demonstration",
  hook: "Show the lather.",
  message: "Show the lather in the first second.",
  cta: "See the bar",
  format: "short_ugc",
  proofType: "demonstration",
  constraints: "Close product. No extra promise.",
};

test("a rejected JEV decision does not start Hypit", async () => {
  await assert.rejects(
    () =>
      generateHypitStudioVideo(sql(), {
        organizationId: "org-live",
        brandId: "brand-live",
        runId: "run-1",
        actorId: "actor",
        productName: "North bar",
        opportunityId: "opp-1",
        brief,
        tone: "quiet",
        decision: {
          id: "dec-live",
          organizationId: "org-live",
          brandId: "brand-live",
          questionId: "brief_gate",
          policyVersion: "code:brief_gate.v1",
          decision: "REJECT",
          reviewerDecision: "",
          reasons: ["The claim is unsupported."],
          evidence: [{ id: "ev-1", source: "brief", summary: "Unsupported." }],
        },
      }, { env: { baseUrl: "" } }),
    /No Hypit job was created/,
  );
});

test("a missing Hypit runtime is HYPIT_NOT_CONNECTED and stores no video", async () => {
  await assert.rejects(
    () =>
      generateHypitStudioVideo(sql(), {
        organizationId: "org-live",
        brandId: "brand-live",
        runId: "run-1",
        actorId: "actor",
        productName: "North bar",
        opportunityId: "opp-1",
        brief,
        tone: "quiet",
        decision: {
          id: "dec-live",
          organizationId: "org-live",
          brandId: "brand-live",
          questionId: "brief_gate",
          policyVersion: "code:brief_gate.v1",
          decision: "AUTO_APPROVE",
          reviewerDecision: "",
          reasons: ["Stored evidence supports this angle."],
          evidence: [{ id: "ev-1", source: "market", summary: "The lather is visible." }],
        },
      }, { env: { baseUrl: "" } }),
    /HYPIT_NOT_CONNECTED/,
  );
});
