import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  MAX_ARTIFACT_BYTES,
  downloadProviderArtifact,
  finalizeProductionArtifact,
  hostAllowed,
  parseHostAllowlist,
} from "./artifact-finalizer.ts";
import type { Sql } from "../learning/store.ts";
import type { GoogleDriveClient } from "../storage/drive.ts";

const VALID_MP4 = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes");
const PUBLIC_URL = "https://cdn.example.com/render/output.mp4";

/** A fetch spy. It records each URL and the init it was called with, and answers with `respond`. */
function spyFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** A resolver that answers with fixed addresses, so no test depends on the network's DNS. */
function resolverFor(addresses: string[]) {
  const asked: string[] = [];
  const resolver = async (hostname: string) => {
    asked.push(hostname);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { asked, resolver };
}

test("the artifact bounds are the documented ones: 200 MB and 30 seconds", () => {
  assert.equal(MAX_ARTIFACT_BYTES, 200 * 1024 * 1024);
  assert.equal(ARTIFACT_DOWNLOAD_TIMEOUT_MS, 30_000);
});

test("an http artifact URL is refused before any request is made", async () => {
  const { calls, fetchImpl } = spyFetch(() => new Response(VALID_MP4, { status: 200 }));
  const result = await downloadProviderArtifact("http://cdn.example.com/output.mp4", { fetchImpl });
  assert.deepEqual(
    { ok: result.ok, status: "status" in result ? result.status : undefined, errorCode: "errorCode" in result ? result.errorCode : undefined },
    { ok: false, status: "FAILED", errorCode: "ARTIFACT_URL_REFUSED" },
  );
  assert.equal(calls.length, 0);
});

test("loopback, private, link-local and metadata addresses are refused before any request, with or without DNS", async () => {
  const targets = [
    "https://127.0.0.1/output.mp4",
    "https://10.0.0.7/output.mp4",
    "https://192.168.1.10/output.mp4",
    "https://172.16.4.2/output.mp4",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/output.mp4",
    "https://[fe80::1]/output.mp4",
    "https://localhost/output.mp4",
    "https://metadata.google.internal/output.mp4",
    "https://user:secret@cdn.example.com/output.mp4",
  ];
  for (const target of targets) {
    const { calls, fetchImpl } = spyFetch(() => new Response(VALID_MP4, { status: 200 }));
    const withTransport = await downloadProviderArtifact(target, { fetchImpl });
    assert.equal(withTransport.ok, false, `${target} is refused on the injected transport`);
    assert.equal(calls.length, 0, `${target} made no request`);

    // The pinned path refuses a literal address without asking DNS at all.
    const { asked, resolver } = resolverFor(["93.184.216.34"]);
    const pinned = await downloadProviderArtifact(target, { resolver });
    assert.equal(pinned.ok, false, `${target} is refused on the pinned path`);
    assert.equal(asked.length, 0, `${target} did not reach DNS`);
  }
});

test("a host name that resolves to any private address is refused, and nothing is requested", async () => {
  for (const answers of [["10.1.2.3"], ["93.184.216.34", "127.0.0.1"], ["169.254.10.10"], ["::1"]]) {
    const { resolver } = resolverFor(answers);
    const result = await downloadProviderArtifact(PUBLIC_URL, { resolver });
    assert.deepEqual(
      { ok: result.ok, errorCode: "errorCode" in result ? result.errorCode : undefined },
      { ok: false, errorCode: "ARTIFACT_URL_REFUSED" },
      `answers ${answers.join(", ")} are refused`,
    );
  }
});

test("a host name that does not resolve is retried, not refused", async () => {
  const resolver = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const result = await downloadProviderArtifact(PUBLIC_URL, { resolver });
  assert.deepEqual(
    { ok: result.ok, status: "status" in result ? result.status : undefined },
    { ok: false, status: "WAITING_FOR_ARTIFACT" },
  );
});

test("requests use redirect: manual and carry an abort signal, so no redirect is followed silently", async () => {
  const { calls, fetchImpl } = spyFetch(() => new Response(VALID_MP4, { status: 200 }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

test("a redirect is checked on every hop: a hop to http or to a private address is refused", async () => {
  const toHttp = spyFetch(() => new Response(null, { status: 302, headers: { Location: "http://cdn.example.com/x.mp4" } }));
  const refusedHttp = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl: toHttp.fetchImpl });
  assert.equal("errorCode" in refusedHttp ? refusedHttp.errorCode : undefined, "ARTIFACT_URL_REFUSED");
  assert.equal(toHttp.calls.length, 1, "the http hop was never requested");

  const toPrivate = spyFetch(() => new Response(null, { status: 307, headers: { Location: "https://10.0.0.9/x.mp4" } }));
  const refusedPrivate = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl: toPrivate.fetchImpl });
  assert.equal("errorCode" in refusedPrivate ? refusedPrivate.errorCode : undefined, "ARTIFACT_URL_REFUSED");
  assert.equal(toPrivate.calls.length, 1, "the private hop was never requested");
});

test("a public https redirect is followed, and each hop is requested with the same checks", async () => {
  const { calls, fetchImpl } = spyFetch((url) => {
    if (url === PUBLIC_URL) return new Response(null, { status: 302, headers: { Location: "https://storage.example.net/render.mp4" } });
    return new Response(VALID_MP4, { status: 200 });
  });
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.url), [PUBLIC_URL, "https://storage.example.net/render.mp4"]);
});

