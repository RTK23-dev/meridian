import assert from "node:assert/strict";
import test from "node:test";
import { resolveJevConfig } from "./config.ts";

test("JEV Runtime Configuration: resolves defaults when no environment variables are set", () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.MERIDIAN_JEV_PROVIDER_MODE;
    delete process.env.JEV_PROVIDER_MODE;
    delete process.env.JEV_MODE;
    delete process.env.MERIDIAN_JEV_PREFERRED_PROVIDER;
    delete process.env.JEV_PREFERRED_PROVIDER;
    delete process.env.MERIDIAN_JEV_FALLBACK_ENABLED;
    delete process.env.JEV_FALLBACK_ENABLED;
    delete process.env.TYPESAFE_JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_JEV_BASE_URL;
    delete process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_JEV_MODEL;
    delete process.env.TYPESAFE_MODEL;
    delete process.env.OPENROUTER_JEV_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_JEV_BASE_URL;
    delete process.env.JEV_BASE_URL;
    delete process.env.OPENROUTER_JEV_MODEL;
    delete process.env.JEV_MODEL;

    const config = resolveJevConfig();
    assert.equal(config.mode, "auto");
    assert.equal(config.preferredProvider, "typesafe_direct");
    // Transport fallback is off unless explicitly enabled, so no decision moves to another paid route silently.
    assert.equal(config.fallbackEnabled, false);
    assert.equal("apiKey" in config.typesafe, false, "the TypeSafe key is resolved per organization, not read here");
    assert.equal(config.typesafe.baseUrl, "https://api.typesafe.ai/v1/systemone");
    assert.equal(config.openrouter.baseUrl, "https://openrouter.ai/api/v1");
  } finally {
    process.env = originalEnv;
  }
});

test("JEV Runtime Configuration: resolves canonical environment variable names correctly", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.MERIDIAN_JEV_PROVIDER_MODE = "compare";
    process.env.MERIDIAN_JEV_PREFERRED_PROVIDER = "openrouter";
    process.env.MERIDIAN_JEV_FALLBACK_ENABLED = "false";
    process.env.TYPESAFE_JEV_API_KEY = "ts_key_123";
    process.env.TYPESAFE_JEV_BASE_URL = "https://custom.typesafe.ai/v1/systemone";
    process.env.TYPESAFE_JEV_MODEL = "typesafe/custom-model";
    process.env.OPENROUTER_JEV_API_KEY = "sk-or-456";
    process.env.OPENROUTER_JEV_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENROUTER_JEV_MODEL = "typesafe/jev-1.13";

    const config = resolveJevConfig();
    assert.equal(config.mode, "compare");
    assert.equal(config.preferredProvider, "openrouter");
    assert.equal(config.fallbackEnabled, false);
    assert.equal(config.typesafe.baseUrl, "https://custom.typesafe.ai/v1/systemone");
    assert.equal(config.typesafe.model, "typesafe/custom-model");
    assert.equal(config.openrouter.apiKey, "sk-or-456");
  } finally {
    process.env = originalEnv;
  }
});

test("JEV Runtime Configuration: resolves documented .env.example legacy alias values", () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.MERIDIAN_JEV_PROVIDER_MODE;
    delete process.env.TYPESAFE_JEV_API_KEY;
    delete process.env.OPENROUTER_JEV_API_KEY;

    process.env.JEV_PROVIDER_MODE = "typesafe";
    process.env.TYPESAFE_API_KEY = "legacy_ts_key";
    process.env.TYPESAFE_BASE_URL = "https://legacy.typesafe.ai/v1/systemone";
    process.env.OPENROUTER_API_KEY = "legacy_or_key";
    process.env.JEV_BASE_URL = "https://openrouter.ai/api/v1";

    const config = resolveJevConfig();
    assert.equal(config.mode, "typesafe_direct");
    assert.equal(config.typesafe.baseUrl, "https://legacy.typesafe.ai/v1/systemone");
    assert.equal(config.openrouter.apiKey, "legacy_or_key");
  } finally {
    process.env = originalEnv;
  }
});

test("JEV Runtime Configuration: allows explicit programmatic overrides", () => {
  const config = resolveJevConfig({
    mode: "openrouter",
    typesafe: {
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      model: "typesafe/jev-1.13",
    },
  });

  assert.equal(config.mode, "openrouter");
  assert.equal(config.typesafe.model, "typesafe/jev-1.13");
});
