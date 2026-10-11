import assert from "node:assert/strict";
import test from "node:test";
import { resolveJevConfig } from "./config.ts";

const KEYS = ["TYPESAFE_JEV_BASE_URL", "TYPESAFE_BASE_URL", "TYPESAFE_JEV_MODEL", "TYPESAFE_MODEL", "MERIDIAN_JEV_TIMEOUT_MS"] as const;

/** Runs with the JEV variables set as given, and restores the environment afterwards. */
function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, run: () => void): void {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    run();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("JEV configuration: the defaults are the TypeSafe transport only, with no routing mode, fallback or second provider", () => {
  withEnv({}, () => {
    const config = resolveJevConfig();
    assert.equal(config.typesafe.baseUrl, "https://api.typesafe.ai/v1/systemone");
    assert.equal(config.typesafe.model, "typesafe/jev-1.13");
    assert.equal(config.timeoutMs, 30000);
    for (const retired of ["mode", "preferredProvider", "fallbackEnabled", "openrouter", "compareSampleRate"]) {
      assert.equal(retired in config, false, `${retired} is no longer part of the configuration`);
    }
  });
});

test("JEV configuration: the canonical TYPESAFE_JEV_* names win over the legacy TYPESAFE_* names", () => {
  withEnv({ TYPESAFE_JEV_BASE_URL: "https://jev.example.test/v1", TYPESAFE_JEV_MODEL: "jev-canonical", TYPESAFE_BASE_URL: "https://legacy.example.test/v1", TYPESAFE_MODEL: "jev-legacy" }, () => {
    const config = resolveJevConfig();
    assert.equal(config.typesafe.baseUrl, "https://jev.example.test/v1");
    assert.equal(config.typesafe.model, "jev-canonical");
  });
});

test("JEV configuration: the legacy TYPESAFE_* names are read when the canonical names are unset", () => {
  withEnv({ TYPESAFE_BASE_URL: "https://legacy.example.test/v1", TYPESAFE_MODEL: "jev-legacy", MERIDIAN_JEV_TIMEOUT_MS: "12000" }, () => {
    const config = resolveJevConfig();
    assert.equal(config.typesafe.baseUrl, "https://legacy.example.test/v1");
    assert.equal(config.typesafe.model, "jev-legacy");
    assert.equal(config.timeoutMs, 12000);
  });
});

test("JEV configuration: explicit overrides win over the environment", () => {
  withEnv({ TYPESAFE_JEV_MODEL: "jev-from-env" }, () => {
    const config = resolveJevConfig({ timeoutMs: 5000, typesafe: { baseUrl: "https://override.example.test/v1", model: "jev-override" } });
    assert.equal(config.typesafe.model, "jev-override");
    assert.equal(config.typesafe.baseUrl, "https://override.example.test/v1");
    assert.equal(config.timeoutMs, 5000);
  });
});
