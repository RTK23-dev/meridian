import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publishHypitVideoToMeta } from "./hypit-meta.server.ts";
import { publishPausedStages } from "../providers/live.ts";
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";

const bytes = new Uint8Array(Buffer.from("00000018ftypisom0000", "latin1"));
const sha = createHash("sha256").update(bytes).digest("hex");
const org = "org-1";
const brand = "brand-1";
const creativeId = "creative-1";
const jobId = "job-1";
const decisionId = "decision-1";
const briefId = "brief-1";

function fixture(overrides: { decision?: string; reviewer?: string; creativeStatus?: string; tenant?: string } = {}) {
  const requests: TransportRequest[] = [];
  const writes: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join(" ").toLowerCase();
    if (text.includes("from creative_records c left join assets")) {
      return [{
        organization_id: overrides.tenant ?? org, brand_id: overrides.tenant ? "other-brand" : brand,
        asset_organization_id: overrides.tenant ?? org, asset_brand_id: overrides.tenant ? "other-brand" : brand,
        status: overrides.creativeStatus ?? "approved", brief_id: briefId,
        workflow: JSON.stringify({ provider: "hypit", kind: "video", hypitJobId: jobId, jevDecisionId: decisionId }),
        storage_key: "hypit/key", checksum: sha, content_hash: sha, mime_type: "video/mp4", byte_size: bytes.byteLength, kind: "video", provider: "hypit",
      }];
    }
    if (text.includes("from hypit_jobs")) return [{
      id: "meridian-job-1", provider_job_id: jobId, status: "succeeded", jev_decision_id: decisionId, brief_id: briefId,
      artifact: JSON.stringify({ storageKey: "hypit/key", sha256: sha, mime: "video/mp4", byteLength: bytes.byteLength }),
      contract: JSON.stringify({ organizationId: org, brandId: brand, lineage: { jevDecisionId: decisionId, briefId } }),
    }];
    if (text.includes("from jev_decisions")) return [{ decision: overrides.decision ?? "AUTO_APPROVE", reviewer_decision: overrides.reviewer ?? "" }];
    if (text.includes("from asset_blobs")) return [{ body: Buffer.from(bytes).toString("base64"), mime_type: "video/mp4", checksum: sha, byte_size: bytes.byteLength }];
    if (text.includes("insert into provider_objects")) writes.push("video");
    if (text.includes("insert into audit_log")) writes.push("audit");
    return [];
  }) as Sql;
  const transport: Transport = async (request) => {
    requests.push(request);
    return { status: 200, body: JSON.stringify({ id: "meta-video-1" }), headers: {} };
  };
  return { sql, transport, requests, writes };
}

function input(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return publishHypitVideoToMeta(f.sql, {
    organizationId: org, brandId: brand, creativeId, actorId: "admin", name: "Hypit test",
    accessToken: "token", adAccountId: "act_1", transport: f.transport, correlationId: "corr-1", ...extra,
  });
}

test("approved stored Hypit MP4 uploads to Meta and its confirmed id enters the paused publication chain", async () => {
  const f = fixture();
  const uploaded = await input(f);
  assert.deepEqual(uploaded, {
    status: "stored", externalId: "meta-video-1", reused: false,
    hypitJobId: jobId, jevDecisionId: decisionId, briefId, storageKey: "hypit/key", sha256: sha, byteLength: bytes.byteLength,
  });
  assert.equal(f.requests.length, 1);
  const body = f.requests[0]?.body;
  assert.ok(body instanceof FormData);
  const uploadedBlob = body?.get("source");
  assert.ok(uploadedBlob instanceof Blob);
  assert.deepEqual(new Uint8Array(await uploadedBlob.arrayBuffer()), bytes);
  assert.deepEqual(f.writes, ["video", "audit"]);

  const calls: TransportRequest[] = [];
  const stages = await publishPausedStages({
    provider: "meta", name: "Hypit test", dailyBudgetCents: 2000, countries: ["US"], pageId: "page-1",
    link: "https://example.test", message: "Test", videoId: "meta-video-1", env: { META_ACCESS_TOKEN: "token", META_AD_ACCOUNT_ID: "act_1" },
    transport: async (request) => {
      calls.push(request);
      const id = request.url.endsWith("/campaigns") ? "campaign-1" : request.url.endsWith("/adsets") ? "set-1" : request.url.endsWith("/adcreatives") ? "creative-1" : "ad-1";
      return { status: 200, body: JSON.stringify({ id }), headers: {} };
    },
  });
  assert.deepEqual(stages.map((stage) => stage.status), ["stored", "stored", "stored", "stored"]);
  assert.deepEqual(calls.map((request) => JSON.parse(String(request.body)).status).filter(Boolean), ["PAUSED", "PAUSED", "PAUSED"]);
  const creativeBody = JSON.parse(String(calls.find((request) => request.url.endsWith("/adcreatives"))?.body));
  assert.equal(creativeBody.object_story_spec.video_data.video_id, "meta-video-1");
});

test("unapproved and rejected Hypit artifacts are rejected before a Meta upload", async () => {
  const pending = fixture({ creativeStatus: "in_review" });
  assert.equal((await input(pending))?.status, "failed");
  const rejected = fixture({ decision: "REJECT", reviewer: "rejected" });
  assert.equal((await input(rejected))?.status, "failed");
  assert.equal(pending.requests.length + rejected.requests.length, 0);
});

test("cross-tenant Hypit artifacts are rejected without contacting Meta", async () => {
  const f = fixture({ tenant: "other-org" });
  assert.equal((await input(f))?.status, "failed");
  assert.equal(f.requests.length, 0);
});

test("retry reuses the persisted Meta video id and does not upload a duplicate", async () => {
  const f = fixture();
  const first = await input(f);
  const second = await input(f, { existingVideoId: first?.status === "stored" ? first.externalId : "" });
  assert.equal(second?.status, "stored");
  assert.equal(second?.status === "stored" && second.reused, true);
  assert.equal(f.requests.length, 1);
  let chainRequests = 0;
  const retriedStages = await publishPausedStages({
    provider: "meta", name: "Hypit test", dailyBudgetCents: 2000, countries: ["US"], pageId: "page-1",
    link: "https://example.test", message: "Test", videoId: "meta-video-1",
    existing: { campaign: "campaign-1", ad_set: "set-1", creative: "creative-1", ad: "ad-1" },
    env: { META_ACCESS_TOKEN: "token", META_AD_ACCOUNT_ID: "act_1" },
    transport: async () => { chainRequests += 1; throw new Error("retry must reuse stored ids"); },
  });
  assert.equal(chainRequests, 0);
  assert.ok(retriedStages.every((stage) => stage.status === "stored" && stage.reused));
});

test("missing Meta configuration returns NOT_CONNECTED without storing a receipt", async () => {
  const f = fixture();
  const result = await input(f, { accessToken: "", adAccountId: "" });
  assert.equal(result?.status, "NOT_CONNECTED");
  assert.deepEqual(f.writes, []);
  assert.equal(f.requests.length, 0);
});

test("failed Meta video upload returns failure and stores no publication receipt", async () => {
  const f = fixture();
  f.transport = async (request) => {
    f.requests.push(request);
    return { status: 500, body: JSON.stringify({ error: { message: "upload failed" } }), headers: {} };
  };
  const result = await input(f);
  assert.equal(result?.status, "failed");
  assert.deepEqual(f.writes, []);
  assert.equal(f.requests.length, 1);
});
