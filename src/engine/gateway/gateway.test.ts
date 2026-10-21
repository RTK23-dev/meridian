import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { routes } from "../config/routes.ts";
import { createGateway } from "./gateway.ts";
import type { CredentialSource } from "./types.ts";
import { json, recorded, staticKeys } from "./test/recorded.ts";

describe("gateway routing", () => {
  it("routes the Claude roles to OpenRouter by default", () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
    for (const capability of ["llm.direction", "llm.analysis", "llm.check"] as const) {
      const route = gateway.route(capability);
      assert.equal(route.provider.id, "openrouter");
      assert.match(route.model, /^anthropic\/claude-/);
    }
  });

  it("refuses a capability whose first target has no model instead of falling back", () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
    assert.throws(() => gateway.route("video.budget"), (error: unknown) => error instanceof EngineError && error.kind === "config");
    // stt is routed to Deepgram (owner decision 2026-10-16): its first target has a model, so it resolves to deepgram's nova-3.
    assert.equal(gateway.route("stt").provider.id, "deepgram");
    assert.equal(gateway.route("stt").model, "nova-3");
    // The table names no model for video.budget any more: the live catalog chooses one (Bible 10.5). Nothing is listed as a fallback.
    assert.deepEqual(gateway.routes("video.budget").map((route) => route.model), []);
  });

  it("a chosen model keeps the table's provider, carries the chosen id, and has no table price", () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
    const route = gateway.chosen("video.cinematic", "kwaivgi/kling-v3.0-std");
    assert.equal(route.provider.id, "openrouter");
    assert.equal(route.model, "kwaivgi/kling-v3.0-std");
    assert.equal(route.priceKey, null, "the cost is estimated from the catalog entry the model was chosen from");
    assert.throws(() => gateway.chosen("video.cinematic", "not a model id"), (error: unknown) => error instanceof EngineError && error.kind === "config");
  });

  it("switches a capability to another provider through the route table alone", async () => {
    const table = { ...routes.table, "llm.check": { targets: [{ provider: "anthropic", model: "claude-haiku-5-5", priceKey: null, verified: false }] } };
    const { transport, requests } = recorded([json(200, {})]);
    const gateway = createGateway({ transport, credentials: staticKeys({ anthropic: "sk-ant-test" }), routes: table });
    const route = gateway.route("llm.check");
    assert.equal(route.provider.id, "anthropic");
    await gateway.call({ provider: route.provider.id, organizationId: "org_1", method: "POST", path: "/messages", body: "{}" });
    assert.equal(requests[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(requests[0]?.headers["x-api-key"], "sk-ant-test");
    assert.equal(requests[0]?.headers["anthropic-version"], "2023-06-01");
    assert.equal(requests[0]?.headers.Authorization, undefined);
  });
});

