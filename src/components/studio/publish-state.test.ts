import assert from "node:assert/strict";
import test from "node:test";
import { deliverByHandOnly, publishBlockReason } from "./publish-state.ts";

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
