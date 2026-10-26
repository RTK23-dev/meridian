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
