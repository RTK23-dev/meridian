import assert from "node:assert/strict";
import test from "node:test";
import { extractPageText, sidecarConfig, type SidecarConfig } from "./sidecar.server.ts";

const TOKEN = "test-token-0123456789abcdef";
const CONFIG: SidecarConfig = { url: "http://127.0.0.1:8765", token: TOKEN };
const FALLBACK = (html: string) => `builtin:${html.length}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("the sidecar is used only with a local address and a long enough token", () => {
  assert.equal(sidecarConfig({}), null, "nothing configured");
  assert.equal(sidecarConfig({ MERIDIAN_SOURCING_SIDECAR_URL: "http://127.0.0.1:8765", MERIDIAN_SIDECAR_TOKEN: "short" }), null);
  assert.equal(sidecarConfig({ MERIDIAN_SOURCING_SIDECAR_URL: "http://10.0.0.5:8765", MERIDIAN_SIDECAR_TOKEN: TOKEN }), null, "not a local address");
  assert.equal(sidecarConfig({ MERIDIAN_SOURCING_SIDECAR_URL: "https://127.0.0.1:8765", MERIDIAN_SIDECAR_TOKEN: TOKEN }), null, "not plain http");
  assert.deepEqual(
    sidecarConfig({ MERIDIAN_SOURCING_SIDECAR_URL: "http://localhost:8765/some/path", MERIDIAN_SIDECAR_TOKEN: TOKEN }),
    { url: "http://localhost:8765", token: TOKEN },
  );
});

test("with no sidecar, the built-in extraction reads the page and says so", async () => {
  const result = await extractPageText("<p>Hello</p>", "https://example.com/", FALLBACK, null);
  assert.deepEqual(result, { text: "builtin:12", extractor: "builtin" });
});

test("when the sidecar answers, its text is used and the request carries the token and no redirects", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse({ title: "T", text: "From the parser", links: [] });
  }) as typeof fetch;
  const result = await extractPageText("<p>Hello</p>", "https://example.com/page", FALLBACK, CONFIG, fakeFetch);
  assert.deepEqual(result, { text: "From the parser", extractor: "scrapling" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8765/parse");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-sidecar-token"], TOKEN);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { html: "<p>Hello</p>", baseUrl: "https://example.com/page" });
});

test("a sidecar that fails, times out or answers without text falls back to the built-in extraction", async () => {
  const failing = (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8765 <html>secret page text</html>"); }) as typeof fetch;
  assert.deepEqual(await extractPageText("<p>Hi</p>", "https://example.com/", FALLBACK, CONFIG, failing), { text: "builtin:9", extractor: "builtin" });

  const serverError = (async () => jsonResponse({ error: "internal error" }, 500)) as typeof fetch;
  assert.equal((await extractPageText("<p>Hi</p>", "https://example.com/", FALLBACK, CONFIG, serverError)).extractor, "builtin");

  const noText = (async () => jsonResponse({ links: [] })) as typeof fetch;
  assert.equal((await extractPageText("<p>Hi</p>", "https://example.com/", FALLBACK, CONFIG, noText)).extractor, "builtin");
});

test("the error from a failed sidecar call is not returned, because it can carry part of the page", async () => {
  const failing = (async () => { throw new Error("secret page text"); }) as typeof fetch;
  const result = await extractPageText("<p>Hi</p>", "https://example.com/", FALLBACK, CONFIG, failing);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
