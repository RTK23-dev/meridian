import assert from "node:assert/strict";
import test from "node:test";
import { confirmRetryLabel, deliverByHandOnly, publishBlockReason, uncertainDestinations } from "./publish-state.ts";

const connected = { connected: true };
const notConnected = { connected: false, reason: "No Meta ad account is connected for this workspace." };

test("Publish is blocked, with the reason, when no destination is connected", () => {
  const reason = publishBlockReason([notConnected, { connected: false, reason: "No YouTube channel is connected." }], 0);
  assert.match(reason ?? "", /No destination is connected, so nothing can be published/);
  assert.equal(deliverByHandOnly([notConnected, { connected: false }]), true);
});

test("Publish is blocked when there are no destinations at all", () => {
  assert.match(publishBlockReason([], 0) ?? "", /No destination is listed/);
  assert.equal(deliverByHandOnly([]), false);
});

test("Publish asks for a destination when some are connected and none is selected", () => {
  assert.equal(publishBlockReason([connected, notConnected], 0), "Choose at least one destination to publish to.");
  assert.equal(deliverByHandOnly([connected, notConnected]), false);
});

test("Publish is available when a connected destination is selected", () => {
  assert.equal(publishBlockReason([connected, notConnected], 1), null);
});

test("only a destination whose last receipt is uncertain offers the confirmation", () => {
  const receipts = [
    { channelId: "facebook-pages", platform: "facebook", status: "uncertain" },
    { channelId: "instagram-reels", platform: "instagram", status: "published" },
    { channelId: "youtube-shorts", platform: "youtube", status: "failed" },
  ];
  assert.deepEqual(uncertainDestinations(receipts), [{ channelId: "facebook-pages", platform: "facebook" }]);
  assert.deepEqual(uncertainDestinations(receipts.slice(1)), []);
  assert.deepEqual(uncertainDestinations(null), []);
});

test("the confirmation says which platform to check", () => {
  assert.equal(confirmRetryLabel(["Facebook"]), "I checked Facebook: the earlier post is not there. Send it again.");
  assert.equal(confirmRetryLabel(["Facebook", "TikTok", "Facebook"]), "I checked Facebook and TikTok: the earlier post is not there. Send it again.");
});
