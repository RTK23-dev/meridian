import assert from "node:assert/strict";
import test from "node:test";
import { FacebookPagesChannel } from "./facebook.ts";
import { InstagramReelsChannel } from "./instagram.ts";
import { YouTubeShortsChannel } from "./youtube.ts";
import type { OrganicPublishRequest } from "./types.ts";

// Live publishing is not implemented in this build. With credentials present, an adapter must not report a receipt it
// did not get from a provider. These tests run outside the testing runtime, so no test-provider path is available.

const ENV_KEYS = [
  "MERIDIAN_TESTING_RUNTIME",
  "INSTAGRAM_ACCESS_TOKEN",
  "META_ACCESS_TOKEN",
  "INSTAGRAM_ACCOUNT_ID",
  "FACEBOOK_PAGE_ID",
  "FACEBOOK_PAGE_ACCESS_TOKEN",
  "YOUTUBE_ACCESS_TOKEN",
  "YOUTUBE_CHANNEL_ID",
  "GOOGLE_ACCESS_TOKEN",
];

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>) {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };
}

function request(overrides: Partial<OrganicPublishRequest> = {}): OrganicPublishRequest {
  const png = new Uint8Array(64);
  // Video bytes: an MP4 'ftyp' box. The channels check MIME type, not bytes, so this only needs to be non-empty.
  return {
    brandId: "brand-honesty",
    organizationId: "org-honesty",
    mediaBytes: png,
    mimeType: "video/mp4",
    caption: "A caption",
    aspectRatio: "9:16",
    ...overrides,
  };
}

const CONFIGURED = {
  INSTAGRAM_ACCESS_TOKEN: "ig-token-not-real",
  INSTAGRAM_ACCOUNT_ID: "1789",
  FACEBOOK_PAGE_ID: "page-1",
  FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token-not-real",
  YOUTUBE_ACCESS_TOKEN: "yt-token-not-real",
  YOUTUBE_CHANNEL_ID: "channel-1",
};

function assertNoReceipt(receipt: { status: string; externalId: string; postUrl?: string }) {
  assert.equal(receipt.status, "failed", "a live publish that is not implemented fails");
  assert.equal(receipt.externalId, "", "no external id is invented");
  assert.equal(receipt.postUrl, undefined, "no post URL is invented");
}

test("Instagram with credentials present does not report a fabricated published receipt", withEnv(CONFIGURED, async () => {
  const receipt = await new InstagramReelsChannel().publish(request());
  assertNoReceipt(receipt);
}));

test("Facebook with credentials present does not report a fabricated published receipt", withEnv(CONFIGURED, async () => {
  const receipt = await new FacebookPagesChannel().publish(request({ mimeType: "video/mp4", aspectRatio: "16:9" }));
  assertNoReceipt(receipt);
}));

test("YouTube with credentials present does not report a fabricated published receipt", withEnv(CONFIGURED, async () => {
  const receipt = await new YouTubeShortsChannel().publish(request());
  assertNoReceipt(receipt);
}));

test("the test-provider receipt is refused outside the testing runtime, even when a caller asks for it", withEnv({}, async () => {
  const receipt = await new InstagramReelsChannel().publish(request({ allowTestProvider: true }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.externalId, "");
}));
