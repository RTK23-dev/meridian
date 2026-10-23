import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { createGateway } from "./gateway.ts";
import { gatewayDownloader, httpsUrlOrThrow, type HostResolver } from "./download.ts";
import { recorded, staticKeys } from "./test/recorded.ts";
import { publicTestResolver } from "./test/resolver.ts";
import type { HttpResponse } from "./types.ts";

const CDN = "https://videos.pexels.com/video-files/4433001/4433001-hd_1080_1920_30fps.mp4";
const OPENROUTER_CONTENT = "https://openrouter.ai/api/v1/videos/job-abc123/content?index=0";

function bytes(status: number, body: Uint8Array): HttpResponse {
  return { status, headers: {}, body };
}

function downloaderWith(responses: HttpResponse[], resolver: HostResolver = publicTestResolver) {
  const script = recorded(responses);
  const gateway = createGateway({ transport: script.transport, credentials: staticKeys({ openrouter: "sk-or-test", pexels: "pexels-test" }) });
  return { downloader: gatewayDownloader(gateway, { resolver }), requests: script.requests };
}

describe("downloads through the gateway", () => {
  it("returns a copy of the file, and sends the provider's credential only to the provider's own host", async () => {
    const { downloader, requests } = downloaderWith([bytes(200, new Uint8Array([1, 2, 3])), bytes(200, new Uint8Array([4, 5]))]);
    const own = await downloader.download({ providerId: "openrouter", organizationId: "org_1", url: OPENROUTER_CONTENT, maxBytes: 100 });
    assert.deepEqual([...own], [1, 2, 3]);
    assert.equal(requests[0]?.headers.Authorization, "Bearer sk-or-test", "the provider's own URL is authenticated");

    const cdn = await downloader.download({ providerId: "pexels", organizationId: "org_1", url: CDN, maxBytes: 100 });
    assert.deepEqual([...cdn], [4, 5]);
    assert.equal(requests[1]?.headers.Authorization, undefined, "a CDN URL goes out with no credential");
  });

  it("refuses a URL that is not https before anything is sent", async () => {
    const { downloader, requests } = downloaderWith([]);
    await assert.rejects(
      downloader.download({ providerId: "pexels", organizationId: null, url: "http://videos.pexels.com/a.mp4", maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(requests.length, 0);
    assert.throws(() => httpsUrlOrThrow("not a url", "produce_shot"), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("a throttled or failing answer is an error, retryable for throttling and server faults and not for a missing file", async () => {
    const throttled = downloaderWith([bytes(429, new Uint8Array())]);
    await assert.rejects(
      throttled.downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "provider" && error.retryable === true,
    );
    const broken = downloaderWith([bytes(503, new Uint8Array())]);
    await assert.rejects(
      broken.downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.retryable === true,
    );
    const missing = downloaderWith([bytes(404, new Uint8Array())]);
    await assert.rejects(
      missing.downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.retryable === false,
    );
  });

  it("an empty file and a file over the limit are refused, never returned", async () => {
    const empty = downloaderWith([bytes(200, new Uint8Array())]);
    await assert.rejects(empty.downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    const big = downloaderWith([bytes(200, new Uint8Array(11))]);
    await assert.rejects(big.downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 10 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("a provider that is not connected sends nothing and says so", async () => {
    const script = recorded([]);
    const gateway = createGateway({ transport: script.transport, credentials: staticKeys({}) });
    await assert.rejects(
      gatewayDownloader(gateway, { resolver: publicTestResolver }).download({ providerId: "openrouter", organizationId: "org_1", url: OPENROUTER_CONTENT, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "config",
    );
    assert.equal(script.requests.length, 0);
  });
});

describe("the download host is checked before anything is sent", () => {
  const privateHost: HostResolver = async () => [{ address: "10.0.0.5", family: 4 }];
  const mixedHost: HostResolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const unresolvable: HostResolver = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const mustNotLookUp: HostResolver = async () => {
    throw new Error("a literal address is refused without a lookup");
  };

  it("refuses a host that resolves to a private address, and sends nothing", async () => {
    const { downloader, requests } = downloaderWith([bytes(200, new Uint8Array([1]))], privateHost);
    await assert.rejects(
      downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(requests.length, 0);
  });

  it("refuses a host with one private answer among public ones: one blocked answer blocks the download", async () => {
    const { downloader, requests } = downloaderWith([bytes(200, new Uint8Array([1]))], mixedHost);
    await assert.rejects(
      downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(requests.length, 0);
  });

  it("refuses a literal private address in the URL before any lookup", async () => {
    const { downloader, requests } = downloaderWith([bytes(200, new Uint8Array([1]))], mustNotLookUp);
    await assert.rejects(
      downloader.download({ providerId: "pexels", organizationId: null, url: "https://169.254.169.254/latest/meta-data", maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(requests.length, 0);
  });

  it("a host that does not resolve is retryable, and sends nothing", async () => {
    const { downloader, requests } = downloaderWith([bytes(200, new Uint8Array([1]))], unresolvable);
    await assert.rejects(
      downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 100 }),
      (error: unknown) => error instanceof EngineError && error.kind === "provider" && error.retryable === true,
    );
    assert.equal(requests.length, 0);
  });

  it("connects only to the addresses that were checked, and carries the byte limit to the connection", async () => {
    const checked = [{ address: "93.184.216.34", family: 4 }];
    const { downloader, requests } = downloaderWith([bytes(200, new Uint8Array([9, 9]))], async () => checked);
    await downloader.download({ providerId: "pexels", organizationId: null, url: CDN, maxBytes: 64 });
    assert.deepEqual(requests[0]?.pinnedAddresses, checked);
    assert.equal(requests[0]?.maxBodyBytes, 64);
  });
});
