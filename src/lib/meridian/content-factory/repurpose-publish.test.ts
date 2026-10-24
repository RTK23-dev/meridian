import assert from "node:assert/strict";
import test from "node:test";
import { repurposePublishReadiness, type RepurposePublishInput } from "./repurpose-publish.ts";

const READY: RepurposePublishInput = {
  variantStatus: "rendered",
  review: { status: "approved", decidedAt: "2026-10-24T10:00:00Z", actorId: "user_1", reason: "" },
  hasStoredVideo: true,
  metaConnected: true,
};

test("a rendered, approved variation with a stored video and a connected Meta account is ready", () => {
  assert.deepEqual(repurposePublishReadiness(READY), { state: "ready" });
});

test("a variation that is not rendered is blocked first, whatever else is true", () => {
  for (const variantStatus of ["planned", "not_priced", "not_connected", "rendering", "failed"] as const) {
    const result = repurposePublishReadiness({ ...READY, variantStatus });
    assert.equal(result.state === "blocked" && result.block, "not_rendered", variantStatus);
  }
});

test("an unreviewed or rejected variation is blocked as not approved", () => {
  const undecided = repurposePublishReadiness({ ...READY, review: { status: "not_decided" } });
  assert.equal(undecided.state === "blocked" && undecided.block, "not_approved");
  const rejected = repurposePublishReadiness({
    ...READY,
    review: { status: "rejected", decidedAt: "2026-10-24T10:00:00Z", actorId: "user_1", reason: "The treatment hides the product." },
  });
  assert.equal(rejected.state === "blocked" && rejected.block, "not_approved");
});

test("an approved variation whose video is not stored is blocked, and the reason says nothing was published", () => {
  const result = repurposePublishReadiness({ ...READY, hasStoredVideo: false });
  assert.equal(result.state, "blocked");
  assert.equal(result.state === "blocked" && result.block, "no_stored_video");
  assert.match(result.state === "blocked" ? result.reason : "", /Nothing was published/);
});

test("with no connected Meta account the variation is blocked as not connected, and nothing is sent", () => {
  const result = repurposePublishReadiness({ ...READY, metaConnected: false });
  assert.equal(result.state, "blocked");
  assert.equal(result.state === "blocked" && result.block, "not_connected");
  assert.match(result.state === "blocked" ? result.reason : "", /Nothing was sent/);
});

test("the readiness check never reports ready on a missing condition, whichever one is missing", () => {
  const cases: Partial<RepurposePublishInput>[] = [
    { variantStatus: "planned" },
    { review: { status: "not_decided" } },
    { hasStoredVideo: false },
    { metaConnected: false },
  ];
  for (const override of cases) {
    assert.equal(repurposePublishReadiness({ ...READY, ...override }).state, "blocked", JSON.stringify(override));
  }
});
