import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDeploymentOnlyKey } from "./resolve.ts";
import { withEnv } from "./test-databases.ts";

// Stub values only. No test in this file calls a live provider.
const DEPLOYMENT_OPENROUTER = "deployment-openrouter-key-7777";

test("OpenRouter chat: the deployment key is used only with OPENROUTER_SHARED_DEFAULT=deployment", async () => {
  await withEnv({ OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER }, async () => {
    const resolution = resolveDeploymentOnlyKey("openrouter_chat", process.env);
    assert.equal(resolution.status, "not_configured");
    assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_OPENROUTER), false);
  });
  await withEnv({ OPENROUTER_SHARED_DEFAULT: "deployment", OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER }, async () => {
    const resolution = resolveDeploymentOnlyKey("openrouter_chat", process.env);
    assert.equal(resolution.status === "ready" && resolution.secret, DEPLOYMENT_OPENROUTER);
    assert.equal(resolution.status === "ready" && resolution.source, "deployment_shared_default");
  });
  await withEnv({ OPENROUTER_SHARED_DEFAULT: "deployment" }, async () => {
    const resolution = resolveDeploymentOnlyKey("openrouter_chat", process.env);
    assert.equal(resolution.status, "not_configured");
    assert.match(resolution.status === "not_configured" ? resolution.reason : "", /OPENROUTER_API_KEY is not set/);
  });
});

test("the chat, factory and health code reads no OpenRouter, OpenAI or Hypit key from the environment directly", () => {
  // The resolver is the one place that names these variables. Everything else in these areas reads through it.
  const srcRoot = fileURLToPath(new URL("../../../", import.meta.url)); // src/
  const scoped = ["lib/meridian/providers", "lib/meridian/factory", "lib/meridian/observability", "routes/api/health.ts"];
  const read = /(process\.env|\benv)(\.|\[\s*["'])(OPENROUTER_API_KEY|OPENAI_API_KEY|HYPIT_API_TOKEN|HYPIT_API_KEY)\b/;
  const offenders: string[] = [];
  const check = (path: string) => {
    if (!/\.(ts|tsx)$/.test(path) || /\.test\.ts$/.test(path)) return;
    if (read.test(readFileSync(path, "utf8"))) offenders.push(relative(srcRoot, path));
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else check(path);
    }
  };
  for (const target of scoped) {
    const path = join(srcRoot, target);
    if (statSync(path).isDirectory()) walk(path);
    else check(path);
  }
  assert.deepEqual(offenders, [], "a provider key is read from the environment outside the resolver");
});
