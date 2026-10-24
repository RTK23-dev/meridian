import assert from "node:assert/strict";
import test from "node:test";
import type { RepurposePublishInput } from "./repurpose-publish.ts";
import {
  memoryRepurposeUploadStore,
  uploadRepurposedVariantToMeta,
  type MetaVideoUpload,
  type UploadRepurposedVariantInput,
} from "./repurpose-upload.ts";

const READY: RepurposePublishInput = {
  variantStatus: "rendered",
  review: { status: "approved", decidedAt: "2026-10-24T10:00:00Z", actorId: "user_1", reason: "" },
  hasStoredVideo: true,
  metaConnected: true,
};

const BASE: UploadRepurposedVariantInput = {
  organizationId: "org_1",
  brandId: "brand_1",
  runId: "run_1",
  variantId: "var_1",
  variantKey: "variation-1",
  readiness: READY,
  bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  platformAccountId: "acct_1",
  adAccountId: "act_123",
  accessToken: "token-not-logged",
  uploadName: "Repurposed one [Meridian:abc]",
};

/** A Meta upload that records its calls and answers with the given result. */
function fakeUpload(answer: Awaited<ReturnType<MetaVideoUpload>>) {
  const calls: { adAccountId: string; idempotencyKey: string }[] = [];
  const upload: MetaVideoUpload = async (_credentials, input) => {
    calls.push({ adAccountId: input.adAccountId, idempotencyKey: input.idempotencyKey });
    return answer;
  };
  return { upload, calls };
}

const transport = async () => {
  throw new Error("the fake upload must not use the transport");
};

test("a ready variation is uploaded once, and its receipt holds the id Meta returned", async () => {
  const store = memoryRepurposeUploadStore();
  const { upload, calls } = fakeUpload({ status: "stored", externalId: "meta_video_9", reused: false });
  const outcome = await uploadRepurposedVariantToMeta(BASE, { store, upload, transport });
  assert.equal(outcome.status, "uploaded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.adAccountId, "act_123");
  assert.equal(calls[0]!.idempotencyKey, "brand_1:run_1:variation-1:acct_1:meta_ad_video");
  assert.equal(outcome.status === "uploaded" && outcome.receipt.externalId, "meta_video_9");
  assert.equal(store.all().length, 1);
});

test("a second attempt for the same variation and account returns the receipt and sends nothing", async () => {
  const store = memoryRepurposeUploadStore();
  const first = fakeUpload({ status: "stored", externalId: "meta_video_9", reused: false });
  await uploadRepurposedVariantToMeta(BASE, { store, upload: first.upload, transport });
  const second = fakeUpload({ status: "stored", externalId: "meta_video_10", reused: false });
  const again = await uploadRepurposedVariantToMeta(BASE, { store, upload: second.upload, transport });
  assert.equal(again.status, "already_uploaded");
  assert.equal(second.calls.length, 0, "no second upload");
  assert.equal(again.status === "already_uploaded" && again.receipt.externalId, "meta_video_9");
});

test("a variation that is not ready is blocked before any upload, with the gate's reason", async () => {
  const store = memoryRepurposeUploadStore();
  const { upload, calls } = fakeUpload({ status: "stored", externalId: "meta_video_9", reused: false });
  const outcome = await uploadRepurposedVariantToMeta({ ...BASE, readiness: { ...READY, metaConnected: false } }, { store, upload, transport });
  assert.equal(outcome.status, "blocked");
  assert.equal(calls.length, 0);
  assert.equal(store.all().length, 0);
});

test("a variation whose video cannot be read is blocked, and nothing is sent", async () => {
  const store = memoryRepurposeUploadStore();
  const { upload, calls } = fakeUpload({ status: "stored", externalId: "meta_video_9", reused: false });
  const outcome = await uploadRepurposedVariantToMeta({ ...BASE, bytes: null }, { store, upload, transport });
  assert.equal(outcome.status, "blocked");
  assert.equal(calls.length, 0);
});

test("a failed upload leaves no receipt, so nothing claims an upload that did not happen", async () => {
  const store = memoryRepurposeUploadStore();
  const { upload } = fakeUpload({ status: "failed", externalId: null, error: "Meta rejected the video." });
  const outcome = await uploadRepurposedVariantToMeta(BASE, { store, upload, transport });
  assert.deepEqual(outcome, { status: "failed", error: "Meta rejected the video." });
  assert.equal(store.all().length, 0);
});

test("a receipt is written only from an id Meta returned, including one Meta reconciled from an earlier upload", async () => {
  const store = memoryRepurposeUploadStore();
  const { upload } = fakeUpload({ status: "stored", externalId: "meta_video_earlier", reused: true });
  const outcome = await uploadRepurposedVariantToMeta(BASE, { store, upload, transport });
  assert.equal(outcome.status === "uploaded" && outcome.receipt.externalId, "meta_video_earlier");
});

test("the memory store refuses a second receipt for the same variation and account", async () => {
  const store = memoryRepurposeUploadStore();
  const receipt = { id: "r1", organizationId: "org_1", brandId: "brand_1", variantId: "var_1", platformAccountId: "acct_1", externalId: "m1", idempotencyKey: "k" };
  await store.save(receipt);
  await assert.rejects(store.save({ ...receipt, id: "r2", externalId: "m2" }), /already exists/);
});
