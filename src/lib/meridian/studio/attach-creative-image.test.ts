import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import type { Sql } from "../learning/store.ts";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import { PNG, PNG_BASE64, studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { enableAppAliases } from "../../../test-support/lib/meridian/testing/module-aliases.ts";
import { storeVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-attach-creative-image";
// The artifact store is the testing store, as in the durable image suites. Production never selects it.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// The server module uses the "@/" alias, so the alias hook is registered before the module is loaded.
enableAppAliases();
const { attachCreativeImageFor, attachStatesFor, completeStoredAttach, recordAttachOutcome } = await import("./creative-image.server.ts");
const { pollProductionJobs } = await import("../production/poller.ts");

const NANO_BANANA_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const ALPHA = { name: "Alpha soap", prohibited: "guaranteed results" };
const BETA = { name: "Beta sponge", prohibited: "miracle cure" };

/** A tenant with one creative to illustrate. The creative belongs to the brand, so the workspace key is the brand's. */
async function creativeFor(label: string, options: { copy?: string; title?: string; productName?: string } = {}) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, label);
  const creativeId = `creative-${randomUUID()}`;
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, hook, product_name, status, brief_id, created_by
    ) values (
      ${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', ${options.title ?? "Kitchen sponge"},
      ${options.copy ?? "Mesh sponges that do not smell."}, 'Tired of smelly sponges?', ${options.productName ?? ""},
      'generated', ${tenant.briefId}, ${tenant.userId}
    )
  `;
  return { sql, tenant, creativeId };
}

async function addProducts(sql: Sql, tenant: { brandId: string; userId: string }, products: Array<{ name: string; prohibited: string }>) {
  for (const product of products) {
    await sql`
      insert into products (id, brand_id, name, prohibited_claims, created_by)
      values (${`product-${randomUUID()}`}, ${tenant.brandId}, ${product.name}, ${product.prohibited}, ${tenant.userId})
    `;
  }
}

async function storeProductionKey(sql: Sql, organizationId: string, apiKey: string) {
  await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey });
}

function imageResponse(): Response {
  return new Response(JSON.stringify({ output_image: { data: PNG_BASE64, mime_type: "image/png" } }), { status: 200 });
}

/**
 * Serves the image endpoint. Any other request is refused, so an unexpected call is visible. `onCall` runs before each reply,
 * and lets a test look at the database at the moment the provider is called.
 */
function imageProvider(respond: () => Promise<Response> = async () => imageResponse(), onCall?: () => Promise<void>) {
  const requests: Headers[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== NANO_BANANA_URL) return new Response("unexpected request", { status: 500 });
    requests.push(new Headers(init?.headers));
    if (onCall) await onCall();
    return respond();
  });
  return { requests, restore: () => fetchMock.mock.restore() };
}

/** Runs the statements of a connection, including those inside a transaction, and fails any one matching the pattern. */
function failingOn(sql: Sql, pattern: RegExp): Sql {
  const wrap = (base: Sql): Sql => {
    const wrapped = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (pattern.test(strings.join("?"))) throw new Error("injected failure");
      return base(strings, ...values);
    }) as unknown as Sql;
    wrapped.query = base.query.bind(base) as Sql["query"];
    if (base.begin) {
      const begin = base.begin.bind(base);
      wrapped.begin = (fn) => begin((tx) => fn(wrap(tx)));
    }
    return wrapped;
  };
  return wrap(sql);
}

/** The provider is answered by the test's fixture fetch. Production passes nothing, so the disabled image capability refuses. */
async function attach(tenant: { userId: string; brandId: string }, creativeId: string, perception?: import("../perception/types.ts").MultimodalPerceptionProvider | null) {
  return attachCreativeImageFor(tenant.userId, { brandId: tenant.brandId, creativeId }, { imageFetch: globalThis.fetch, perception });
}

async function creativeRow(sql: Sql, creativeId: string) {
  const [row] = await sql<{ status: string; asset_url: string | null }>`select status, asset_url from creative_records where id = ${creativeId}`;
  return row!;
}

async function assetsOf(sql: Sql, creativeId: string) {
  return sql<{ id: string; lifecycle: string; review_status: string; qa_decision: string; storage_key: string }>`
    select id, lifecycle, review_status, qa_decision, storage_key from assets where creative_id = ${creativeId} order by id
  `;
}

async function countOf(query: Promise<Array<{ count?: unknown }>>) {
  const [row] = await query;
  return Number(row?.count ?? 0);
}

/** The attach job for one creative, with the same key the attach writes. */
async function jobsFor(sql: Sql, organizationId: string, creativeId: string) {
  return sql<{ id: string; status: string; modality: string; artifact_id: string | null; materialized_at: unknown; materialized_creative_id: string | null; error_code: string | null }>`
    select id, status, modality, artifact_id, materialized_at, materialized_creative_id, error_code from production_jobs
    where organization_id = ${organizationId} and input->>'attachCreativeId' = ${creativeId}
    order by created_at asc
  `;
}

async function reservationsFor(sql: Sql, organizationId: string) {
  return sql<{ id: string; production_job_id: string | null; amount_micros: string | number | bigint; status: string; settled_spend_micros: string | number | bigint | null; cost_basis: string | null; estimator_version: string | null }>`
    select id, production_job_id, amount_micros, status, settled_spend_micros, cost_basis, estimator_version
    from budget_reservations where organization_id = ${organizationId} order by created_at asc, id asc
  `;
}

/** A job row for the outcome-recording tests, shaped as an attach job that has stored its image. */
async function attachJobRow(sql: Sql, tenant: { organizationId: string; brandId: string }, creativeId: string) {
  const jobId = `attach-${creativeId}-${randomUUID()}`;
  await sql`
    insert into production_jobs (id, organization_id, brand_id, provider, status, cost_mode, input, created_at, updated_at, modality, cost_status)
    values (${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'google_nano_banana', 'COMPLETED', 'BALANCED',
      ${JSON.stringify({ kind: "creative_attach", attachCreativeId: creativeId })}, now(), now(), 'image', 'unknown')
  `;
  return jobId;
}

test("attachCreativeImage sends the creative's workspace key to the image provider, and no other key", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-key");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-1111");
  const provider = imageProvider();
  try {
    const result = await attach(tenant, creativeId);
    assert.ok(["approved", "in_review", "rejected"].includes(result.status), `the QC outcome is the status, got ${result.status}`);
    assert.equal(result.status, attachStatesFor(result.decision!).creativeStatus, "the status is the state the judgment implies");
    assert.equal(provider.requests.length, 1, "exactly one image request is sent");
    assert.equal(provider.requests[0]!.get("x-goog-api-key"), "attach-workspace-key-1111", "the request carries the workspace's own key");
  } finally {
    provider.restore();
  }
});

test("attachCreativeImage sends nothing when the creative's workspace has no usable key", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-nokey");
  const provider = imageProvider();
  try {
    const result = await attach(tenant, creativeId);
    assert.equal(result.status, "NOT_CONNECTED", "without a usable key the image is not generated");
    assert.equal(provider.requests.length, 0, "no request is sent without a workspace key");
    assert.equal((await jobsFor(sql, tenant.organizationId, creativeId)).length, 0, "no production job is opened when nothing can be requested");
    assert.equal(await countOf(sql`select count(*) as count from budget_reservations where organization_id = ${tenant.organizationId}`), 0, "nothing is reserved");
  } finally {
    provider.restore();
  }
});

test("attachCreativeImage reads the generated bytes through the configured perception provider and judges them through the gate, with no local visual decision", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-perception");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-2222");
  const savedEnv = { shared: process.env.PERCEPTION_SHARED_DEFAULT, key: process.env.MERIDIAN_GEMINI_API_KEY };
  process.env.PERCEPTION_SHARED_DEFAULT = "gemini";
  process.env.MERIDIAN_GEMINI_API_KEY = "attach-shared-gemini-key-3333";

  const geminiBodies: string[] = [];
  const geminiKeys: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === NANO_BANANA_URL) {
      return new Response(JSON.stringify({ output_image: { data: PNG_BASE64, mime_type: "image/png" } }), { status: 200 });
    }
    if (target.startsWith("https://generativelanguage.googleapis.com/v1beta/models/") && target.endsWith(":generateContent")) {
      geminiBodies.push(String(init?.body ?? ""));
      geminiKeys.push(new Headers(init?.headers).get("x-goog-api-key") ?? "");
      const observation = [{ index: 0, productPresence: true, productProminence: "prominent", productObstructed: false, sharpness: "sharp", lighting: "good", composition: "balanced", legibility: "no_text", artifactsVisible: false }];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(observation) }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected request", { status: 500 });
  });
  try {
    const { GeminiPerceptionProvider } = await import("../perception/multimodal.ts");
    const result = await attach(tenant, creativeId, new GeminiPerceptionProvider(undefined, { fetchImpl: globalThis.fetch }));
    assert.ok(["approved", "in_review", "rejected"].includes(result.status));
    assert.equal(geminiBodies.length, 1, "the generated image is sent to perception exactly once");
    assert.equal(geminiKeys[0], "attach-shared-gemini-key-3333", "perception uses the shared credential the panel reports");
    const body = JSON.parse(geminiBodies[0]!) as { contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> };
    const image = body.contents[0]!.parts.find((part) => part.inlineData)?.inlineData;
    assert.equal(image?.mimeType, "image/png");
    assert.equal(image?.data, Buffer.from(PNG).toString("base64"), "the provider receives the generated bytes, not a URL or a data string");
    assert.doesNotMatch(geminiBodies[0]!, /Kitchen sponge|Tired of smelly sponges|Mesh sponges that do not smell/, "no copy reaches the perception provider");

    const runs = await sql<{ status: string; subject_type: string }>`
      select status, subject_type from perception_runs where organization_id = ${tenant.organizationId} and subject_id = ${creativeId}
    `;
    assert.equal(runs.length, 1, "the read is recorded as one perception run");
    assert.equal(runs[0]?.status, "observed");
    assert.equal(runs[0]?.subject_type, "creative");

    const [localVisual] = await sql<{ count: string | number }>`
      select count(*) as count from jev_decisions where subject_id = ${creativeId} and question_id = 'visual_qa'
    `;
    assert.equal(Number(localVisual?.count ?? 0), 0, "no second, local visual decision is written");
    const [gate] = await sql<{ count: string | number }>`
      select count(*) as count from decision_gate_records where subject_id = ${creativeId} and gate = 'creative_qa'
    `;
    assert.ok(Number(gate?.count ?? 0) >= 1, "the judgment went through the engine gate");
    // A human review points at a recorded local decision, as the reviews table requires, and is opened exactly when the outcome asks for it.
    const [review] = await sql<{ count: string | number }>`select count(*) as count from reviews where creative_id = ${creativeId}`;
    assert.equal(Number(review?.count ?? 0), result.decision === "HUMAN_REVIEW" ? 1 : 0);
  } finally {
    fetchMock.mock.restore();
    if (savedEnv.shared === undefined) delete process.env.PERCEPTION_SHARED_DEFAULT;
    else process.env.PERCEPTION_SHARED_DEFAULT = savedEnv.shared;
    if (savedEnv.key === undefined) delete process.env.MERIDIAN_GEMINI_API_KEY;
    else process.env.MERIDIAN_GEMINI_API_KEY = savedEnv.key;
  }
});

test("a successful attach runs the production lifecycle: the job and reservation exist before the call, the reservation settles, and the image is a verified artifact", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-lifecycle");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-4444");
  let atCall: { jobs: string[]; reservations: string[] } | undefined;
  const provider = imageProvider(undefined, async () => {
    const jobs = await sql<{ status: string }>`select status from production_jobs where organization_id = ${tenant.organizationId} and input->>'attachCreativeId' = ${creativeId}`;
    const reservations = await sql<{ status: string }>`select status from budget_reservations where organization_id = ${tenant.organizationId}`;
    atCall = { jobs: jobs.map((row) => row.status), reservations: reservations.map((row) => row.status) };
  });
  try {
    const result = await attach(tenant, creativeId);
    assert.deepEqual(atCall, { jobs: ["SUBMITTING"], reservations: ["RESERVED"] }, "the job is SUBMITTING and its budget is RESERVED when the provider is called");

    const [job] = await jobsFor(sql, tenant.organizationId, creativeId);
    assert.ok(job, "the attach records one production job");
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.modality, "image");
    assert.ok(job.id.startsWith(`attach-${creativeId}-`), "the job id carries the creative and a fresh attempt id");
    assert.ok(job.artifact_id, "the stored artifact is linked to the job");
    assert.equal(job.materialized_creative_id, creativeId, "the job is materialized onto this creative");
    assert.ok(job.materialized_at, "the materialized marker is set, so the poller does not claim the job");

    const [reservation] = await reservationsFor(sql, tenant.organizationId);
    assert.equal(reservation?.production_job_id, job.id, "the reservation is held against the attach's job");
    assert.equal(reservation?.status, "RECONCILED", "the reservation settles once the image is stored");
    assert.equal(BigInt(reservation!.amount_micros), 1_000_000n, "the reservation is the attach ceiling");
    assert.equal(BigInt(reservation!.settled_spend_micros ?? 0), 1_000_000n, "the image settles at its reserved ceiling, since no billed amount is reported");
    assert.equal(reservation?.cost_basis, "ESTIMATED");
    assert.equal(reservation?.estimator_version, "unpriced-ceiling-v1");

    const [object] = await sql<{ id: string; name: string; sha256: string; mime_type: string }>`
      select id, name, sha256, mime_type from storage_objects where id = ${job.artifact_id!}
    `;
    assert.ok(object, "the bytes are recorded as a storage object");
    assert.equal(object.mime_type, "image/png");
    assert.equal(object.sha256.length, 64, "the artifact carries its checksum");

    const [asset] = await assetsOf(sql, creativeId);
    assert.equal(asset?.storage_key, object.name, "the asset points at the verified artifact");
    assert.equal(await countOf(sql`select count(*) as count from asset_blobs where storage_key = ${object.name}`), 0, "the bytes are not written to asset_blobs");
    const creative = await creativeRow(sql, creativeId);
    assert.equal(creative.status, result.status, "the creative carries the judged state");
    if (result.decision !== "REJECT") assert.equal(creative.asset_url, object.name, "a kept image becomes the creative's picture");
  } finally {
    provider.restore();
  }
});

test("attachCreativeImage refuses before any request when the artifact store is not connected", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-store");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-5555");
  const saved = {
    testing: process.env.MERIDIAN_TESTING_RUNTIME,
    account: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refresh: process.env.GOOGLE_REFRESH_TOKEN,
  };
  // Outside the testing runtime, artifacts go to Google Drive. No deployment credential and no workspace connection is set here.
  process.env.MERIDIAN_TESTING_RUNTIME = "false";
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "";
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.GOOGLE_REFRESH_TOKEN = "";
  const provider = imageProvider();
  try {
    const result = await attach(tenant, creativeId);
    assert.equal(result.status, "NOT_CONNECTED", "an image is not requested when it could not be stored");
    assert.equal(provider.requests.length, 0, "no provider request is sent");
    assert.equal((await jobsFor(sql, tenant.organizationId, creativeId)).length, 0, "no production job is opened");
  } finally {
    provider.restore();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("MERIDIAN_TESTING_RUNTIME", saved.testing);
    restore("GOOGLE_SERVICE_ACCOUNT_KEY", saved.account);
    restore("GOOGLE_CLIENT_ID", saved.clientId);
    restore("GOOGLE_CLIENT_SECRET", saved.clientSecret);
    restore("GOOGLE_REFRESH_TOKEN", saved.refresh);
  }
});

test("a second attach for a creative with an attach in flight is refused, and no second request is sent", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-concurrent");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-6666");
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let callStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    callStarted = resolve;
  });
  const provider = imageProvider(async () => {
    callStarted();
    await released;
    return imageResponse();
  });
  try {
    const first = attach(tenant, creativeId);
    await Promise.race([started, first]);
    await assert.rejects(attach(tenant, creativeId), /already being attached/, "the second attach is refused with a clear message");
    release();
    const result = await first;
    assert.ok(["approved", "in_review", "rejected"].includes(result.status));
    assert.equal(provider.requests.length, 1, "only the first attach reaches the provider");
    assert.equal((await jobsFor(sql, tenant.organizationId, creativeId)).length, 1, "only the first attach opens a job");
  } finally {
    release();
    provider.restore();
  }
});

test("an ambiguous provider failure keeps the reservation held, records the job as unresolved, and blocks another attach until resolved", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-ambiguous");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-7777");
  const provider = imageProvider(async () => new Response("upstream error", { status: 500 }));
  try {
    const result = await attach(tenant, creativeId);
    assert.equal(result.status, "failed");
    assert.match(result.message, /held for reconciliation/);

    const [job] = await jobsFor(sql, tenant.organizationId, creativeId);
    assert.equal(job?.status, "SUBMISSION_UNKNOWN", "the job is recorded as unresolved");
    assert.equal(job?.error_code, "PROVIDER_CALL_FAILED");
    const [reservation] = await reservationsFor(sql, tenant.organizationId);
    assert.equal(reservation?.status, "RESERVED", "the reservation is held, not released or settled");
    assert.equal(reservation?.production_job_id, job?.id);
    assert.equal((await creativeRow(sql, creativeId)).status, "generated", "the creative is not changed by a failed attach");
    assert.equal((await assetsOf(sql, creativeId)).length, 0, "no asset is written");

    await assert.rejects(attach(tenant, creativeId), /already being attached/, "the unresolved attach blocks another one");
    assert.equal(provider.requests.length, 1, "the failed attach is never retried here");
  } finally {
    provider.restore();
  }
});

test("an attach the budget cannot cover is refused before any provider call, and leaves no job", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-budget");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-8888");
  await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId, 0.5);
  const provider = imageProvider();
  try {
    await assert.rejects(attach(tenant, creativeId), /Budget limit exceeded/);
    assert.equal(provider.requests.length, 0, "no provider call is made");
    assert.equal((await jobsFor(sql, tenant.organizationId, creativeId)).length, 0, "the job row rolls back with the refused reservation");
    assert.equal((await reservationsFor(sql, tenant.organizationId)).length, 0);
  } finally {
    provider.restore();
  }
});

test("attach REJECT sets the creative rejected and its asset rejected in one committed step, and does not change the creative's picture", async () => {
  // The stored product's own claim appears in the copy, so the local claim check rejects it.
  const { sql, tenant, creativeId } = await creativeFor("attach-reject", { copy: "Mesh sponges. Miracle cure for smells.", productName: BETA.name });
  await addProducts(sql, tenant, [ALPHA, BETA]);
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-9999");
  const provider = imageProvider();
  try {
    const result = await attach(tenant, creativeId);
    assert.equal(result.decision, "REJECT");
    assert.equal(result.status, "rejected", "the QC outcome is the status");
    const creative = await creativeRow(sql, creativeId);
    assert.equal(creative.status, "rejected", "the creative is rejected");
    const [asset] = await assetsOf(sql, creativeId);
    assert.equal(asset?.lifecycle, "rejected", "the asset is rejected");
    assert.equal(asset?.review_status, "rejected");
    assert.equal(asset?.qa_decision, "REJECT");
    assert.notEqual(creative.asset_url, asset?.storage_key, "a rejected image does not become the creative's picture");
    assert.equal(await countOf(sql`select count(*) as count from rejections where creative_id = ${creativeId} and rejected_by = 'creative_qa'`), 1, "the rejection is recorded");
    assert.equal(await countOf(sql`select count(*) as count from reviews where creative_id = ${creativeId}`), 0, "no review is opened for a rejection");
  } finally {
    provider.restore();
  }
});

test("recordAttachOutcome writes the creative and asset state each judgment implies", async () => {
  const cases = [
    { rollup: "AUTO_APPROVE" as const, creative: "approved", lifecycle: "approved", reviews: 0, rejections: 0, picture: true },
    { rollup: "HUMAN_REVIEW" as const, creative: "in_review", lifecycle: "qa_required", reviews: 1, rejections: 0, picture: true },
    { rollup: "REJECT" as const, creative: "rejected", lifecycle: "rejected", reviews: 0, rejections: 1, picture: false },
  ];
  for (const expected of cases) {
    const { sql, tenant, creativeId } = await creativeFor(`outcome-${expected.rollup.toLowerCase()}`);
    const jobId = await attachJobRow(sql, tenant, creativeId);
    const assetId = `asset-${randomUUID()}`;
    const storageKey = `${tenant.organizationId}/${tenant.brandId}/production/${jobId}/artifact.png`;
    await recordAttachOutcome(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      creativeId,
      jobId,
      assetId,
      storageKey,
      sha256: "a".repeat(64),
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      width: 1,
      height: 1,
      provider: "google:nano-banana",
      model: "gemini-nano-banana-2.1",
      promptVersion: "creative-image-v1",
      provenance: "test",
      decisionId: tenant.decisionId,
      rollup: expected.rollup,
      reason: "Test judgment.",
    });
    const creative = await creativeRow(sql, creativeId);
    assert.equal(creative.status, expected.creative, `${expected.rollup}: creative status`);
    const [asset] = await assetsOf(sql, creativeId);
    assert.equal(asset?.lifecycle, expected.lifecycle, `${expected.rollup}: asset lifecycle`);
    assert.equal(asset?.review_status, expected.creative, `${expected.rollup}: asset review status`);
    assert.equal(await countOf(sql`select count(*) as count from reviews where creative_id = ${creativeId}`), expected.reviews, `${expected.rollup}: review rows`);
    assert.equal(await countOf(sql`select count(*) as count from rejections where creative_id = ${creativeId}`), expected.rejections, `${expected.rollup}: rejection rows`);
    assert.equal(creative.asset_url === storageKey, expected.picture, `${expected.rollup}: the creative's picture`);
    const [job] = await jobsFor(sql, tenant.organizationId, creativeId);
    assert.equal(job?.materialized_creative_id, creativeId, `${expected.rollup}: the job is materialized`);
  }
});