test("a redirect loop stops after the redirect limit", async () => {
  const { calls, fetchImpl } = spyFetch(() => new Response(null, { status: 302, headers: { Location: PUBLIC_URL } }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl });
  assert.equal("errorCode" in result ? result.errorCode : undefined, "ARTIFACT_URL_REFUSED");
  assert.ok(calls.length >= 2 && calls.length <= 5, `the loop stopped after a bounded number of hops (${calls.length})`);
});

test("a redirect with no target is refused", async () => {
  const { fetchImpl } = spyFetch(() => new Response(null, { status: 301 }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl });
  assert.equal("errorCode" in result ? result.errorCode : undefined, "ARTIFACT_URL_REFUSED");
});

test("an artifact declared larger than the cap is refused before its body is read", async () => {
  // highWaterMark 0: the stream produces a chunk only when something reads it, so `pulled` counts reads.
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(100));
      },
    },
    { highWaterMark: 0 },
  );
  const { fetchImpl } = spyFetch(() => new Response(body, { status: 200, headers: { "Content-Length": "5000" } }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, maxBytes: 1000 });
  assert.deepEqual(
    { ok: result.ok, errorCode: "errorCode" in result ? result.errorCode : undefined },
    { ok: false, errorCode: "ARTIFACT_TOO_LARGE" },
  );
  assert.equal(pulled, 0, "the oversized body was never read");
});

test("a body that grows past the cap without a Content-Length is cut off at the cap", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(400));
      if (pulled >= 1000) controller.close();
    },
  });
  const { fetchImpl } = spyFetch(() => new Response(body, { status: 200 }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, maxBytes: 1000 });
  assert.equal("errorCode" in result ? result.errorCode : undefined, "ARTIFACT_TOO_LARGE");
  assert.ok(pulled < 10, `reading stopped at the cap, after ${pulled} chunks of 400 bytes`);
});

test("a download that never answers is abandoned at the deadline and retried", async () => {
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
  const started = Date.now();
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal("status" in result ? result.status : undefined, "WAITING_FOR_ARTIFACT");
  assert.ok(Date.now() - started < 2_000, "the timeout ended the wait");
});

test("a body that stalls is abandoned at the deadline even when the transport ignores the signal", async () => {
  const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
  const fetchImpl = (async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch;
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, timeoutMs: 30 });
  assert.equal("status" in result ? result.status : undefined, "WAITING_FOR_ARTIFACT");
});

