import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { meridianCredentialSource, type MeridianResolver, type MeridianWorkspaceCategory } from "./meridian.ts";

type Call = { kind: "workspace"; organizationId: string; category: MeridianWorkspaceCategory } | { kind: "deployment"; key: string };

/** A recorded resolver. Every call is logged; `answer` decides the reply. No database and no environment is read. */
function recorded(answer: (call: Call) => Awaited<ReturnType<MeridianResolver["workspace"]>>): { resolver: MeridianResolver; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    resolver: {
      deploymentOnly: async (key) => {
        const call: Call = { kind: "deployment", key };
        calls.push(call);
        return answer(call);
      },
      workspace: async (organizationId, category) => {
        const call: Call = { kind: "workspace", organizationId, category };
        calls.push(call);
        return answer(call);
      },
    },
  };
}

describe("Meridian credential connector", () => {
  for (const id of ["openrouter", "heygen", "anthropic", "deepgram"] as const) {
    it(`maps ${id} to the workspace's own ${id} category when an organization is in scope`, async () => {
      const { resolver, calls } = recorded(() => ({ status: "ready", secret: `sk-${id}-workspace` }));
      const found = await meridianCredentialSource(resolver).get(id, "org_1");
      assert.deepEqual(found, { status: "ready", credential: { kind: "api_key", secret: `sk-${id}-workspace` } });
      assert.deepEqual(calls, [{ kind: "workspace", organizationId: "org_1", category: id }], "only the workspace resolver is asked");
    });

    it(`passes ${id}'s unusable or not-configured reason through, and never falls back to a deployment key`, async () => {
      for (const status of ["unusable", "not_configured"] as const) {
        const { resolver, calls } = recorded((call) =>
          call.kind === "workspace" ? { status, reason: `${id} ${status}` } : { status: "ready", secret: "sk-deployment" },
        );
        const found = await meridianCredentialSource(resolver).get(id, "org_1");
        assert.deepEqual(found, { status: "not_connected", reason: `${id} ${status}` });
        assert.equal(calls.some((call) => call.kind === "deployment"), false, "the deployment-only key is not read for a workspace");
      }
    });

    it(`is not connected for ${id} when the resolver throws`, async () => {
      const resolver: MeridianResolver = {
        deploymentOnly: async () => Promise.reject(new Error("db down")),
        workspace: async () => Promise.reject(new Error("db down")),
      };
      const found = await meridianCredentialSource(resolver).get(id, "org_1");
      assert.equal(found.status, "not_connected");
      assert.equal(JSON.stringify(found).includes("db down"), false);
    });
  }

  it("with no organization, OpenRouter uses only the deployment-only key, and no workspace key is read", async () => {
    for (const organizationId of [null, "", "   "]) {
      const { resolver, calls } = recorded(() => ({ status: "ready", secret: "sk-or-deployment" }));
      const found = await meridianCredentialSource(resolver).get("openrouter", organizationId);
      assert.deepEqual(found, { status: "ready", credential: { kind: "api_key", secret: "sk-or-deployment" } });
      assert.deepEqual(calls, [{ kind: "deployment", key: "openrouter_chat" }]);
    }
  });

  it("with no organization and no opt-in, OpenRouter passes the resolver's reason through", async () => {
    const { resolver } = recorded(() => ({ status: "not_configured", reason: "not opted in" }));
    assert.deepEqual(await meridianCredentialSource(resolver).get("openrouter", null), { status: "not_connected", reason: "not opted in" });
  });

  it("with no organization, HeyGen, Anthropic and Deepgram are not connected, and nothing is read", async () => {
    for (const id of ["heygen", "anthropic", "deepgram"]) {
      const { resolver, calls } = recorded(() => ({ status: "ready", secret: "sk-should-not-be-used" }));
      const found = await meridianCredentialSource(resolver).get(id, null);
      assert.equal(found.status, "not_connected");
      assert.deepEqual(calls, []);
    }
  });

  it("is not connected for an id Meridian has no category for, and asks no resolver", async () => {
    for (const id of ["elevenlabs", "constructor", "__proto__", "openai"]) {
      const { resolver, calls } = recorded(() => ({ status: "ready", secret: "sk-should-not-be-used" }));
      const found = await meridianCredentialSource(resolver).get(id, "org_1");
      assert.equal(found.status, "not_connected");
      assert.deepEqual(calls, []);
    }
  });

  it("reads the real resolver with no organization, which is not opted in on a test run", { skip: process.env.OPENROUTER_SHARED_DEFAULT !== undefined }, async () => {
    const found = await meridianCredentialSource().get("openrouter", null);
    assert.equal(found.status, "not_connected");
  });
});
