// A stored provider connection's phase, from the recorded last success. A success older than the freshness window is DEGRADED, never
// HEALTHY. These tests call the same function the Integrations and Performance screens call, with the same inputs. No provider is called.

import assert from "node:assert/strict";
import test from "node:test";
import { phaseForStoredConnection } from "./live.ts";
import { PROVIDER_SUCCESS_FRESH_MS, successIsStale } from "./phase.ts";

const usable = { state: "usable", reason: "" } as never;
const DAY = 24 * 60 * 60 * 1000;

function phaseWith(lastSuccessAt: unknown, lastError = "") {
  return phaseForStoredConnection({
    provider: "meta",
    credential: usable,
    lastSuccessAt,
    lastError,
    disconnected: false,
  });
}

test("a success recorded an hour ago is HEALTHY", () => {
  const result = phaseWith(new Date(Date.now() - 60 * 60 * 1000).toISOString());
  assert.equal(result.phase, "HEALTHY");
});

test("a success older than the window is DEGRADED, and says it is stale", () => {
  const result = phaseWith(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  assert.equal(result.phase, "DEGRADED");
  assert.equal(result.detail, "The last successful request is stale.");
});

test("a success recorded 90 days ago is DEGRADED, not HEALTHY", () => {
  const result = phaseWith(new Date(Date.now() - 90 * DAY).toISOString());
  assert.equal(result.phase, "DEGRADED");
});

test("a success given as a Date, as the database driver can return it, is judged the same way", () => {
  assert.equal(phaseWith(new Date(Date.now() - 90 * DAY)).phase, "DEGRADED");
  assert.equal(phaseWith(new Date(Date.now() - 60 * 1000)).phase, "HEALTHY");
});

test("a success that cannot be read as a time is DEGRADED, so an unreadable record never reads as fresh", () => {
  assert.equal(phaseWith("not a timestamp").phase, "DEGRADED");
});

test("no success is recorded: the connection is not connected, whatever the credential says", () => {
  const result = phaseWith(null);
  assert.equal(result.phase, "NOT_CONFIGURED");
  assert.match(result.detail, /no successful provider request has been recorded/);
});

test("the most recent failure decides, even over a success that is fresh", () => {
  assert.equal(phaseWith(new Date(Date.now() - 60 * 1000).toISOString(), "The token was rejected.").phase, "FAILED");
});

test("the window edge: exactly at the window is still fresh, one millisecond past it is stale", () => {
  const now = 1_800_000_000_000;
  assert.equal(successIsStale(new Date(now - PROVIDER_SUCCESS_FRESH_MS).toISOString(), now), false);
  assert.equal(successIsStale(new Date(now - PROVIDER_SUCCESS_FRESH_MS - 1).toISOString(), now), true);
});

test("the window is one day, and no success is not stale: it is simply not recorded", () => {
  assert.equal(PROVIDER_SUCCESS_FRESH_MS, DAY);
  assert.equal(successIsStale(null), false);
  assert.equal(successIsStale(undefined), false);
});