test("a non-2xx answer is retried, not refused", async () => {
  const { fetchImpl } = spyFetch(() => new Response("busy", { status: 503 }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl });
  assert.equal("status" in result ? result.status : undefined, "WAITING_FOR_ARTIFACT");
});

test("a complete artifact within the cap is returned whole", async () => {
  const { fetchImpl } = spyFetch(() => new Response(VALID_MP4, { status: 200, headers: { "Content-Length": String(VALID_MP4.byteLength) } }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(createHash("sha256").update(result.bytes).digest("hex"), createHash("sha256").update(VALID_MP4).digest("hex"));
});

test("finalizeProductionArtifact: a refused artifact URL fails the job with the reason and never reaches storage", async () => {
  let drivePuts = 0;
  const drive = {
    put: async () => {
      drivePuts += 1;
      return { fileId: "unexpected" };
    },
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };
  const sql = (async (strings: TemplateStringsArray) => {
    if (strings.join("?").includes("select id, modality from production_jobs")) return [{ id: "job-refused-1", modality: "video" }];
    return [];
  }) as unknown as Sql;

  const result = await finalizeProductionArtifact(sql, {
    jobId: "job-refused-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "higgsfield",
    rawArtifact: { uri: "https://10.0.0.5/output.mp4" },
    options: { driveClient: drive as unknown as GoogleDriveClient, resolver: resolverFor(["93.184.216.34"]).resolver },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "ARTIFACT_URL_REFUSED");
  assert.equal(result.error?.includes("10.0.0.5"), false, "the refusal does not echo the URL");
  assert.equal(drivePuts, 0);
});

test("the artifact host allowlist parses domains and matches them and their subdomains only", () => {
  assert.deepEqual(parseHostAllowlist(undefined), []);
  assert.deepEqual(parseHostAllowlist(" CDN.Example.com., *.render.example ,"), ["cdn.example.com", "render.example"]);
  assert.equal(hostAllowed("anything.example.org", []), true, "no allowlist: any public host passes");
  assert.equal(hostAllowed("cdn.example.com", ["cdn.example.com"]), true);
  assert.equal(hostAllowed("eu.cdn.example.com", ["cdn.example.com"]), true, "a subdomain of an allowed domain");
  assert.equal(hostAllowed("evilcdn.example.com", ["cdn.example.com"]), false, "a suffix that is not a subdomain");
  assert.equal(hostAllowed("cdn.example.com.attacker.net", ["cdn.example.com"]), false);
});

test("an artifact host that is not on the allowlist is refused before any request", async () => {
  const { calls, fetchImpl } = spyFetch(() => new Response(VALID_MP4, { status: 200 }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, allowedHosts: ["renders.example.net"] });
  assert.equal("errorCode" in result ? result.errorCode : undefined, "ARTIFACT_URL_REFUSED");
  assert.equal(calls.length, 0, "the unlisted host was never requested");
});

test("an allowlisted host is downloaded", async () => {
  const { calls, fetchImpl } = spyFetch(() => new Response(VALID_MP4, { status: 200, headers: { "content-type": "video/mp4" } }));
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, allowedHosts: ["example.com"] });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("a redirect from an allowed host to an unlisted host is refused on that hop", async () => {
  const { calls, fetchImpl } = spyFetch((url) =>
    url === PUBLIC_URL
      ? new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.org/out.mp4" } })
      : new Response(VALID_MP4, { status: 200 }),
  );
  const result = await downloadProviderArtifact(PUBLIC_URL, { fetchImpl, allowedHosts: ["example.com"] });
  assert.equal("errorCode" in result ? result.errorCode : undefined, "ARTIFACT_URL_REFUSED");
  assert.deepEqual(calls.map((call) => call.url), [PUBLIC_URL], "the unlisted hop was never requested");
});
