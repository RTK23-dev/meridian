// A reviewer's own clip for one shot (Video Engine Bible 5.5, D12), on a delivered video on PGlite. The clip is probed by a fake probe and
// stored in a fake object store, so no media host is called. A clip that does not cover the shot, or is not a readable take-size H.264
// MP4, is refused before anything is written. A clip that fits is the shot's take: the shot is accepted with it and the video is delivered
// again. Nothing here calls a live provider.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as fx from "../contracts/fixtures/index.ts";
import { engineRequestFeed, engineRequestStatus, replaceShotWithClip, type RemakePorts } from "../api/index.ts";
import { newId } from "../contracts/index.ts";
import { answerStage, chainWorld, drain, startChainRequest } from "./test/chain.ts";
import { cleanRender } from "../review/test/render.ts";
import { writeArtifact } from "../jobs/artifact-store.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { readArtifact } from "../jobs/artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { gateResult } from "./test/chain.ts";

const ORG = "org_clip_shot";
const BRAND = "brand_clip_shot";
const NOW = "2026-10-22T10:00:00.000Z";

/** A fake media port: the probe reads what the test says the clip is. */
function probing(shape: { durationMs: number; width: number; height: number; videoCodec: string } | "unreadable"): RemakePorts["media"] {
  return {
    probe: async () => {
      if (shape === "unreadable") throw new Error("the file is not a video");
      return { videoCodec: shape.videoCodec, durationMs: shape.durationMs, width: shape.width, height: shape.height } as never;
    },
  } as unknown as RemakePorts["media"];
}

/** A fake object store: every put is kept by key, so the test can see the clip was stored. */
function memoryObjects(): NonNullable<RemakePorts["objects"]> & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async put(input) {
      keys.push(input.key);
      return { key: input.key, checksum: "fixture", size: input.bytes.byteLength };
    },
    async get() {
      return null;
    },
  };
}

function portsWith(media: RemakePorts["media"], objects: RemakePorts["objects"]): RemakePorts {
  return { monthBudget: { monthBudget: async () => ({ status: "known", usd: 1000 }) }, media, objects };
}

const CLIP = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const TAKE_SIZE = { videoCodec: "h264", width: 1080, height: 1920 };

describe("a reviewer's own clip for one shot, on a delivered video", () => {
  let db: TestDatabase;
  let world: Awaited<ReturnType<typeof chainWorld>>;
  let requestId = "";
  let shot = "";

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
    world = await chainWorld(db.sql, ORG);
    const started = await startChainRequest(world, { slot: 7, brandId: BRAND, formatId: "fmt_clip_shot", priority: "normal", variantCount: 0 });
    await drain(db.sql, world.runtime, ORG);
    requestId = started.requestId;
    shot = world.requests.get(requestId)?.ids.id(fx.FIXTURE_IDS.shot1) ?? "";
    assert.equal((await engineRequestStatus(db.sql, ORG, requestId))?.status, "delivered");
  });

  after(async () => {
    await db.close();
  });

  test("a clip too short for the shot, or not a readable take-size H.264 MP4, is refused and stores nothing", async () => {
    const before = await readEngineRequest(db.sql, ORG, requestId);
    const objects = memoryObjects();
    const short = await replaceShotWithClip(db.sql, { organizationId: ORG, requestId, shotId: shot, bytes: CLIP, now: NOW }, portsWith(probing({ ...TAKE_SIZE, durationMs: 100 }), objects));
    assert.equal(short.status, "refused");
    if (short.status === "refused") assert.match(short.reasons.join(" "), /shorter than the shot/);

    const wrongSize = await replaceShotWithClip(db.sql, { organizationId: ORG, requestId, shotId: shot, bytes: CLIP, now: NOW }, portsWith(probing({ videoCodec: "h264", durationMs: 60000, width: 1280, height: 720 }), objects));
    assert.equal(wrongSize.status, "refused");
    if (wrongSize.status === "refused") assert.match(wrongSize.reasons.join(" "), /H\.264 MP4 at the take size/);

    const unreadable = await replaceShotWithClip(db.sql, { organizationId: ORG, requestId, shotId: shot, bytes: CLIP, now: NOW }, portsWith(probing("unreadable"), objects));
    assert.equal(unreadable.status, "refused");
    if (unreadable.status === "refused") assert.match(unreadable.reasons.join(" "), /could not be read/);

    assert.deepEqual(objects.keys, [], "nothing is stored for a refused clip");
    const after = await readEngineRequest(db.sql, ORG, requestId);
    assert.equal(after?.state.artifacts.plan, before?.state.artifacts.plan, "no plan is written for a refused clip");
    assert.equal(after?.state.revision, before?.state.revision);
  });

  test("a clip that covers the shot is the shot's take: the shot is accepted with it, and the video is delivered again", async () => {
    const objects = memoryObjects();
    const outcome = await replaceShotWithClip(db.sql, { organizationId: ORG, requestId, shotId: shot, bytes: CLIP, now: NOW }, portsWith(probing({ ...TAKE_SIZE, durationMs: 60000 }), objects));
    assert.equal(outcome.status, "queued", outcome.status === "refused" ? outcome.reasons.join("; ") : "");
    assert.equal(objects.keys.length, 1, "the clip is stored once, as the take's media");

    const read = await readEngineRequest(db.sql, ORG, requestId);
    const takeIds = Object.keys(read?.state.takes ?? {}).filter((takeId) => read?.state.takes[takeId]?.shotId === shot);
    const clipTake = takeIds.find((takeId) => read?.state.shots[shot]?.acceptedTakeId === takeId);
    assert.ok(clipTake, "the shot is accepted with the reviewer's take, with no check of its own");
    assert.equal(read?.state.shots[shot]?.status, "accepted");
    const feed = await engineRequestFeed(db.sql, ORG, requestId);
    assert.equal(feed?.shots.find((row) => row.shotId === shot)?.status, "accepted", "the board shows the shot accepted");

    // The chain's edit is answered as in the other remake tests, but the cut uses the reviewer's take: every reference to the shot\'s
    // fixture take is replaced by the clip\'s store uri, so the pre-render gate sees the clip in the composition.
    const ids = world.requests.get(requestId)?.ids;
    assert.ok(ids, "the chain world holds the request's ids");
    const clipUri = (await readArtifact(db.sql, { organizationId: ORG, artifactId: read?.state.artifacts[`take:${clipTake}`] ?? "" })).envelope.body as { uri: string };
    const fixtureUri = (ids.value(fx.take1Fixture) as { uri: string }).uri;
    const cut = JSON.parse(JSON.stringify({ ...(ids.value(cleanRender().edl) as object) }).split(fixtureUri).join(clipUri.uri)) as Record<string, unknown>;
    const edlId = newId("edl_");
    const edlArtifact = (await writeArtifact(db.sql, { organizationId: ORG, requestId, stage: "edit", type: "edl", body: { ...cut, edlId }, createdAt: NOW })).artifactId;
    await answerStage(db.sql, {
      organizationId: ORG,
      requestId,
      stage: "edit",
      subjectId: requestId,
      output: { stage: "edit", subjectId: requestId, gate: gateResult("edit", requestId, true), edlId, artifacts: { [`edl:${edlId}`]: edlArtifact } },
    });
    await drain(db.sql, world.runtime, ORG);
    assert.equal((await engineRequestStatus(db.sql, ORG, requestId))?.status, "delivered", "the video is delivered again with the reviewer's clip");
  });
});
