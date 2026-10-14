import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { meridianCredentialSource } from "./meridian.ts";

describe("Meridian credential connector", () => {
  it("returns the OpenRouter key when Meridian's resolver has one", async () => {
    const source = meridianCredentialSource({ deploymentOnly: async () => ({ status: "ready", secret: "sk-or-test" }) });
    assert.deepEqual(await source.get("openrouter", "org_1"), { status: "ready", credential: { kind: "api_key", secret: "sk-or-test" } });
  });

  it("passes the resolver's reason through when there is no key", async () => {
    const source = meridianCredentialSource({ deploymentOnly: async () => ({ status: "not_configured", reason: "not opted in" }) });
    assert.deepEqual(await source.get("openrouter", "org_1"), { status: "not_connected", reason: "not opted in" });
  });

  it("is not connected when the resolver throws", async () => {
    const source = meridianCredentialSource({ deploymentOnly: async () => Promise.reject(new Error("db down")) });
    assert.equal((await source.get("openrouter", "org_1")).status, "not_connected");
  });

  it("is not connected for providers Meridian has no category for", async () => {
    const source = meridianCredentialSource({ deploymentOnly: async () => ({ status: "ready", secret: "sk-or-test" }) });
    for (const id of ["heygen", "anthropic"]) {
      const found = await source.get(id, "org_1");
      assert.equal(found.status, "not_connected");
    }
  });

  it("reads the real resolver, which is not opted in on a test run", { skip: process.env.OPENROUTER_SHARED_DEFAULT !== undefined }, async () => {
    const found = await meridianCredentialSource().get("openrouter", "org_1");
    assert.equal(found.status, "not_connected");
  });
});
