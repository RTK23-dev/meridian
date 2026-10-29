import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { syntheticTelemetryAllowed, testingRuntimeFlag, trustProxyHeaders } from "./server-settings.ts";

const ACCESSORS = [
  ["testingRuntimeFlag", testingRuntimeFlag, "MERIDIAN_TESTING_RUNTIME"],
  ["trustProxyHeaders", trustProxyHeaders, "MERIDIAN_TRUST_PROXY_HEADERS"],
  ["syntheticTelemetryAllowed", syntheticTelemetryAllowed, "ALLOW_SYNTHETIC_TELEMETRY"],
] as const;

describe("the server setting accessors", () => {
  for (const [name, accessor, variable] of ACCESSORS) {
    it(`${name} is on only for the exact value "true" of ${variable}`, () => {
      assert.equal(accessor({ [variable]: "true" }), true);
      for (const value of [undefined, "", "1", "True", "TRUE", "yes", "false"]) {
        assert.equal(accessor({ [variable]: value }), false, `${variable}=${JSON.stringify(value)} must be off`);
      }
    });
  }

  it("reads the environment when it is called, so a change is seen without a reload", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(trustProxyHeaders(env), false);
    env.MERIDIAN_TRUST_PROXY_HEADERS = "true";
    assert.equal(trustProxyHeaders(env), true);
  });
});

// The ratchet. Direct reads of process.env in the app code (src/lib and src/routes, outside tests) may not rise. A setting that a reader
// needs goes through an accessor in this folder, and when a reader moves its count comes down here too, so the number only falls.
const RATCHET_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const APP_ROOTS = ["src/lib", "src/routes"];
const DIRECT_READS_MAX = 76;

function appSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appSourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("direct reads of the environment in the app code", () => {
  it(`stay at or below ${DIRECT_READS_MAX}, so a new setting goes through an accessor in config/`, () => {
    let reads = 0;
    for (const root of APP_ROOTS) {
      for (const file of appSourceFiles(join(RATCHET_ROOT, root))) {
        reads += readFileSync(file, "utf8").split("process.env.").length - 1;
      }
    }
    assert.ok(
      reads <= DIRECT_READS_MAX,
      `direct reads of process.env rose to ${reads} (the ratchet is ${DIRECT_READS_MAX}). Read the setting through src/lib/meridian/config/`,
    );
  });
});
