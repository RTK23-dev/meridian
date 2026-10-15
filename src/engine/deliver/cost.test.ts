import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compositionFixture, FIXTURE_IDS, ledgerClaudeFixture, ledgerRenderFixture, ledgerShot3Fixture, ledgerSttFixture, fixtureId } from "../contracts/fixtures/index.ts";
import { sumUsd, type LedgerEntry } from "../contracts/index.ts";
import { attributeRows, categoryOf, costOf, totalOf, unansweredCount } from "./cost.ts";
import type { SettledRow } from "./ledger.ts";

function settled(entry: LedgerEntry): SettledRow {
  return { ...entry, workspaceId: "ws_fixture", reservationId: FIXTURE_IDS.reservation, actualUsd: entry.actualUsd ?? entry.reservedUsd };
}

/** The four settled calls of the chain fixture: the planner, the speech, shot 3 and the master's render. */
const MASTER_ROWS: SettledRow[] = [ledgerClaudeFixture, ledgerSttFixture, ledgerShot3Fixture, ledgerRenderFixture].map(settled);

const VARIANT_VIDEO = fixtureId("vid_", 50);
const VARIANT_KEY = "sha256:" + "a".repeat(64);
const VARIANT_RENDER: SettledRow = {
  ...settled({
    entryId: fixtureId("led_", 51),
    requestId: FIXTURE_IDS.request,
    stage: "render",
    provider: "hyperframes-cloud",
    model: "hyperframes",
    estimateUsd: 0.05,
    reservedUsd: 0.05,
    actualUsd: 0.046,
    idempotencyKey: VARIANT_KEY,
    at: "2026-10-13T09:20:00.000Z",
  }),
};

describe("the cost buckets (Bible 4.4 Manifest.cost, budgets.ts fixedStages)", () => {
  it("puts a Claude role in brain, a shot in generation, a render in render, and speech and media in other", () => {
    assert.equal(categoryOf({ stage: "plan", role: "planner" }), "brain");
    assert.equal(categoryOf({ stage: "claude_roles" }), "brain");
    assert.equal(categoryOf({ stage: "critic" }), "brain");
    assert.equal(categoryOf({ stage: "produce_shot" }), "generation");
    assert.equal(categoryOf({ stage: "render" }), "render");
    assert.equal(categoryOf({ stage: "voice" }), "other");
    assert.equal(categoryOf({ stage: "media" }), "other");
    assert.equal(categoryOf({ stage: "something_new" }), "other", "an unknown stage is kept in other, so the total still holds");
  });

  it("sums the actual cost of each bucket, and the total is the exact sum of the four", () => {
    const cost = costOf(MASTER_ROWS);
    assert.deepEqual(cost, { brain: 0.142, generation: 0.2016, render: 0.047, other: 0.02, total: 0.4106 });
    assert.equal(cost.total, sumUsd([cost.brain, cost.generation, cost.render, cost.other]));
  });

  it("counts the calls that never returned an answer", () => {
    assert.equal(unansweredCount([{ status: "pending" }, { status: "answered" }, { status: "invalid_answer" }, { status: "refused" }]), 1);
  });

  it("a row with no actual cost is refused when a total is read", () => {
    assert.throws(() => totalOf([{ ...MASTER_ROWS[0]!, actualUsd: Number.NaN }]));
  });
});

describe("attributing each paid call to one delivered video", () => {
  const renders = [{ videoId: FIXTURE_IDS.video, idempotencyKey: compositionFixture.contentHash }, { videoId: VARIANT_VIDEO, idempotencyKey: VARIANT_KEY }];

  it("gives a variant the render it paid for, and everything else to the master", () => {
    const rows = [...MASTER_ROWS, VARIANT_RENDER];
    const byVideo = attributeRows(rows, {
      masterVideoId: FIXTURE_IDS.video,
      renders,
      deliveredVariantVideoIds: new Set([VARIANT_VIDEO]),
    });
    assert.deepEqual(
      [...byVideo.keys()].sort(),
      [FIXTURE_IDS.video, VARIANT_VIDEO].sort(),
    );
    assert.equal(byVideo.get(VARIANT_VIDEO)?.length, 1);
    assert.equal(byVideo.get(FIXTURE_IDS.video)?.length, 4);
  });

  it("gives a variant's render to the master when the variant did not deliver, so every call is still paid for once", () => {
    const rows = [...MASTER_ROWS, VARIANT_RENDER];
    const byVideo = attributeRows(rows, { masterVideoId: FIXTURE_IDS.video, renders, deliveredVariantVideoIds: new Set() });
    assert.equal(byVideo.get(VARIANT_VIDEO)?.length, undefined);
    assert.equal(byVideo.get(FIXTURE_IDS.video)?.length, 5);
  });

  it("the sum over the delivered videos is the sum over all rows", () => {
    const rows = [...MASTER_ROWS, VARIANT_RENDER];
    const byVideo = attributeRows(rows, { masterVideoId: FIXTURE_IDS.video, renders, deliveredVariantVideoIds: new Set([VARIANT_VIDEO]) });
    const attributed = [...byVideo.values()].flat();
    assert.equal(attributed.length, rows.length);
    assert.equal(sumUsd(attributed.map((row) => row.actualUsd)), sumUsd(rows.map((row) => row.actualUsd)));
  });
});
