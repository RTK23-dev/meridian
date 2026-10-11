/**
 * The durable image judgment reads the creative's persisted copy. It never builds copy from the generation prompt, so a product
 * name or a prohibited claim that appears only in the prompt is not evidence about the copy.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { saveWorkspaceEngine } from "../decisions/selection.ts";
import type { ArtifactDrive } from "../storage/artifact-drive.ts";
import { registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { PNG, imagePlan, insertExecutingPlan, studioTenant } from "../testing/durable-image-fixtures.ts";
import { materializeImageArtifact } from "./materialization.ts";

const PROMPT = "GENERATION-PROMPT-ONLY-TEXT-7731";

/** A COMPLETED image job with a verified stored artifact, as the durable path leaves it before materialization. */
async function completedImageJob(
  sql: Awaited<ReturnType<typeof getSql>>,
  tenant: Awaited<ReturnType<typeof studioTenant>>,
  planId: string,
  input: { copy: string; prompt: string; productName: string; prohibitedClaims?: string },
): Promise<string> {
  const jobId = `image-job-${randomUUID()}`;
  const storageId = `storage-${randomUUID()}`;
  const sha256 = createHash("sha256").update(PNG).digest("hex");
  await sql`
    insert into storage_objects (id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256, lifecycle)
    values (${storageId}, ${tenant.organizationId}, ${tenant.brandId}, 'memory', ${`file-${storageId}`}, ${`${jobId}.png`}, 'image/png', ${PNG.byteLength}, ${sha256}, 'stored')
  `;
  const jobInput = {
    kind: "image",
    runId: randomUUID(),
    prompt: input.prompt,
    copy: input.copy,
    productName: input.productName,
    format: "single_image",
    itemLabel: "image 1",
    sequenceIndex: 0,
    deliverableKind: "image",
    planDeliverableId: "deliv-img-1",
    creativeSpec: { modelId: "test-image-model", aspectRatio: "9:16" },
    manifest: {
      brand: { product: input.productName },
      hook: { type: "problem", text: "Tired of smelly sponges?" },
      concept: { mechanism: "live demonstration" },
    },
    qcBrand: {
      brain: {
        positioning: "Mesh sponges that stay fresh between uses.",
        valueProposition: "",
        tone: "plain",
        prohibitedClaims: input.prohibitedClaims ?? "",
        wordsToAvoid: "",
      },
      creatives: [],
    },
  };
  await sql`
    insert into production_jobs (
      id, organization_id, brand_id, provider, status, cost_mode, estimated_cost_cents, input, output, artifact_id,
      created_at, updated_at, creative_plan_id, modality, cost_status
    ) values (
      ${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'google_nano_banana', 'COMPLETED', 'BALANCED', 0,
      ${JSON.stringify(jobInput)}, ${JSON.stringify({ width: 1, height: 1, promptVersion: "creative-image-v1" })}, ${storageId},
      now(), now(), ${planId}, 'image', 'verified'
    )
  `;
  return jobId;
}

/** The drive returns the same verified bytes the artifact row records, so the materializer's checks pass. */
const driveWithPng = { get: async () => ({ bytes: PNG }) } as unknown as ArtifactDrive;

async function setup(label: string) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, label);
  const plan = imagePlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions");
  await saveWorkspaceEngine(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, engineId: "jev", targetHealth: { status: "READY" } });
  return { sql, tenant, plan, jev, engines: registryWith(jev, openai) };
}

test("the judgment receives the persisted copy as creative_copy, and the generation prompt is never sent to the engine", async () => {
  const { sql, tenant, plan, jev, engines } = await setup("mat-copy-persisted");
  const copy = "Tired of smelly sponges?\nMesh sponge keeps the sink fresh.\nGrab a 4-pack today";
  const jobId = await completedImageJob(sql, tenant, plan.id, { copy, prompt: PROMPT, productName: "Mesh sponge" });
  const materialized = await materializeImageArtifact(
    sql,
    { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: jobId },
    { driveClient: driveWithPng, engines },
  );

  const [creative] = await sql<{ raw_text: string }>`select raw_text from creative_records where id = ${materialized.creativeId}`;
  assert.equal(creative?.raw_text, copy, "the creative stores the copy it was judged on");
  const scopedCopy = jev.requests.map((request) => (request.state.evidence as Record<string, { copy?: string }>).creative_copy?.copy).filter((value) => value !== undefined);
  assert.ok(scopedCopy.length > 0, "a text question receives the creative_copy evidence");
  assert.ok(scopedCopy.every((value) => value === copy), "every creative_copy item is the persisted copy, not product plus prompt");
  assert.doesNotMatch(JSON.stringify(jev.requests.map((request) => request.state)), new RegExp(PROMPT), "the prompt is not evidence for any question");
});

test("a product name that appears only in the generation prompt does not satisfy the product check, and nothing is judged from it", async () => {
  const { sql, tenant, plan, jev, engines } = await setup("mat-copy-product-prompt");
  const jobId = await completedImageJob(sql, tenant, plan.id, {
    copy: "Swipe to see the antibacterial layer.",
    prompt: "Still of Mesh sponge on a kitchen sink.",
    productName: "Mesh sponge",
  });
  const materialized = await materializeImageArtifact(
    sql,
    { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: jobId },
    { driveClient: driveWithPng, engines },
  );

  const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${materialized.creativeId}`;
  assert.equal(creative?.status, "rejected", "the copy does not name the product, so the creative is rejected");
  const [decision] = await sql<{ decision: string; reasons: string }>`
    select decision, reasons from jev_decisions where id = ${`${materialized.creativeId}:product_match`}
  `;
  assert.equal(decision?.decision, "REJECT");
  assert.match(decision?.reasons ?? "", /not in the copy/);
  assert.equal(jev.requests.length, 0, "a deterministic rejection is decided before any engine is called");
});

test("a prohibited claim that appears only in the copy is caught by the copy, before any engine is called", async () => {
  const { sql, tenant, plan, jev, engines } = await setup("mat-copy-claim");
  const jobId = await completedImageJob(sql, tenant, plan.id, {
    copy: "Mesh sponge. Guaranteed results in one wash.",
    prompt: "Still of Mesh sponge, clean and bright.",
    productName: "Mesh sponge",
    prohibitedClaims: "guaranteed results",
  });
  const materialized = await materializeImageArtifact(
    sql,
    { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: jobId },
    { driveClient: driveWithPng, engines },
  );

  const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${materialized.creativeId}`;
  assert.equal(creative?.status, "rejected");
  const [decision] = await sql<{ decision: string }>`select decision from jev_decisions where id = ${`${materialized.creativeId}:claim_safety`}`;
  assert.equal(decision?.decision, "REJECT", "the prohibited claim in the copy is a claim violation");
  assert.equal(jev.requests.length, 0);
});
