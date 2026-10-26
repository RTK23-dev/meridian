// OpenRouter Decisions readiness is a claim about one key and one model: a connection test passed for them. This file checks that the
// claim stops holding when either changes, so a replaced key or a changed model reads as configured, not ready. Fixtures only: nothing
// here calls the provider.

import assert from "node:assert/strict";
import test from "node:test";
import { recordedDecisionCatalogSource } from "../testing/decision-catalog-fixture.ts";
import { OPENROUTER_DECISIONS_EXAMPLE_MODEL, OpenRouterDecisionsEngine, type OpenRouterCheckStore, type OpenRouterKeySource } from "./openrouter-engine.ts";
import type { OpenRouterCheckRecord } from "./openrouter-settings.ts";

const ORG = "org_readiness_stale";
const CURRENT_FINGERPRINT = "sk-or-…new1";
const REPLACED_FINGERPRINT = "sk-or-…old0";
const OTHER_MODEL = "typesafe/jev-1.13";

function keySource(fingerprint: string): OpenRouterKeySource {
  return {
    async keyFor() {
      return { secret: "sk-or-v1-readiness-fixture-secret", fingerprint, reason: "" };
    },
  };
}

function store(model: string | null, check: OpenRouterCheckRecord | null): OpenRouterCheckStore {
  return {
    async workspaceModel() {
      return model;
    },
    async latestCheck() {
      return check;
    },
  };
}

function check(overrides: Partial<OpenRouterCheckRecord>): OpenRouterCheckRecord {
  return {
    status: "passed",
    model: OPENROUTER_DECISIONS_EXAMPLE_MODEL,
    keyFingerprint: CURRENT_FINGERPRINT,
    message: "The provider answered.",
    checkedAt: "2026-10-24T12:00:00.000Z",
    returnedModel: null,
    upstreamProvider: null,
    providerRequestId: null,
    ...overrides,
  };
}

function engine(keys: OpenRouterKeySource, checks: OpenRouterCheckStore) {
  return new OpenRouterDecisionsEngine({
    keys,
    store: checks,
    deploymentModel: undefined,
    catalog: recordedDecisionCatalogSource(),
  });
}

test("a passed check for the current key and model is ready: the positive control", async () => {
  const health = await engine(keySource(CURRENT_FINGERPRINT), store(OPENROUTER_DECISIONS_EXAMPLE_MODEL, check({}))).healthFor(ORG);
  assert.equal(health.status, "READY");
});

test("a passed check made with a key that has since been replaced is not ready: the workspace must test the new key", async () => {
  const health = await engine(keySource(CURRENT_FINGERPRINT), store(OPENROUTER_DECISIONS_EXAMPLE_MODEL, check({ keyFingerprint: REPLACED_FINGERPRINT }))).healthFor(ORG);
  assert.equal(health.status, "CONFIGURED", "a replaced key is configured, not ready");
});

test("a passed check for a model the workspace has since changed from is not ready: the new model must be tested", async () => {
  const health = await engine(keySource(CURRENT_FINGERPRINT), store(OTHER_MODEL, check({ model: OPENROUTER_DECISIONS_EXAMPLE_MODEL }))).healthFor(ORG);
  assert.equal(health.status, "CONFIGURED");
  assert.match(health.message, new RegExp(OTHER_MODEL.replace(/\./g, "\\.")), "the message names the model that is not tested yet");
});

test("a failed check for the current key and model is configured, and says the test failed", async () => {
  const health = await engine(keySource(CURRENT_FINGERPRINT), store(OPENROUTER_DECISIONS_EXAMPLE_MODEL, check({ status: "failed", message: "HTTP 402: insufficient credits." }))).healthFor(ORG);
  assert.equal(health.status, "CONFIGURED");
  assert.match(health.message, /The last connection test failed: HTTP 402: insufficient credits\./);
});

test("a workspace with no key is not configured, whatever check was recorded for an earlier key", async () => {
  const noKey: OpenRouterKeySource = { async keyFor() { return { secret: null, fingerprint: "", reason: "No OpenRouter key is saved for this workspace." } } };
  const health = await engine(noKey, store(OPENROUTER_DECISIONS_EXAMPLE_MODEL, check({}))).healthFor(ORG);
  assert.equal(health.status, "NOT_CONFIGURED");
});