test("a failure between the state write and the review row leaves no partial state, and the same outcome commits in one step", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-rollback");
  const jobId = await attachJobRow(sql, tenant, creativeId);
  const storageKey = `${tenant.organizationId}/${tenant.brandId}/production/${jobId}/artifact.png`;
  const outcome = {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    creativeId,
    jobId,
    assetId: `asset-${randomUUID()}`,
    storageKey,
    sha256: "b".repeat(64),
    mimeType: "image/png",
    byteSize: PNG.byteLength,
    width: 1,
    height: 1,
    provider: "google:nano-banana",
    model: "gemini-nano-banana-2.1",
    promptVersion: "creative-image-v1",
    provenance: "test",
    decisionId: tenant.decisionId,
    rollup: "HUMAN_REVIEW" as const,
    reason: "Needs a person.",
  };

  await assert.rejects(recordAttachOutcome(failingOn(sql, /insert into reviews/), outcome), /injected failure/);
  assert.equal((await creativeRow(sql, creativeId)).status, "generated", "the creative state is rolled back with the failed review");
  assert.equal((await assetsOf(sql, creativeId)).length, 0, "the asset is rolled back with the failed review");
  assert.equal(await countOf(sql`select count(*) as count from reviews where creative_id = ${creativeId}`), 0, "no review row exists");
  assert.equal((await jobsFor(sql, tenant.organizationId, creativeId))[0]?.materialized_at, null, "the job is not marked materialized");

  await recordAttachOutcome(sql, outcome);
  assert.equal((await creativeRow(sql, creativeId)).status, "in_review", "the same outcome commits the creative state");
  const [asset] = await assetsOf(sql, creativeId);
  assert.equal(asset?.lifecycle, "qa_required", "and the asset state together with it");
  assert.equal(await countOf(sql`select count(*) as count from reviews where creative_id = ${creativeId}`), 1, "and the review row");
});

