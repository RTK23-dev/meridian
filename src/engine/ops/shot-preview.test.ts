// A shot's take as a link for a reviewer, and the cost of a remake before it is confirmed (Bible 5.5), on a delivered video on PGlite.
// The link is signed by a test signer, so no media host is called. Nothing here calls a live provider.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fx from "../contracts/fixtures/index.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, type MediaLinkResult, type MediaLinkSigner } from "../jobs/media-link.ts";
import { engineRequestFeed, engineRequestStatus, quoteEngineShotRemake, shotTakeLink, takeOfShot, type RemakePorts } from "../api/index.ts";
import { takeSchema } from "../contracts/take.ts";
import { readArtifact } from "../jobs/artifact-store.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { chainWorld, drain, startChainRequest } from "./test/chain.ts";

const ORG = "org_shot_preview";
const BRAND = "brand_shot_preview";
const NOW = "2026-10-18T10:00:00.000Z";
const PORTS: RemakePorts = { monthBudget: { monthBudget: async () => ({ status: "known", usd: 1000 }) } };

type SignCall = { organizationId: string; key: string; ttlSeconds: number };

function recordingSigner(result: (call: SignCall) => MediaLinkResult, calls: SignCall[]): MediaLinkSigner {
  return {
    sign: async (organizationId, key, ttlSeconds) => {
      const call = { organizationId, key, ttlSeconds };
      calls.push(call);
      return result(call);
    },
  };
}

describe("a shot's take and a remake's cost, on a delivered video", () => {
  let db: TestDatabase;
  let requestId = "";
  let shot = "";

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
    const world = await chainWorld(db.sql, ORG);
    const started = await startChainRequest(world, { slot: 5, brandId: BRAND, formatId: "fmt_shot_preview", priority: "normal", variantCount: 0 });
    await drain(db.sql, world.runtime, ORG);
    requestId = started.requestId;
    const ids = world.requests.get(requestId)?.ids;
    assert.ok(ids, "the chain world holds the request's ids");
    shot = ids.id(fx.FIXTURE_IDS.shot1);
    assert.equal((await engineRequestStatus(db.sql, ORG, requestId))?.status, "delivered");
  });

  after(async () => {
    await db.close();
  });

  test("a delivered shot links to its take, through the organization's signer, for 15 minutes", async () => {
    const calls: SignCall[] = [];
    const link = await shotTakeLink(db.sql, { organizationId: ORG, requestId, shotId: shot }, recordingSigner(() => ({ status: "ok", url: "https://media.example.test/take.mp4?sig=test" }), calls));
    assert.equal(link.status, "ready", link.status === "ready" ? "" : link.reason);
    if (link.status !== "ready") return;
    assert.equal(link.ttlSeconds, ENGINE_MEDIA_LINK_TTL_SECONDS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.organizationId, ORG);
    assert.equal(calls[0]?.ttlSeconds, ENGINE_MEDIA_LINK_TTL_SECONDS);
    // The signer is given the take's own stored uri, the object its record names, and no other.
    const read = await readEngineRequest(db.sql, ORG, requestId);
    const takeId = read ? takeOfShot(read.state, shot) : null;
    const artifactId = takeId === null ? undefined : read?.state.artifacts[`take:${takeId}`];
    assert.ok(artifactId, "the shot's take is stored");
    const stored = takeSchema.parse((await readArtifact(db.sql, { organizationId: ORG, artifactId })).envelope.body);
    assert.equal(calls[0]?.key, stored.uri, "the signer is given the take's stored uri");
  });

  test("a signer that is not connected says so, and no link is shown", async () => {
    const link = await shotTakeLink(db.sql, { organizationId: ORG, requestId, shotId: shot }, recordingSigner(() => ({ status: "not_connected", reason: "no secret" }), []));
    assert.deepEqual(link, { status: "not_connected", reason: "no secret" });
  });

  test("a shot the plan has no take for shows that it is not ready, and nothing is signed", async () => {
    const calls: SignCall[] = [];
    const link = await shotTakeLink(db.sql, { organizationId: ORG, requestId, shotId: "shot_never_made" }, recordingSigner(() => ({ status: "ok", url: "https://x.test" }), calls));
    assert.equal(link.status, "not_ready");
    assert.equal(calls.length, 0);
  });

  test("a remake is quoted before it is confirmed: the estimate is shown, nothing is reserved, and the revision does not move", async () => {
    const before = await engineRequestFeed(db.sql, ORG, requestId);
    const first = await quoteEngineShotRemake(db.sql, { organizationId: ORG, requestId, shotId: shot, now: NOW }, PORTS);
    assert.equal(first.status, "quoted", first.status === "refused" ? first.reasons.join("; ") : "");
    if (first.status !== "quoted") return;
    assert.equal(first.fits, true, first.reasons.join("; "));
    assert.equal(first.revision, 1);
    assert.ok(first.reservedUsd >= first.estimateUsd, "the reservation covers the estimate");

    const second = await quoteEngineShotRemake(db.sql, { organizationId: ORG, requestId, shotId: shot, now: NOW }, PORTS);
    assert.deepEqual(second, first, "the same quote twice, because nothing was reserved between them");
    const after = await engineRequestFeed(db.sql, ORG, requestId);
    assert.equal(after?.revision, before?.revision, "a quote changes no revision");
  });

  test("a shot the plan does not have is refused by the quote, with its reason", async () => {
    const quote = await quoteEngineShotRemake(db.sql, { organizationId: ORG, requestId, shotId: "shot_never_made", now: NOW }, PORTS);
    assert.equal(quote.status, "refused");
    if (quote.status === "refused") assert.ok(quote.reasons.length > 0);
  });
});
