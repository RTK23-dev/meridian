import assert from "node:assert/strict";
import test from "node:test";
import { statusPresentation } from "./status-map.ts";

test("status presentation uses exact status names and never treats unhealthy as healthy", () => {
  assert.deepEqual(statusPresentation("CONNECTED"), { variant: "success", icon: "check", label: "CONNECTED" });
  assert.deepEqual(statusPresentation("NOT_CONNECTED"), { variant: "neutral", icon: "plug", label: "NOT CONNECTED" });
  assert.deepEqual(statusPresentation("UNHEALTHY"), { variant: "danger", icon: "alert", label: "UNHEALTHY" });
  assert.equal(statusPresentation("RUNNING").variant, "info");
  assert.equal(statusPresentation("something_else").variant, "neutral");
});
