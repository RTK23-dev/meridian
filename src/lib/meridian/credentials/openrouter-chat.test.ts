import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDeploymentOnlyKey } from "./resolve.ts";
import { credentialStateOf } from "./contract.ts";
import { withEnv } from "./test-databases.ts";
import { activeChatProvider, completeWithImage, openRouterChatCredential, providerStatus } from "../providers/chat.server.ts";

// Stub values only. No test in this file calls a live provider: fetch is replaced for the length of each test.
const DEPLOYMENT_OPENROUTER = "deployment-openrouter-key-7777";
const DEPLOYMENT_OPENAI = "deployment-openai-key-2222";

/** Replaces fetch for the length of `run`. Every request is counted and answered with a stub body. */
async function withStubFetch<T>(run: (requests: Array<{ url: string; authorization: string | null }>) => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ choices: [{ message: { content: "stub answer" } }], usage: { total_tokens: 4 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = saved;
  }
}

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

test("OpenRouter chat: without the opt-in no chat provider is configured, and no request is sent", async () => {
  await withStubFetch(async (requests) => {
    await withEnv({ OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER, OPENROUTER_MODEL: "provider/test-model" }, async () => {
      assert.equal(activeChatProvider(), null);
      assert.deepEqual(providerStatus(), { configured: false, provider: "none", model: "" });
      const result = await completeWithImage({ system: "s", text: "t", imageUrl: "data:image/png;base64,AA", maxTokens: 10 });
      assert.equal(result.ok, false);
      assert.equal(requests.length, 0, "nothing is sent without the opt-in");
    });
  });
});

test("OpenRouter chat: with the opt-in, the request carries the deployment key, against a stubbed endpoint", async () => {
  await withStubFetch(async (requests) => {
    await withEnv({ OPENROUTER_SHARED_DEFAULT: "deployment", OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER, OPENROUTER_MODEL: "provider/test-model" }, async () => {
      assert.equal(activeChatProvider()?.id, "openrouter");
      const result = await completeWithImage({ system: "s", text: "t", imageUrl: "data:image/png;base64,AA", maxTokens: 10 });
      assert.equal(result.ok, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(requests[0]?.authorization, `Bearer ${DEPLOYMENT_OPENROUTER}`);
      assert.equal(openRouterChatCredential().status, "ready");
    });
  });
});

test("no chat provider status or resolution text carries a stub secret", async () => {
  await withEnv({ OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER, OPENAI_API_KEY: DEPLOYMENT_OPENAI }, async () => {
    const texts = [
      JSON.stringify(credentialStateOf(resolveDeploymentOnlyKey("openrouter_chat", process.env))),
      JSON.stringify(resolveDeploymentOnlyKey("openrouter_chat", process.env)),
      JSON.stringify(providerStatus()),
    ];
    for (const text of texts) {
      assert.equal(text.includes(DEPLOYMENT_OPENROUTER), false);
      assert.equal(text.includes(DEPLOYMENT_OPENAI), false);
    }
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
