import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MULTI_SOURCE_ADAPTERS } from "./planner.ts";
import { groupSources, SOURCE_CAPABILITIES } from "./source-capabilities.ts";

describe("what each discovery source can do", () => {
  test("every planned source is described, so none is shown without an honest label", () => {
    for (const id of MULTI_SOURCE_ADAPTERS) assert.ok(SOURCE_CAPABILITIES[id], `${id} has no capability entry`);
  });

  test("only the three sources that call a search API are offered as keyed search", () => {
    const { search, unavailable } = groupSources(MULTI_SOURCE_ADAPTERS.map((adapterId) => ({ adapterId })));
    assert.deepEqual(search.map((source) => source.adapterId).sort(), ["meta_ad_library", "search", "youtube"]);
    assert.equal(unavailable.length, MULTI_SOURCE_ADAPTERS.length - 3);
  });

  test("a source that cannot search never asks for a key, and says what to do instead", () => {
    for (const [id, capability] of Object.entries(SOURCE_CAPABILITIES)) {
      if (capability.searchesByPhrase) continue;
      assert.doesNotMatch(capability.summary, /using your own/i, id);
      assert.ok(capability.instead, `${id} offers no alternative`);
    }
  });
});

import { socialPlatformOf } from "./source-capabilities.ts";

describe("a pasted social URL", () => {
  test("is recognised by host, with or without a scheme or www", () => {
    assert.equal(socialPlatformOf("https://www.instagram.com/p/abc/")?.id, "instagram");
    assert.equal(socialPlatformOf("tiktok.com/@brand/video/1")?.id, "tiktok");
    assert.equal(socialPlatformOf("https://x.com/brand/status/1")?.id, "twitter");
    assert.equal(socialPlatformOf("m.facebook.com/brand")?.id, "facebook");
  });

  test("an ordinary shop URL, a phrase and a look-alike host are not social", () => {
    assert.equal(socialPlatformOf("https://shop.example/sponge"), null);
    assert.equal(socialPlatformOf("artisan sourdough"), null);
    assert.equal(socialPlatformOf("https://notinstagram.com/p/1"), null);
  });
});
