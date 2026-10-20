// A remade shot of a delivered video, on the real engine (Video Engine Bible 5.5): the reservation, the orchestrator, the jobs, the chain
// and the delivery, on PGlite. The stages before the take and after the edit are the chain world's recorded answers, as in every chain
// test. The remade take, its verdict and its edit are recorded here. Compose, the pre-render gate, the render and the review are the
// chain's own. No test calls a live provider.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fx from "../contracts/fixtures/index.ts";
import { newId } from "../contracts/index.ts";
import { engineDeliveredMaster, engineRequestFeed, engineRequestStatus, remakeEngineShot, type RemakePorts } from "../api/index.ts";
import { writeArtifact } from "../jobs/artifact-store.ts";
import { cleanRender } from "../review/test/render.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { answerStage, chainWorld, drain, gateResult, startChainRequest } from "./test/chain.ts";

const ORG = "org_remake";
const BRAND = "brand_remake";
const NOW = "2026-10-18T10:00:00.000Z";
const DIRECTION = "Put the product in her hand, close to the lens";
const PORTS: RemakePorts = { monthBudget: { monthBudget: async () => ({ status: "known", usd: 1000 }) } };

describe("a remade shot of a delivered video, on the engine", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
  });

  after(async () => {
    await db.close();
  });

  test("the remade take is checked, the edit is cut on it, and a second master is delivered; the feed shows the remake on its shot", async () => {
    const { sql } = db;
    const world = await chainWorld(sql, ORG);
    const started = await startChainRequest(world, { slot: 4, brandId: BRAND, formatId: "fmt_remake", priority: "normal", variantCount: 0 });
    await drain(sql, world.runtime, ORG);
    const requestId = started.requestId;
    assert.equal((await engineRequestStatus(sql, ORG, requestId))?.status, "delivered");
    const first = await engineDeliveredMaster(sql, ORG, requestId);

    // The world keeps the request's id mapping: a fresh mapping would name the shots differently.
    const ids = world.requests.get(requestId)?.ids;
    assert.ok(ids, "the chain world holds the request's ids");
    const shot = ids.id(fx.FIXTURE_IDS.shot1);
    const outcome = await remakeEngineShot(sql, { organizationId: ORG, requestId, shotId: shot, directive: DIRECTION, now: NOW }, PORTS);
    assert.equal(outcome.status, "queued", outcome.status === "refused" ? outcome.reasons.join("; ") : "");
    if (outcome.status !== "queued") return;
    assert.equal(outcome.revision, 1);

    const queued = await engineRequestFeed(sql, ORG, requestId);
    assert.ok(queued);
    assert.equal(queued?.revision, 1);
    const queuedShot = queued?.shots.find((row) => row.shotId === shot);
    assert.equal(queuedShot?.status, "pending", "the shot is being made again");
    assert.deepEqual(queuedShot?.directives, [DIRECTION]);
    assert.equal(queuedShot?.remakes, 1);
    assert.match(queuedShot?.remakeRefusal ?? "", /still being made/, "another remake waits until this revision is delivered");

    const takeId = newId("take_");
    const takeArtifact = (
      await writeArtifact(sql, {
        organizationId: ORG,
        requestId,
        stage: "produce_shot",
        type: "take",
        body: { ...ids.value(fx.take1Fixture), takeId, shotId: shot, attempt: 2 },
        createdAt: NOW,
      })
    ).artifactId;
    await answerStage(sql, {
      organizationId: ORG,
      requestId,
      stage: "produce_shot",
      subjectId: shot,
      output: { stage: "produce_shot", subjectId: shot, shotId: shot, epoch: 1, takeId, artifacts: { [`take:${takeId}`]: takeArtifact } },
    });

    const verdict = { takeId, pass: true, confidence: 0.9, checks: [{ rule: "slop.clean", pass: true }], action: "accept" as const };
    const verdictArtifact = (await writeArtifact(sql, { organizationId: ORG, requestId, stage: "check_take", type: "take_verdict", body: verdict, createdAt: NOW })).artifactId;
    await answerStage(sql, {
      organizationId: ORG,
      requestId,
      stage: "check_take",
      subjectId: takeId,
      output: { stage: "check_take", subjectId: takeId, shotId: shot, takeId, gate: gateResult("take", requestId, true), verdict, artifacts: { [`verdict:${takeId}`]: verdictArtifact } },
    });

    const edlId = newId("edl_");
    const edlArtifact = (
      await writeArtifact(sql, { organizationId: ORG, requestId, stage: "edit", type: "edl", body: { ...ids.value(cleanRender().edl), edlId }, createdAt: NOW })
    ).artifactId;
    await answerStage(sql, {
      organizationId: ORG,
      requestId,
      stage: "edit",
      subjectId: requestId,
      output: { stage: "edit", subjectId: requestId, gate: gateResult("edit", requestId, true), edlId, artifacts: { [`edl:${edlId}`]: edlArtifact } },
    });

    await drain(sql, world.runtime, ORG);
    assert.equal((await engineRequestStatus(sql, ORG, requestId))?.status, "delivered", "the revision is delivered again");
    const second = await engineDeliveredMaster(sql, ORG, requestId);
    assert.equal(second.renderedVideo.edlId, edlId, "the delivered master is the revision's edit, not the first one");
    assert.notEqual(second.renderedVideo.videoId, first.renderedVideo.videoId);
    assert.notEqual(second.manifestId, first.manifestId, "the revision has its own manifest");

    const delivered = await engineRequestFeed(sql, ORG, requestId);
    assert.equal(delivered?.revision, 1);
    const deliveredShot = delivered?.shots.find((row) => row.shotId === shot);
    assert.equal(deliveredShot?.status, "accepted");
    assert.equal(deliveredShot?.acceptedTakeId, takeId);
    assert.equal(deliveredShot?.takes, 1, "the superseded take of the first round is not counted for the remade shot");
    assert.equal(deliveredShot?.lastVerdict?.pass, true);
    assert.equal(delivered?.branches.find((branch) => branch.edlId === first.renderedVideo.edlId)?.status, "superseded");
  });
});
