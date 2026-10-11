import assert from "node:assert/strict";
import test from "node:test";
import { engineRows, type EngineSources } from "./pipeline-model.ts";

const readyStorage: EngineSources["settings"] = { state: "ready", storage: { configured: true } };

test("the factory lists only Manual Cloud and Hypit, because no factory code submits a job to Higgsfield", () => {
  const sources: EngineSources = { hypit: { status: "CONFIGURED", detail: "" }, settings: readyStorage };
  assert.deepEqual(engineRows(sources).map((row) => row.id), ["manual_cloud", "hypit"]);
  const unknown: EngineSources = { hypit: { status: "UNKNOWN", detail: "" }, settings: { state: "error" } };
  assert.equal(engineRows(unknown).some((row) => row.id === "higgsfield"), false, "still absent when the status cannot be read");
});

test("Hypit is configured only when the server says CONFIGURED, and is not chosen otherwise", () => {
  const configured = engineRows({ hypit: { status: "CONFIGURED", detail: "ok" }, settings: readyStorage }).find((row) => row.id === "hypit");
  assert.equal(configured?.state, "configured");
  assert.equal(configured?.selectable, true);
  const missing = engineRows({ hypit: { status: "NOT_CONFIGURED", detail: "" }, settings: readyStorage }).find((row) => row.id === "hypit");
  assert.equal(missing?.state, "not_connected");
  assert.equal(missing?.detail, "Hypit is not configured.");
  assert.equal(missing?.selectable, false);
});

test("Manual Cloud follows the Google Drive status, and an unreadable status is not shown as connected", () => {
  const hypit = { status: "CONFIGURED", detail: "" };
  const manualCloud = (settings: EngineSources["settings"]) => engineRows({ hypit, settings }).find((row) => row.id === "manual_cloud");
  assert.equal(manualCloud({ state: "loading" })?.state, "checking");
  assert.equal(manualCloud({ state: "error" })?.state, "not_verified");
  assert.equal(manualCloud({ state: "ready", storage: { configured: true } })?.selectable, true);
  assert.equal(manualCloud({ state: "ready", storage: { configured: false } })?.state, "not_connected");
  assert.equal(manualCloud({ state: "ready" })?.state, "not_verified", "no storage summary is not a connection");
});