describe("gateway authentication", () => {
  it("adds the OpenRouter key as a bearer token", async () => {
    const { transport, requests } = recorded([json(200, { ok: true })]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const result = await gateway.call({ provider: "openrouter", organizationId: "org_1", method: "GET", path: "/models" });
    assert.equal(result.status, "ok");
    assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/models");
    assert.equal(requests[0]?.headers.Authorization, "Bearer sk-or-test");
  });

  it("sends nothing when the provider is not connected", async () => {
    const { transport, requests } = recorded([]);
    const gateway = createGateway({ transport, credentials: staticKeys({}) });
    const result = await gateway.call({ provider: "openrouter", organizationId: "org_1", method: "GET", path: "/models" });
    assert.deepEqual(result, { status: "not_connected", reason: "no openrouter key" });
    assert.equal(requests.length, 0);
  });

  it("treats a provider with no base URL as not connected until the deployment sets one", async () => {
    const { transport, requests } = recorded([json(200, {})]);
    const unset = createGateway({ transport, credentials: staticKeys({}) });
    assert.equal((await unset.connection("media_functions", "org_1")).connected, false);
    await assert.rejects(unset.transportFor("media_functions", "org_1")({ method: "POST", url: "https://fn.example/probe", headers: {} }), /not connected/);
    const set = createGateway({ transport, credentials: staticKeys({}), providers: { media_functions: { baseUrl: "https://fn.example/" } } });
    assert.equal(set.baseUrlFor("media_functions"), "https://fn.example");
    await set.transportFor("media_functions", "org_1")({ method: "POST", url: "https://fn.example/probe", headers: {} });
    assert.equal(requests.length, 1);
  });

  it("never sends a key to another host, even through the provider's transport", async () => {
    const { transport, requests } = recorded([json(200, {}), json(200, {})]);
    const gateway = createGateway({ transport, credentials: staticKeys({ heygen: "hg-key" }) });
    const heygen = gateway.transportFor("heygen", "org_1");
    await heygen({ method: "GET", url: "https://api.heygen.com/v3/hyperframes/renders/r1", headers: {} });
    await heygen({ method: "GET", url: "https://api.heygen.com.evil.example/video.mp4", headers: {} });
    assert.equal(requests[0]?.headers["x-api-key"], "hg-key");
    assert.equal(requests[1]?.headers["x-api-key"], undefined);
  });

  it("replaces a caller's auth header whatever its case", async () => {
    const { transport, requests } = recorded([json(200, {})]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    await gateway.call({ provider: "openrouter", organizationId: null, method: "GET", path: "/models", headers: { authorization: "Bearer other" } });
    assert.deepEqual(
      Object.entries(requests[0]?.headers ?? {}).filter(([name]) => name.toLowerCase() === "authorization"),
      [["Authorization", "Bearer sk-or-test"]],
    );
  });

  it("refreshes an OAuth token once on 401 and retries", async () => {
    let refreshed = 0;
    const credentials: CredentialSource = {
      async get() {
        return { status: "ready", credential: { kind: "oauth", accessToken: "old", expiresAt: null } };
      },
      async refresh() {
        refreshed += 1;
        return { status: "ready", credential: { kind: "oauth", accessToken: "new", expiresAt: null } };
      },
    };
    const { transport, requests } = recorded([json(401, {}), json(200, { ok: true })]);
    const gateway = createGateway({
      transport,
      credentials,
      providers: { openrouter: { auth: { kind: "oauth", header: "Authorization" } } },
    });
    const result = await gateway.call({ provider: "openrouter", organizationId: "org_1", method: "GET", path: "/models" });
    assert.equal(result.status === "ok" && result.response.status, 200);
    assert.equal(refreshed, 1);
    assert.deepEqual(requests.map((request) => request.headers.Authorization), ["Bearer old", "Bearer new"]);
  });

  it("does not retry a 401 for an API key", async () => {
    const { transport, requests } = recorded([json(401, {})]);
    const gateway = createGateway({ transport, credentials: staticKeys({ openrouter: "bad" }) });
    const result = await gateway.call({ provider: "openrouter", organizationId: null, method: "GET", path: "/models" });
    assert.equal(result.status === "ok" && result.response.status, 401);
    assert.equal(requests.length, 1);
  });

  it("gives the key to an adapter that needs it, and null when not connected", async () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({ heygen: "hg-key" }) });
    assert.equal(await gateway.secretFor("heygen", "org_1")(), "hg-key");
    assert.equal(await gateway.secretFor("anthropic", "org_1")(), null);
  });

  it("adds a query-parameter key (Pixabay) only to the provider's own host", async () => {
    const { transport, requests } = recorded([json(200, {}), json(200, {})]);
    const gateway = createGateway({ transport, credentials: staticKeys({ pixabay: "px-key" }) });
    await gateway.call({ provider: "pixabay", organizationId: "org_1", method: "GET", path: "/videos/?q=soap&key=forged" });
    const sent = new URL(requests[0]?.url ?? "");
    assert.equal(sent.origin + sent.pathname, "https://pixabay.com/api/videos/");
    assert.deepEqual(sent.searchParams.getAll("key"), ["px-key"], "the caller's key value is replaced, never added beside");
    assert.equal(sent.searchParams.get("q"), "soap");
    await gateway.transportFor("pixabay", "org_1")({ method: "GET", url: "https://cdn.pixabay.com/video/1.mp4", headers: {} });
    assert.equal(new URL(requests[1]?.url ?? "").searchParams.get("key"), null, "no key on the CDN");
  });

  it("sends no stock request when the stock key is not connected", async () => {
    const { transport, requests } = recorded([]);
    const gateway = createGateway({ transport, credentials: staticKeys({}) });
    const result = await gateway.call({ provider: "pexels", organizationId: "org_1", method: "GET", path: "/videos/search?query=soap" });
    assert.equal(result.status, "not_connected");
    assert.equal(requests.length, 0);
  });

  it("refuses an unknown provider", () => {
    const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
    assert.throws(() => gateway.provider("nope"), /unknown provider/);
  });
});
