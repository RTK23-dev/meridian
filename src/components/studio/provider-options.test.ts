import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VIDEO_PROVIDER,
  VIDEO_PROVIDER_VALUES,
  isVideoProviderValue,
  productionStatusFrom,
  videoProviderCards,
  type ProductionStatus,
} from "./provider-options.ts";

const usable: ProductionStatus = { status: "ready", credential: "usable", credentialReason: null, hypitConfigured: true };
const noKey: ProductionStatus = { status: "ready", credential: "not_configured", credentialReason: null, hypitConfigured: false };

function byValue(production: ProductionStatus) {
  return Object.fromEntries(videoProviderCards({ production }).map((card) => [card.value, card]));
}

test("the video engines on the Generate step are Gemini Omni, Hypit, manual cloud and no video, and nothing else", () => {
  assert.deepEqual([...VIDEO_PROVIDER_VALUES].sort(), ["google_omni", "hypit", "manual_cloud", "none"]);
  assert.deepEqual(videoProviderCards({ production: usable }).map((card) => card.value).sort(), [...VIDEO_PROVIDER_VALUES].sort());
  for (const removed of ["higgsfield", "auto", "omni", "veo"]) {
    assert.equal(isVideoProviderValue(removed), false, `${removed} is not offered as a video engine`);
  }
});

test("the default video engine is Gemini Omni", () => {
  assert.equal(DEFAULT_VIDEO_PROVIDER, "google_omni");
});

test("with a usable workspace key and Hypit configured, both engines can run and no video is also offered", () => {
  const cards = byValue(usable);
  assert.equal(cards.google_omni?.disabled, false);
  assert.equal(cards.google_omni?.connection.kind, "connected");
  assert.equal(cards.hypit?.disabled, false);
  assert.equal(cards.hypit?.connection.kind, "configured");
  assert.equal(cards.none?.disabled, false);
  assert.equal(cards.manual_cloud?.disabled, false);
});

test("Gemini Omni without a usable Google key says it is not connected, and why", () => {
  const omni = byValue(noKey).google_omni;
  assert.equal(omni?.disabled, true);
  assert.equal(omni?.connection.kind, "not_connected");
  assert.match(omni?.disabledReason ?? "", /^Gemini Omni is not connected\. No usable Google key is saved for this workspace\./);
});

test("Gemini Omni keeps the reason the credential check gave", () => {
  const omni = byValue({ status: "ready", credential: "unusable", credentialReason: "The saved key was rejected by Google.", hypitConfigured: true }).google_omni;
  assert.equal(omni?.disabledReason, "Gemini Omni is not connected. The saved key was rejected by Google.");
});

test("Hypit without a configured address says it is not connected and names the missing setting", () => {
  const hypit = byValue(noKey).hypit;
  assert.equal(hypit?.disabled, true);
  assert.equal(hypit?.connection.kind, "not_connected");
  assert.match(hypit?.disabledReason ?? "", /^Hypit is not connected\. This server has no Hypit address set \(HYPIT_BASE_URL\)/);
});

test("while the production read is loading, the engines say they are being checked and are not offered as connected", () => {
  const cards = byValue({ status: "loading" });
  assert.equal(cards.google_omni?.connection.kind, "checking");
  assert.equal(cards.google_omni?.disabled, true);
  assert.equal(cards.hypit?.connection.kind, "checking");
  assert.equal(cards.hypit?.disabled, true);
});

test("when the read fails, no engine is shown as connected", () => {
  const cards = byValue({ status: "unavailable" });
  assert.equal(cards.google_omni?.connection.kind, "unknown");
  assert.equal(cards.hypit?.connection.kind, "unknown");
  assert.equal(cards.google_omni?.disabled, true);
  assert.equal(cards.hypit?.disabled, true);
  assert.notEqual(cards.hypit?.connection.kind, "configured");
});

test("productionStatusFrom treats a missing workspace or a failed read as unavailable, never as connected", () => {
  assert.deepEqual(productionStatusFrom({ organizationId: "", data: undefined, isError: false }), { status: "unavailable" });
  assert.deepEqual(productionStatusFrom({ organizationId: "org", data: undefined, isError: true }), { status: "unavailable" });
  assert.deepEqual(productionStatusFrom({ organizationId: "org", data: undefined, isError: false }), { status: "loading" });
  assert.deepEqual(
    productionStatusFrom({ organizationId: "org", data: { production: { configured: true, credentialState: "usable", settings: { hypitConfigured: true } } }, isError: false }),
    { status: "ready", credential: "usable", credentialReason: null, hypitConfigured: true },
  );
});
