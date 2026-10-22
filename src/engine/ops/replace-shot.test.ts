// A remake that replaces one shot's visual type and source (Video Engine Bible 5.5, D7), on a delivered video on PGlite. The plan keeps every
// other shot; the replaced shot is made again by the produce path; a replacement the produce path cannot make is refused before anything is
// written. Nothing here calls a live provider.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fx from "../contracts/fixtures/index.ts";
import { engineRequestFeed, engineRequestStatus, remakeEngineShot, type RemakePorts, type ShotReplacement } from "../api/index.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { readArtifact } from "../jobs/artifact-store.ts";
import { scenePlanSchema } from "../contracts/plan.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { chainWorld, drain, startChainRequest } from "./test/chain.ts";
import { answerRemadeChain } from "./test/remade.ts";

const ORG = "org_replace_shot";
const BRAND = "brand_replace_shot";
const NOW = "2026-10-22T10:00:00.000Z";
const PORTS: RemakePorts = { monthBudget: { monthBudget: async () => ({ status: "known", usd: 1000 }) } };

function fail(): never {
  throw new Error("the chain world holds no ids for this request");
}

describe("a remake that replaces a shot's visual type and source, on a delivered video", () => {
  let db: TestDatabase;
  let world: Awaited<ReturnType<typeof chainWorld>>;
  let requestId = "";
  let shot = "";
  let originalPlanId = "";
  let otherShots: string[] = [];

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
    world = await chainWorld(db.sql, ORG);
    const started = await startChainRequest(world, { slot: 6, brandId: BRAND, formatId: "fmt_replace_shot", priority: "normal", variantCount: 0 });
    await drain(db.sql, world.runtime, ORG);
    requestId = started.requestId;
    const ids = world.requests.get(requestId)?.ids;
    assert.ok(ids, "the chain world holds the request's ids");
    shot = ids.id(fx.FIXTURE_IDS.shot1);
    assert.equal((await engineRequestStatus(db.sql, ORG, requestId))?.status, "delivered");
    const read = await readEngineRequest(db.sql, ORG, requestId);
    originalPlanId = read?.state.artifacts.plan ?? "";
    const plan = scenePlanSchema.parse((await readArtifact(db.sql, { organizationId: ORG, artifactId: originalPlanId })).envelope.body);
    otherShots = plan.shots.filter((candidate) => candidate.shotId !== shot).map((candidate) => candidate.shotId);
  });

  after(async () => {
    await db.close();
  });

  test("the replaced shot is made again with its new visual type; the plan is a new record that keeps every other shot", async () => {
    const replacement: ShotReplacement = {
      visualType: "cinematic",
      source: { kind: "generate", modelClass: "video.cinematic", prompt: "A quiet kitchen at dawn, the product on the counter", refs: [], takes: 1 },
    };
    const outcome = await remakeEngineShot(db.sql, { organizationId: ORG, requestId, shotId: shot, directive: null, now: NOW, replacement }, PORTS);
    assert.equal(outcome.status, "queued", outcome.status === "refused" ? outcome.reasons.join("; ") : "");

    const read = await readEngineRequest(db.sql, ORG, requestId);
    const planId = read?.state.artifacts.plan ?? "";
    assert.notEqual(planId, originalPlanId, "the request now names the plan that holds the replacement");
    const plan = scenePlanSchema.parse((await readArtifact(db.sql, { organizationId: ORG, artifactId: planId })).envelope.body);
    const replaced = plan.shots.find((candidate) => candidate.shotId === shot);
    assert.equal(replaced?.visualType, "cinematic");
    assert.equal(replaced?.source.kind, "generate");
    assert.deepEqual(plan.shots.filter((candidate) => candidate.shotId !== shot).map((candidate) => candidate.shotId), otherShots);
    assert.equal(read?.state.shots[shot]?.visualType, "cinematic", "the state takes the new visual type");

    const queued = await engineRequestFeed(db.sql, ORG, requestId);
    assert.equal(queued?.shots.find((row) => row.shotId === shot)?.visualType, "cinematic");
    await answerRemadeChain(db.sql, { organizationId: ORG, requestId, shot, ids: world.requests.get(requestId)?.ids ?? fail(), now: NOW });
    await drain(db.sql, world.runtime, ORG);
    assert.equal((await engineRequestStatus(db.sql, ORG, requestId))?.status, "delivered", "the video is delivered again with the replacement");
  });

  test("a replacement the produce path cannot make is refused before a plan is written", async () => {
    const before = await readEngineRequest(db.sql, ORG, requestId);
    const outcome = await remakeEngineShot(
      db.sql,
      {
        organizationId: ORG,
        requestId,
        shotId: shot,
        directive: null,
        now: NOW,
        replacement: { visualType: "coded_graphics", source: { kind: "component", component: "Lower third", props: {} } },
      },
      PORTS,
    );
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons.join(" "), /must be a shot that a take makes/);
    const after = await readEngineRequest(db.sql, ORG, requestId);
    assert.equal(after?.state.artifacts.plan, before?.state.artifacts.plan, "no plan was written for the refused replacement");
    assert.equal(after?.state.revision, before?.state.revision);
  });
});