/** The local claim check's decision and reasons for a creative. */
async function claimCheckFor(sql: Sql, creativeId: string) {
  const [claims] = await sql<{ decision: string; reasons: string }>`
    select decision, reasons::text as reasons from jev_decisions where id = ${`${creativeId}:claim_safety`}
  `;
  assert.ok(claims, "the claim check is recorded for the creative");
  return { decision: claims.decision, reasons: claims.reasons };
}

test("the claims applied to a creative are its stored product's, never another product's", async () => {
  // Scenario 1: the stored product is Beta, and the copy names neither product. The copy carries both products' claim wording.
  // Only Beta's rules are applied, so the reason names Beta's wording, and Alpha's wording is never reported.
  const first = await creativeFor("claims-beta-copy", { copy: "Mesh sponges that do not smell. Guaranteed results. Miracle cure.", productName: BETA.name });
  await addProducts(first.sql, first.tenant, [ALPHA, BETA]);
  await storeProductionKey(first.sql, first.tenant.organizationId, "attach-workspace-key-claims-1");
  let provider = imageProvider();
  try {
    await attach(first.tenant, first.creativeId);
    const check = await claimCheckFor(first.sql, first.creativeId);
    assert.equal(check.decision, "REJECT", "the stored product's own claim is applied");
    assert.match(check.reasons, /miracle cure/, "the stored product's rules are the ones checked");
    assert.doesNotMatch(check.reasons, /guaranteed results/, "another product's rules are never checked");
  } finally {
    provider.restore();
  }

  // Scenario 2: the stored product is Beta, and the copy carries Alpha's wording only. Alpha's rules do not reject it.
  const second = await creativeFor("claims-beta-alpha-words", { copy: "Mesh sponges that do not smell. Guaranteed results every time.", productName: BETA.name });
  await addProducts(second.sql, second.tenant, [ALPHA, BETA]);
  await storeProductionKey(second.sql, second.tenant.organizationId, "attach-workspace-key-claims-2");
  provider = imageProvider();
  try {
    await attach(second.tenant, second.creativeId);
    const check = await claimCheckFor(second.sql, second.creativeId);
    assert.notEqual(check.decision, "REJECT", "Alpha's wording does not reject a Beta creative");
    assert.doesNotMatch(check.reasons, /guaranteed results/);
  } finally {
    provider.restore();
  }

  // Scenario 3: a stored product name that resolves to nothing. No product's claims are checked, and the creative is not approved.
  const third = await creativeFor("claims-unresolved", { copy: "Mesh sponges. Guaranteed results every time.", productName: "Gamma gadget" });
  await addProducts(third.sql, third.tenant, [ALPHA, BETA]);
  await storeProductionKey(third.sql, third.tenant.organizationId, "attach-workspace-key-claims-3");
  provider = imageProvider();
  try {
    const result = await attach(third.tenant, third.creativeId);
    assert.notEqual(result.status, "approved", "unknown product claims go to a person, never to approval");
    const check = await claimCheckFor(third.sql, third.creativeId);
    assert.doesNotMatch(check.reasons, /guaranteed results|miracle cure/, "no product's claims are checked");
  } finally {
    provider.restore();
  }
});

