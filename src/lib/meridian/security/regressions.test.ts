import assert from "node:assert/strict";
import test from "node:test";
import { assertRole } from "../access.ts";
import { assertSameTenant } from "../domain.ts";
import { learningDirection } from "../learning/engine.ts";
import { recommendationPosture } from "../opportunity/engine.ts";
import { ingestPerformance, publishThrough } from "../providers/boundaries.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import { generationAllowed } from "./budget.ts";
import { collectAdLibrarySource } from "../market/pipeline.ts";
import { publicUrlIssue } from "../sources/public-url.ts";
import { createMemoryObjectStore, safeStorageKey } from "../storage/object-store.ts";
import { combineLogoFrames } from "../vision/measure.ts";
import { signWebhookBody, verifyWebhook } from "../webhooks/verify.ts";

test("generation stops at the daily and concurrency limits and does not invent a cost", () => {
  const open = generationAllowed({ runsToday: 1, running: 0 });
  assert.equal(open.allowed, true);
  assert.equal(open.estimatedCostCents, null);
  const busy = generationAllowed({ runsToday: 1, running: 3 });
  assert.equal(busy.allowed, false);
  assert.match(busy.reason, /concurrency limit is 3/);
  const full = generationAllowed({ runsToday: 40, running: 0 });
  assert.match(full.reason, /limit is 40/);
});

test("storage, urls, webhooks, and tenants reject the cross-scope cases", () => {
  assert.throws(() => safeStorageKey("../secret"), /not allowed/);
  assert.throws(() => safeStorageKey("/etc/passwd"), /not allowed/);
  const store = createMemoryObjectStore();
  store.put({ organizationId: "org-a", brandId: "brand-a", key: "a/file.png", mimeType: "image/png", bytes: Uint8Array.from([1, 2, 3, 4]) });
  assert.equal(store.get("org-b", "a/file.png"), null);
  assert.ok(store.get("org-a", "a/file.png"));
  assert.match(publicUrlIssue("http://127.0.0.1/latest") ?? "", /not a public host/);
  assert.match(publicUrlIssue("http://169.254.169.254/meta") ?? "", /not a public host/);
  assert.match(publicUrlIssue("http://metadata.google.internal/") ?? "", /Metadata/);
  assert.match(publicUrlIssue("file:///etc/passwd") ?? "", /Only http/);
  const now = Date.now();
  const body = "{\"ok\":true}";
  const signature = signWebhookBody("secret", String(now), body);
  assert.equal(
    verifyWebhook({ secret: "secret", timestamp: String(now), signature: "00", rawBody: body, eventId: "e1", nowMs: now, seenEventIds: [], accountKnown: true }).status,
    "rejected",
  );
  assert.equal(
    verifyWebhook({ secret: "secret", timestamp: String(now), signature, rawBody: body, eventId: "e1", nowMs: now, seenEventIds: [], accountKnown: true }).status,
    "accepted",
  );
  assert.throws(() => assertRole("viewer", "member"), /permission/);
  assert.throws(
    () => assertSameTenant([{ organizationId: "other", brandId: "brand-a" }], "org-a", "brand-a"),
    /Tenant scope/,
  );
});

test("publishing and market collection name the missing connection instead of succeeding", () => {
  const readiness = assessPublishing({
    accounts: [],
    provider: "meta",
    kind: "image",
    mime: "image/png",
    width: 1080,
    height: 1080,
    byteSize: 1000,
    destinationUrl: "https://example.com",
  });
  assert.equal(readiness.state, "EXTERNAL_CONNECTION_REQUIRED");
  assert.match(readiness.summary, /No connected meta account/);
  const page = assessPublishing({
    accounts: [{ provider: "meta", status: "CONNECTED", accountId: "act_1", permissions: ["ads_management"], pageId: "", destinationUrl: "https://example.com" }],
    provider: "meta",
    kind: "image",
    mime: "image/png",
    width: 1080,
    height: 1080,
    byteSize: 1000,
    destinationUrl: "",
  });
  assert.equal(page.state, "NOT_READY");
  assert.match(page.summary, /page id/);
  assert.equal(publishThrough({ provider: "meta", creativeId: "c1", env: {} }).status, "NOT_CONNECTED");
  const first = publishThrough({ provider: "test", creativeId: "c1", allowTestProvider: true });
  const second = publishThrough({ provider: "test", creativeId: "c1", allowTestProvider: true });
  assert.equal(first.externalId, second.externalId);
  assert.match(first.externalId ?? "", /^test:/);
  assert.equal(ingestPerformance({ provider: "tiktok", env: {} }).status, "NOT_CONNECTED");
  const library = collectAdLibrarySource();
  assert.equal(library.status, "NOT_CONNECTED");
  assert.equal(library.records.length, 0);
});

test("learning direction and exploration do not upgrade a thin sample", () => {
  assert.equal(learningDirection({ lift: 0.4, sampleSize: 2, impressions: 5000 }), "INSUFFICIENT_EVIDENCE");
  assert.equal(learningDirection({ lift: 0.2, sampleSize: 4, impressions: 800 }), "POSITIVE");
  assert.equal(learningDirection({ lift: -0.3, sampleSize: 4, impressions: 800 }), "NEGATIVE");
  assert.equal(learningDirection({ lift: 0.01, sampleSize: 4, impressions: 800 }), "NEUTRAL");
  const explore = recommendationPosture({ source: "discovered", historicalEvidence: 0, confidence: 0.4, novelty: 0.8 });
  assert.equal(explore.posture, "exploration");
  assert.match(explore.uncertainty, /Missing performance stays missing/);
  const exploit = recommendationPosture({ source: "discovered", historicalEvidence: 0.3, confidence: 0.7, novelty: 0.2 });
  assert.equal(exploit.posture, "exploitation");
  const frames = combineLogoFrames([
    { similarity: 0.9, confidence: 0.8, outcome: "MATCH", evidence: "Frame A matched." },
    { similarity: 0.2, confidence: 0.8, outcome: "MISMATCH", evidence: "Frame B missed." },
  ]);
  assert.equal(frames.outcome, "MISMATCH");
  assert.match(frames.evidence, /2 frame/);
});
