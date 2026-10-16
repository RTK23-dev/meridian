import assert from "node:assert/strict";
import test from "node:test";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { InstagramReelsChannel, readInstagramTrial } from "./instagram.ts";
import type { OrganicConnection, OrganicPublishRequest } from "./types.ts";

// Every receipt here comes from the injected transport. The fixtures follow the request and response shapes in Meta's documentation:
//   trial container: IG User Media reference (trial_params, media_type REELS) and the content publishing guide's Trial Reels example.
//   container status and publish: the IG Container and IG User media_publish references.
//   media read: the IG Media reference (id, media_type, media_product_type, is_shared_to_feed, permalink).
// No test calls the live API.
process.env.NODE_ENV = "development";
delete process.env.MERIDIAN_TESTING_RUNTIME;

function reply(status: number, body: unknown = {}): TransportResponse {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body), headers: {} };
}

function scripted(replies: Array<TransportResponse | Error>) {
  const requests: TransportRequest[] = [];
  let next = 0;
  const transport: Transport = async (request) => {
    requests.push(request);
    const entry = replies[next];
    next += 1;
    if (!entry) throw new Error(`unexpected request ${request.method} ${request.url}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { transport, requests };
}

const noSleep = async () => undefined;

const connection: OrganicConnection = {
  connected: true,
  platform: "instagram",
  accountId: "17841400000000001",
  accountName: "Brand",
  accessToken: "token-123",
  scopes: null,
};

function request(overrides: Partial<OrganicPublishRequest> = {}): OrganicPublishRequest {
  return {
    brandId: "brand-1",
    organizationId: "org-1",
    mediaBytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: "video/mp4",
    caption: "Caption",
    aspectRatio: "9:16",
    mediaUrl: "https://media.example.com/signed/creative-1?expires=1&sig=abc",
    connection,
    ...overrides,
  };
}

function channel(transport: Transport) {
  return new InstagramReelsChannel({ transport, sleep: noSleep, polls: 2, pollIntervalMs: 0 });
}

test("a trial Reel sends the documented JSON container body with trial_params, then publishes and returns a trial receipt", async () => {
  const { transport, requests } = scripted([
    reply(200, { id: "18000000000000010" }),
    reply(200, { status_code: "FINISHED" }),
    reply(200, { id: "18000000000000020" }),
  ]);
  const receipt = await channel(transport).publish(request({ trial: { graduationStrategy: "MANUAL" } }));

  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "18000000000000020", "the id is the one media_publish returned");
  assert.deepEqual(receipt.trial, { graduationStrategy: "MANUAL" });

  const container = requests[0];
  assert.equal(container.method, "POST");
  assert.equal(container.url, "https://graph.facebook.com/v25.0/17841400000000001/media");
  assert.equal(container.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(container.body ?? "{}")), {
    media_type: "REELS",
    video_url: "https://media.example.com/signed/creative-1?expires=1&sig=abc",
    caption: "Caption",
    trial_params: { graduation_strategy: "MANUAL" },
  });

  assert.equal(requests[1].method, "GET");
  assert.equal(requests[1].url.includes("18000000000000010?fields=status_code"), true);
  assert.equal(requests[2].url, "https://graph.facebook.com/v21.0/17841400000000001/media_publish");
  assert.equal(requests[2].body, "creation_id=18000000000000010");
});

test("the SS_PERFORMANCE strategy is sent as the documented value", async () => {
  const { transport, requests } = scripted([reply(200, { id: "c1" }), reply(200, { status_code: "FINISHED" }), reply(200, { id: "m1" })]);
  await channel(transport).publish(request({ trial: { graduationStrategy: "SS_PERFORMANCE" } }));
  assert.deepEqual(JSON.parse(String(requests[0].body ?? "{}")).trial_params, { graduation_strategy: "SS_PERFORMANCE" });
});

test("an ordinary Reel is unchanged: a form-encoded container on v21.0, no trial_params, and no trial on the receipt", async () => {
  const { transport, requests } = scripted([reply(200, { id: "c2" }), reply(200, { status_code: "FINISHED" }), reply(200, { id: "m2" })]);
  const receipt = await channel(transport).publish(request());

  assert.equal(receipt.status, "published");
  assert.equal(receipt.trial, undefined);
  assert.equal(requests[0].url, "https://graph.facebook.com/v21.0/17841400000000001/media");
  assert.equal(requests[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(String(requests[0].body ?? "").includes("trial_params"), false);
  assert.equal(String(requests[0].body ?? "").includes("media_type=REELS"), true);
});

test("a trial the container refuses is a failed receipt with no id, and nothing is published", async () => {
  const { transport, requests } = scripted([
    reply(400, { error: { message: "trial_params is not allowed for this account", type: "OAuthException", code: 100 } }),
  ]);
  const receipt = await channel(transport).publish(request({ trial: { graduationStrategy: "MANUAL" } }));

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "REJECTED");
  assert.equal(receipt.externalId, "");
  assert.equal(receipt.trial, undefined, "no trial step happened, so none is recorded");
  assert.equal(requests.length, 1, "publish is never called after a refused container");
  assert.match(receipt.error ?? "", /refused the request/);
});

test("a trial with no connected account sends nothing and reports NOT_CONNECTED", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await channel(transport).publish(
    request({ connection: { connected: false, platform: "instagram", reason: "No Instagram account is connected." }, trial: { graduationStrategy: "MANUAL" } }),
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(requests.length, 0);
});

test("the media read returns the documented fields for the same media id, with the Graph version used for trials", async () => {
  const { transport, requests } = scripted([
    reply(200, {
      id: "18000000000000010",
      media_type: "VIDEO",
      media_product_type: "REELS",
      is_shared_to_feed: false,
      permalink: "https://www.instagram.com/reel/abc123/",
    }),
  ]);
  const reading = await readInstagramTrial(transport, { mediaId: "18000000000000010", accessToken: "token-123" });

  assert.deepEqual(reading, {
    ok: true,
    mediaId: "18000000000000010",
    mediaProductType: "REELS",
    isSharedToFeed: false,
    permalink: "https://www.instagram.com/reel/abc123/",
  });
  assert.equal(requests[0].method, "GET");
  assert.equal(
    requests[0].url,
    "https://graph.facebook.com/v25.0/18000000000000010?fields=id,media_type,media_product_type,is_shared_to_feed,permalink",
  );
  assert.equal(requests[0].headers.Authorization, "Bearer token-123");
});

test("a media read with fields Meta did not send returns null for them, never false or zero", async () => {
  const { transport } = scripted([reply(200, { id: "18000000000000010" })]);
  const reading = await readInstagramTrial(transport, { mediaId: "18000000000000010", accessToken: "token-123" });
  assert.deepEqual(reading, { ok: true, mediaId: "18000000000000010", mediaProductType: null, isSharedToFeed: null, permalink: null });
});

test("a media read that returns another id is refused, not read as the reel", async () => {
  const { transport } = scripted([reply(200, { id: "18000000000000099" })]);
  const reading = await readInstagramTrial(transport, { mediaId: "18000000000000010", accessToken: "token-123" });
  assert.equal(reading.ok, false);
});

test("a refused media read is a failed read with its reason, not a state", async () => {
  const { transport } = scripted([
    reply(400, { error: { message: "Unsupported get request. Object does not exist.", code: 100 } }),
  ]);
  const reading = await readInstagramTrial(transport, { mediaId: "18000000000000010", accessToken: "token-123" });
  assert.equal(reading.ok, false);
  if (!reading.ok) assert.match(reading.error, /refused the request/);
});

test("a media read with no answer is a failed read", async () => {
  const { transport } = scripted([new Error("socket hang up")]);
  const reading = await readInstagramTrial(transport, { mediaId: "18000000000000010", accessToken: "token-123" });
  assert.equal(reading.ok, false);
  if (!reading.ok) assert.match(reading.error, /did not confirm/);
});
