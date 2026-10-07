import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutopilotLevelAllowed,
  checkMetaRoundTripReceipt,
} from "./autopilot.ts";
import type { Sql } from "../learning/store.ts";

function fixtureDb(options: {
  videoConfirmed?: boolean;
  campaignCreated?: boolean;
  performanceSynced?: boolean;
} = {}): Sql {
  return (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join(" ").toLowerCase();
    if (text.includes("from meta_video_uploads")) {
      return [{ count: options.videoConfirmed ? "1" : "0" }];
    }
    if (text.includes("from provider_objects")) {
      return [{ count: options.campaignCreated ? "1" : "0" }];
    }
    if (text.includes("from performance_observations")) {
      return [{ count: options.performanceSynced ? "1" : "0" }];
    }
    return [];
  }) as Sql;
}

test("Autopilot Gate: levels 0 and 1 (Suggest, Produce) are allowed unconditionally", async () => {
  const db = fixtureDb({}); // No Meta round trip at all
  await assertAutopilotLevelAllowed(db, "brand-1", 0);
  await assertAutopilotLevelAllowed(db, "brand-1", 1);
});

test("Autopilot Gate: level 2 and 3 are blocked when Meta round-trip is missing", async () => {
  const emptyDb = fixtureDb({});
  const receipt = await checkMetaRoundTripReceipt(emptyDb, "brand-1");
  assert.equal(receipt.ok, false);
  assert.equal(receipt.missing.length, 3);
  assert.ok(receipt.missing.includes("confirmed Meta MP4 video upload"));
  assert.ok(receipt.missing.includes("paused Meta campaign creation receipt"));
  assert.ok(receipt.missing.includes("synced Meta performance observations"));

  await assert.rejects(
    async () => {
      await assertAutopilotLevelAllowed(emptyDb, "brand-1", 2);
    },
    (err: Error) => {
      assert.match(err.message, /requires a verified Meta test-account round trip/);
      assert.match(err.message, /Missing evidence: confirmed Meta MP4 video upload/);
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await assertAutopilotLevelAllowed(emptyDb, "brand-1", 3);
    },
    (err: Error) => {
      assert.match(err.message, /requires a verified Meta test-account round trip/);
      return true;
    },
  );
});

test("Autopilot Gate: level 2 and 3 are enabled when Meta round-trip is confirmed", async () => {
  const verifiedDb = fixtureDb({
    videoConfirmed: true,
    campaignCreated: true,
    performanceSynced: true,
  });

  const receipt = await checkMetaRoundTripReceipt(verifiedDb, "brand-1");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.missing.length, 0);

  // Both stage (2) and run (3) can now execute
  await assertAutopilotLevelAllowed(verifiedDb, "brand-1", 2);
  await assertAutopilotLevelAllowed(verifiedDb, "brand-1", 3);
});