test("an attach records its outcome and a second attach after it finishes is allowed", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-again");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-10101");
  const provider = imageProvider();
  try {
    const first = await attach(tenant, creativeId);
    assert.notEqual(first.status, "failed", "the first attach stores its image");
    // Whatever the first judgment decided, the next attach is not refused as in flight. A rejected creative is refused for its own reason.
    let second: Awaited<ReturnType<typeof attach>> | undefined;
    let refusal: Error | undefined;
    try {
      second = await attach(tenant, creativeId);
    } catch (error) {
      refusal = error instanceof Error ? error : new Error(String(error));
    }
    if (refusal) assert.doesNotMatch(refusal.message, /already being attached/, "a finished attach does not block the next one");
    else assert.ok(["approved", "in_review", "rejected"].includes(second!.status));
    // A rejected creative is not illustrated again, so the second attach stops before the provider in that case.
    const attempts = first.status === "rejected" ? 1 : 2;
    assert.equal(provider.requests.length, attempts, "the attaches that are allowed reach the provider");
    assert.equal((await jobsFor(sql, tenant.organizationId, creativeId)).length, attempts);
  } finally {
    provider.restore();
  }
});

test("a stored image whose outcome was never recorded is finished by the next attach, once, and a second resume changes nothing", async () => {
  const { sql, tenant, creativeId } = await creativeFor("attach-resume");
  await storeProductionKey(sql, tenant.organizationId, "attach-workspace-key-12121");
  const provider = imageProvider();
  try {
    // The process stops after the image is stored and before its outcome is recorded. Settlement is the step cut off here.
    const stop = mock.method(BudgetLedgerService, "reconcile", async () => {
      throw new Error("process stopped");
    });
    try {
      await assert.rejects(attach(tenant, creativeId), /process stopped/);
    } finally {
      stop.mock.restore();
    }

    const [stored] = await jobsFor(sql, tenant.organizationId, creativeId);
    assert.ok(stored, "the attach recorded its job");
    assert.equal(stored.status, "COMPLETED", "the image is stored, and the job says so");
    assert.ok(stored.artifact_id, "the job is linked to the stored image");
    assert.equal(stored.materialized_at, null, "the outcome was never recorded");
    assert.equal((await creativeRow(sql, creativeId)).status, "generated", "the creative has not changed");
    assert.equal((await assetsOf(sql, creativeId)).length, 0, "no asset exists yet");
    assert.equal((await reservationsFor(sql, tenant.organizationId))[0]?.status, "RESERVED", "the spend is still held");
    const [object] = await sql<{ name: string }>`select name from storage_objects where id = ${stored.artifact_id!}`;

    // The poller leaves the gap alone: it cannot materialize a creative attach, so it neither claims nor fails the job.
    const polled = await pollProductionJobs(sql, {
      organizationId: tenant.organizationId,
      driveClient: {} as never,
      router: { get: () => undefined } as never,
    });
    assert.equal(polled.claimed, 0, "the poller does not claim a creative attach");
    assert.equal(provider.requests.length, 1, "no provider call is made for the gap");

    // While the stored image is recent, another attach is refused, as an attach in flight is.
    await assert.rejects(attach(tenant, creativeId), /already being attached/);
    assert.equal(provider.requests.length, 1);

    // Once the recording window has passed, the next attach finishes the stored image before it judges a new one.
    await sql`update production_jobs set created_at = now() - interval '20 minutes' where id = ${stored.id}`;
    const result = await attach(tenant, creativeId);
    assert.equal(provider.requests.length, 2, "the new attach reaches the provider once; finishing the stored image does not");

    const jobs = await jobsFor(sql, tenant.organizationId, creativeId);
    assert.equal(jobs.length, 2);
    const recovered = jobs.find((job) => job.id === stored.id)!;
    assert.equal(recovered.materialized_creative_id, creativeId, "the stored image is recorded on its creative");
    assert.ok(recovered.materialized_at, "its outcome is recorded");
    const reservations = await reservationsFor(sql, tenant.organizationId);
    const held = reservations.find((row) => row.production_job_id === stored.id)!;
    assert.equal(held.status, "RECONCILED", "the spend settles once, when the image is finished");
    assert.equal(BigInt(held.settled_spend_micros ?? 0), 1_000_000n, "it settles at the attach ceiling");
    // Creating the reservation writes RESERVATION_CREATED. Only a settlement writes RESERVATION_RECONCILED or RESERVATION_OVERAGE.
    const ledgerEntries = () =>
      countOf(sql`
        select count(*) as count from budget_ledger_entries
        where reservation_id = ${held.id} and entry_type in ('RESERVATION_RECONCILED', 'RESERVATION_OVERAGE')
      `);
    const assetsForStored = () =>
      countOf(sql`select count(*) as count from assets where creative_id = ${creativeId} and storage_key = ${object!.name}`);
    assert.equal(await ledgerEntries(), 1, "one ledger entry settles the reservation");
    assert.equal(await assetsForStored(), 1, "the stored image is one asset");
    assert.equal((await creativeRow(sql, creativeId)).status, result.status, "the creative carries the newest judgment");

    // Running the resume again changes nothing: no second asset, no second settlement.
    const assetsBefore = (await assetsOf(sql, creativeId)).length;
    const again = await completeStoredAttach(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: stored.id });
    assert.equal(again, "already_materialized");
    assert.equal(await assetsForStored(), 1, "the artifact is not duplicated");
    assert.equal((await assetsOf(sql, creativeId)).length, assetsBefore);
    assert.equal(await ledgerEntries(), 1, "the budget is not settled twice");

    // A second, conflicting write for the same job (a concurrent resume that judged differently) is refused by the job's lock.
    const creativeBefore = await creativeRow(sql, creativeId);
    await recordAttachOutcome(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      creativeId,
      jobId: stored.id,
      assetId: `asset-${randomUUID()}`,
      storageKey: object!.name,
      sha256: "c".repeat(64),
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      width: 1,
      height: 1,
      provider: "google:nano-banana",
      model: "gemini-nano-banana-2.1",
      promptVersion: "creative-image-v1",
      provenance: "test",
      decisionId: tenant.decisionId,
      rollup: "REJECT",
      reason: "A conflicting late judgment.",
    });
    assert.deepEqual(await creativeRow(sql, creativeId), creativeBefore, "the recorded creative state is not overwritten");
    assert.equal((await assetsOf(sql, creativeId)).length, assetsBefore, "and no second asset is written");
  } finally {
    provider.restore();
  }
});
