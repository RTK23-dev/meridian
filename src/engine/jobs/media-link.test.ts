import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, notConnectedMediaLinks, sourceUrlResolver, type MediaLinkSigner } from "./media-link.ts";

const KEY = "engine/org_1/req_1/render/vid_1.mp4";

/** A signer that records each call and answers with the given result. */
function recording(answer: Awaited<ReturnType<MediaLinkSigner["sign"]>>): { signer: MediaLinkSigner; calls: Array<{ org: string; key: string; ttl: number }> } {
  const calls: Array<{ org: string; key: string; ttl: number }> = [];
  return {
    calls,
    signer: {
      async sign(org, key, ttl) {
        calls.push({ org, key, ttl });
        return answer;
      },
    },
  };
}

test("the source link is 15 minutes, for the organization of the request, and the signed URL is what Shotstack is given", async () => {
  const { signer, calls } = recording({ status: "ok", url: "https://meridian.example.com/api/engine-media?org=org_1" });
  const resolve = sourceUrlResolver({ signer, organizationId: "org_1" });
  assert.equal(await resolve(KEY), "https://meridian.example.com/api/engine-media?org=org_1");
  assert.deepEqual(calls, [{ org: "org_1", key: KEY, ttl: 900 }]);
  assert.equal(ENGINE_MEDIA_LINK_TTL_SECONDS, 900);
});

test("a signer that is not connected stops the stage with its reason, prefixed NOT_CONNECTED, and nothing is sent", async () => {
  const resolve = sourceUrlResolver({ signer: notConnectedMediaLinks("MEDIA_LINK_SECRET is not set"), organizationId: "org_1" });
  await assert.rejects(
    () => resolve(KEY),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "config" &&
      error.message.startsWith("NOT_CONNECTED: ") &&
      error.message.includes("MEDIA_LINK_SECRET is not set"),
  );
});

test("a link that is not https is refused, because Shotstack fetches only https", async () => {
  const { signer } = recording({ status: "ok", url: "http://meridian.example.com/api/engine-media?org=org_1" });
  const resolve = sourceUrlResolver({ signer, organizationId: "org_1" });
  await assert.rejects(() => resolve(KEY), (error: unknown) => error instanceof EngineError && error.kind === "config");
});

test("a source the signer refuses (not an engine object) is invalid input, not a service fault, and no link is made", async () => {
  const { signer, calls } = recording({ status: "refused", reason: "the object is not an engine media object of this organization" });
  const resolve = sourceUrlResolver({ signer, organizationId: "org_1" });
  await assert.rejects(
    () => resolve("https://cdn.example.com/clip.mp4"),
    (error: unknown) =>
      error instanceof EngineError &&
      error.kind === "invalid_input" &&
      !error.message.startsWith("NOT_CONNECTED") &&
      error.message.includes("not an engine media object"),
  );
  assert.equal(calls.length, 1, "the signer was asked once, and it refused");
});
