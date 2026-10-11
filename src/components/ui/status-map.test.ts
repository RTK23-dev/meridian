import assert from "node:assert/strict";
import test from "node:test";
import { statusPresentation } from "./status-map.ts";

test("status presentation uses exact status names and never treats unhealthy as healthy", () => {
  assert.deepEqual(statusPresentation("CONNECTED"), { variant: "success", icon: "check", label: "Connected" });
  assert.deepEqual(statusPresentation("NOT_CONNECTED"), { variant: "neutral", icon: "plug", label: "Not connected" });
  assert.deepEqual(statusPresentation("UNHEALTHY"), { variant: "danger", icon: "alert", label: "Unhealthy" });
  assert.equal(statusPresentation("RUNNING").variant, "info");
  assert.equal(statusPresentation("something_else").variant, "neutral");
});

test("a bare HEALTH token is not a healthy state, because matching is exact and not by substring", () => {
  // The old substring check matched "HEALTH" inside "UNHEALTHY" and reported it as Ok.
  // A bare "HEALTH" names no state, so it stays neutral and never picks up the success tone.
  assert.equal(statusPresentation("HEALTH").variant, "neutral");
  assert.equal(statusPresentation("HEALTH").icon, "info");
  assert.equal(statusPresentation("HEALTHY").variant, "success");
  assert.equal(statusPresentation("  healthy ").variant, "success");
});
