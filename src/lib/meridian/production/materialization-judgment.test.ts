import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { MediaFacts } from "../studio/features.ts";
import { judgeMedia } from "../studio/features.ts";
import { variantPrompt } from "../studio/media-work.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import {
  imagePlan,
  insertExecutingPlan,
  jobsOf,
  reservationsOf,
  stubGoogleImage,
  studioTenant,
} from "../testing/durable-image-fixtures.ts";

// The artifact store and the test image double are testing-runtime only. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

/** Reads a JSON column whether the driver returns it as text or as a parsed object. */
function objectOf(value: unknown): Record<string, unknown> {
  return (typeof value === "string" ? JSON.parse(value) : value ?? {}) as Record<string, unknown>;
}

test("an image's job and its creative carry the plan's ad copy, not the generation prompt, and each is judged once", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "judgment-copy");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const adCopyOf = new Map(plan.deliverables.map((deliv) => [deliv.id, deliv.copy]));
  assert.equal(adCopyOf.size, plan.deliverables.length);

  // The job's input snapshot: copy is the ad copy. The prompt is kept separately and is never copied into copy.
  const jobs = await sql<{ input: unknown }>`select input from production_jobs where creative_plan_id = ${plan.id}`;
  assert.equal(jobs.length, plan.deliverables.length);
  for (const job of jobs) {
    const input = objectOf(job.input);
    assert.equal(input.copy, adCopyOf.get(String(input.planDeliverableId)), "the job's copy is its plan deliverable's ad copy");
    assert.notEqual(input.copy, input.prompt, "the job's copy is not the generation prompt");
    assert.ok(!String(input.copy).includes(String(input.prompt)), "the job's copy does not contain the generation prompt");
  }

  // The creative row stores the ad copy as its raw text and message.
  const creatives = await sql<{ id: string; raw_text: string; message: string; workflow: unknown }>`
    select id, raw_text, message, workflow from creative_records where organization_id = ${tenant.organizationId}
  `;
  assert.equal(creatives.length, plan.deliverables.length);
  for (const creative of creatives) {
    const adCopy = adCopyOf.get(String(objectOf(creative.workflow).planDeliverableId));
    assert.equal(creative.raw_text, adCopy, "the creative's raw text is the plan's ad copy");
    assert.equal(creative.message, adCopy, "the creative's message is the plan's ad copy");
  }

  // Each creative was judged once. The gate record keeps evidence names and sources, not text, so the judged copy is not
  // read back here. The judgment takes the same copy value that is stored as the creative's raw text (materialization.ts).
  const gates = await sql<{ subject_id: string }>`
    select subject_id from decision_gate_records
    where organization_id = ${tenant.organizationId} and subject_type = 'creative' and gate = 'creative_qa'
  `;
  assert.equal(gates.length, creatives.length, "each creative was judged once");
});

test("a deliverable with blank copy is refused before any provider call, and nothing it reserved is held", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "judgment-blank");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  const first = plan.deliverables[0];
  assert.ok(first);
  first.copy = "   ";
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await assert.rejects(
      executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan),
      /has no copy; the image is not submitted/,
    );
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 0, "no provider call");
  assert.equal((await jobsOf(sql, plan.id)).length, 0, "no job row");
  const reservations = await reservationsOf(sql, tenant.organizationId);
  assert.ok(reservations.every((reservation) => reservation.status === "RELEASED"), "no reservation stays held");
});

test("product_match reads the generation prompt as well as the copy: an ad copy that omits the product passes while the prompt names it", () => {
  // Current rule, pinned on purpose. The copy alone does not decide product_match today. A product decision is pending on
  // whether the rule should read the copy only. Until then, the variant text is the copy, the prompt, and the transcript.
  const productName = "Mesh sponge";
  const adCopy = "Tired of smelly sponges?\nSwipe to see the antibacterial mesh layer\nGrab a 4-pack today";
  const prompt = variantPrompt({ productName, angle: "live demonstration", hook: "Tired of smelly sponges?", audience: "", constraints: "", index: 0, kind: "image" });
  const productOf = (facts: MediaFacts) => judgeMedia(facts).find((item) => item.questionId === "product_match");

  assert.ok(!adCopy.toLowerCase().includes(productName.toLowerCase()), "the ad copy does not name the product");
  assert.notEqual(productOf(mediaFacts({ productName, copy: adCopy, prompt }))?.decision, "REJECT", "the prompt names the product, so the check passes");
  assert.equal(
    productOf(mediaFacts({ productName, copy: adCopy, prompt: "A calm sponge still." }))?.decision,
    "REJECT",
    "with no product name in the copy or the prompt, the check rejects",
  );
});

function mediaFacts(input: Pick<MediaFacts, "productName" | "copy" | "prompt">): MediaFacts {
  return {
    kind: "image",
    positioning: "",
    tone: "",
    prohibited: "",
    wordsToAvoid: "",
    angle: "live demonstration",
    competitorTexts: [],
    ownTexts: [],
    mime: "image/png",
    byteSize: 1,
    width: 1,
    height: 1,
    checksum: "a".repeat(64),
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: null,
    paletteDistance: null,
    semanticSimilarity: null,
    ...input,
  };
}
