// The disabled publish paths, called through their production defaults. Each call reaches the gate the way production reaches it: no transport
// is injected. A counting fetch stands in for the network, and each test asserts that it was never called and that the refusal came from
// the gate, not from an earlier check. No test reaches the network.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { FacebookPagesChannel } from "./facebook.ts";
import { InstagramReelsChannel } from "./instagram.ts";
import { TikTokOrganicChannel } from "./tiktok.ts";
import { YouTubeShortsChannel } from "./youtube.ts";
import { publishPausedStages } from "../providers/live.ts";

let requests: number;

beforeEach(() => {
  requests = 0;
  mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("A disabled publish path reached the network.");
  });
});

afterEach(() => {
  mock.restoreAll();
});

describe("disabled publish paths send nothing through their production defaults", () => {
  test("the Facebook Page channel refuses through its default transport, reports a failure, and sends no request", async () => {
    const channel = new FacebookPagesChannel();
    const receipt = await channel.publish({
      brandId: "brand_fixture",
      source: {} as never,
      creativeId: "creative_fixture",
      assetId: "asset_fixture",
      pageId: "page_fixture",
      createdBy: "user_fixture",
      caption: "A caption",
      title: "A title",
      mediaBytes: new Uint8Array([1, 2, 3]),
      mimeType: "video/mp4",
      connection: { connected: true, platform: "facebook", accountId: "page_fixture", accountName: "Fixture Page", accessToken: "fixture-token-not-real", scopes: null } as never,
      confirmRetry: false,
    } as never);
    assert.equal(receipt.status, "failed", "a refused publish is a failure, never a published post");
    assert.equal(receipt.code, "NOT_CONNECTED", "the refusal is the gate's, not an unknown outcome");
    assert.match(receipt.error ?? "", /off in this build, so nothing was sent/, "the refusal names the gate");
    assert.equal(requests, 0, "no Facebook request is sent");
  });

  test("the paused publish for Meta refuses through its default transport and reports no created stage, with no request", async () => {
    const stages = await publishPausedStages({
      provider: "meta",
      name: "Fixture paused campaign",
      dailyBudgetCents: 100,
      countries: ["US"],
      pageId: "1020",
      link: "https://example.test/offer",
      message: "A message",
      adAccountId: "act_9001",
      accessToken: "fixture-token-not-real",
      env: {},
    } as never);
    assert.ok(stages.length > 0, "the paused chain reports its stages");
    for (const stage of stages) {
      assert.notEqual(stage.status, "created", `${stage.objectType} is not reported as created`);
      assert.match(stage.error, /off in this build, so nothing was sent/, `${stage.objectType} is refused by the gate`);
    }
    assert.equal(requests, 0, "no Meta request is sent");
  });

  test("the Instagram Reels channel refuses through its default transport, reports a refused receipt, and sends no request", async () => {
    const receipt = await new InstagramReelsChannel().publish(organicRequest("instagram", "ig_fixture") as never);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.code, "NOT_CONNECTED");
    assert.match(receipt.error ?? "", /off in this build, so nothing was sent/);
    assert.equal(requests, 0, "no Instagram request is sent");
  });

  test("the YouTube Shorts channel refuses through its default transport, reports a refused receipt, and sends no request", async () => {
    const receipt = await new YouTubeShortsChannel().publish(organicRequest("youtube", "yt_fixture") as never);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.code, "NOT_CONNECTED");
    assert.match(receipt.error ?? "", /off in this build, so nothing was sent/);
    assert.equal(requests, 0, "no YouTube request is sent");
  });

  test("the TikTok channel refuses through its default transport, reports a refused receipt, and sends no request", async () => {
    // The media host must be on the verified list the request carries before TikTok is asked to pull, so the request names one.
    // The refusal is then the gate's.
    const receipt = await new TikTokOrganicChannel().publish({ ...organicRequest("tiktok", "tt_fixture"), verifiedMediaDomains: ["media.example.test"] } as never);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.code, "NOT_CONNECTED");
    assert.match(receipt.error ?? "", /off in this build, so nothing was sent/);
    assert.equal(requests, 0, "no TikTok request is sent");
  });
});

/** A connected organic publish request for one platform, with a media URL and bytes. */
function organicRequest(platform: "instagram" | "tiktok" | "youtube", accountId: string) {
  return {
    brandId: "brand_fixture",
    source: {},
    creativeId: "creative_fixture",
    assetId: "asset_fixture",
    pageId: accountId,
    createdBy: "user_fixture",
    caption: "A caption",
    title: "A title",
    mediaBytes: new Uint8Array([1, 2, 3]),
    mediaUrl: "https://media.example.test/video.mp4",
    mimeType: "video/mp4",
    connection: { connected: true, platform, accountId, accountName: "Fixture account", accessToken: "fixture-token-not-real", scopes: null },
    confirmRetry: false,
  };
}
