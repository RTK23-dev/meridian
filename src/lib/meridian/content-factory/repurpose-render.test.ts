// The production render port of a repurposed cut, on PGlite. It runs the engine's own compose and render stage handlers, under the cut's
// own hold, with a recorded HyperFrames adapter. No provider is reached: these tests prove the wiring, the budget refusal, the price gate
// and the unresolved-error behaviour. They are not evidence of a live render.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { EngineError } from "../../../engine/contracts/errors.ts";
import { edlFixture, FIXTURE_IDS } from "../../../engine/contracts/fixtures/index.ts";
import { styleKitFixture } from "../../../engine/contracts/fixtures/kits.ts";
import { validatedRequestFixture } from "../../../engine/contracts/fixtures/chain.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { scopedLedgerStore } from "../../../engine/jobs/asset-stores-sql.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { stableId } from "../../../engine/jobs/stable-id.ts";
import { sqlLedgerStore } from "../../../engine/jobs/sql-ledger-store.ts";
import type { RenderPorts } from "../../../engine/jobs/handlers/render.ts";
import type { ComposePorts } from "../../../engine/jobs/handlers/compose.ts";
import { repurposedEdl } from "../../../engine/repurpose/child.ts";
import { integrityPassed, VIDEO_ID } from "../../../engine/review/test/render.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { engineRepurposeRenderPort, type RepurposeBudget } from "./repurpose-render.ts";

const WS = "ws_repurpose_render";
const BRAND = "brand_repurpose_render";
const REQ = FIXTURE_IDS.request;
const NOW = "2026-10-24T10:00:00.000Z";
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const VARIANT = "variant-1";

let db: TestDatabase;
let childArtifactId = "";
const child = repurposedEdl(edlFixture, { version: 1, look: { preset: "warm", strength: 0.5 } }, VARIANT);
// A second, different cut. The renderer's idempotency key is the composition hash, so one cut is never sent under two holds.
const otherChild = repurposedEdl(edlFixture, { version: 1, look: { preset: "cool", strength: 0.4 } }, "variant-2");
let otherChildArtifactId = "";

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQ,
    formatId: "ref_repurpose_render",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_repurpose_render_request",
  });
  // The delivered request's plan and master cut, as the engine stores them: the validated plan is what the render stages read.
  const validated = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "intake", type: "validated_request", body: validatedRequestFixture, createdAt: NOW });
  const master = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: edlFixture, createdAt: NOW });
  const state = JSON.parse((await db.sql<{ state: string }>`select state from engine_requests where id = ${REQ} and organization_id = ${WS}`)[0]!.state) as Record<string, unknown>;
  await db.sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify({
      ...state,
      status: "delivered",
      masterEdlId: edlFixture.edlId,
      artifacts: { ...(state.artifacts as Record<string, string>), validated: validated.artifactId, [`edl:${edlFixture.edlId}`]: master.artifactId },
    })}
    where id = ${REQ} and organization_id = ${WS}
  `;
  childArtifactId = (
    await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "repurpose", type: "edl", body: child, parentIds: [master.artifactId], createdAt: NOW })
  ).artifactId;
  otherChildArtifactId = (
    await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "repurpose", type: "edl", body: otherChild, parentIds: [master.artifactId], createdAt: NOW })
  ).artifactId;
});

after(async () => {
  await db.close();
});

/** A recorded HyperFrames adapter that counts submissions. The submit can be made to fail as a provider error. */
function recordedRenderer(options: { failSubmit?: boolean } = {}) {
  const submits = { count: 0 };
  const stored = new Map<string, Uint8Array>();
  const ports = {
    loadStyleKit: async () => styleKitFixture,
    renderEstimateUsd: async () => 0.05 as number | undefined,
    hyperframes: (scope: { organizationId: string; reservationId: string }) => ({
      adapter: {
        renderer: "hyperframes-cloud",
        async ready() {
          return undefined;
        },
        async submit() {
          submits.count += 1;
          if (options.failSubmit) throw new EngineError("provider", "HyperFrames refused the render", { retryable: true, stage: "render" });
          return { renderId: "hfr_repurpose_0001", status: "queued" as const };
        },
        async poll(renderId: string) {
          return { renderId, status: "completed" as const, videoUrl: "https://video.example.test/hfr_repurpose_0001.mp4" };
        },
        async fetchResult() {
          return { bytes: MP4 };
        },
      },
      ledger: scopedLedgerStore(db.sql, scope.organizationId, scope.reservationId),
      verifyIntegrity: async () => integrityPassed(VIDEO_ID),
      storeVideo: async ({ videoId, bytes }: { videoId: string; bytes: Uint8Array }) => {
        const key = `renders/${videoId}.mp4`;
        stored.set(key, bytes);
        return key;
      },
      resolveAsset: async () => MP4,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      newVideoId: () => VIDEO_ID,
    }),
    now: () => NOW,
  } as unknown as RenderPorts & { renderEstimateUsd: () => Promise<number | undefined> };
  const compose: ComposePorts = { loadStyleKit: async () => styleKitFixture, now: () => NOW };
  return { ports, compose, submits, stored };
}

function portFor(options: { renderer: ReturnType<typeof recordedRenderer>; budget?: RepurposeBudget | null; price?: number | undefined }) {
  const renderer = options.renderer;
  if (options.price !== undefined || "price" in options) renderer.ports.renderEstimateUsd = async () => options.price;
  return engineRepurposeRenderPort({
    sql: db.sql,
    composePorts: renderer.compose,
    renderPorts: renderer.ports as RenderPorts,
    budgetOf: async () => (options.budget === undefined ? { requestBudgetUsd: 10, workspaceMonthBudgetUsd: 100 } : options.budget),
    now: () => NOW,
  });
}

function cutOf(variationKey: string, cut: { artifactId: string; edl: typeof child } = { artifactId: childArtifactId, edl: child }) {
  return { organizationId: WS, engineRequestId: REQ, variationKey, childArtifactId: cut.artifactId, edl: cut.edl, estimateUsd: 0.05 };
}

describe("the production render port of a repurposed cut", () => {
  test("renders the child cut through the engine's compose and render stages, and records the video with its lineage", async () => {
    const renderer = recordedRenderer();
    const outcome = await portFor({ renderer })(cutOf(VARIANT));
    assert.equal(outcome.status, "rendered");
    assert.equal(renderer.submits.count, 1, "the renderer is called once");
    assert.equal(renderer.stored.size, 1, "the video is stored through the storage interface");
    if (outcome.status !== "rendered") return;

    const rendered = await db.sql<{ type: string; parent_ids: string }>`select type, parent_ids from engine_artifacts where id = ${outcome.artifactId}`;
    assert.equal(rendered[0]?.type, "rendered_video");
    const parents = JSON.parse(rendered[0]!.parent_ids) as string[];
    assert.ok(parents.includes(childArtifactId), "the video names the child cut as its parent");

    const composition = await db.sql<{ n: number }>`
      select count(*)::int as n from engine_artifacts where request_id = ${REQ} and type = 'composition' and stage = 'compose'
    `;
    assert.ok((composition[0]?.n ?? 0) >= 1, "the compose stage wrote the composition the render checked");

    const reservation = await sqlLedgerStore(db.sql, WS).getReservation(stableId("res_", `repurpose|${REQ}|${VARIANT}`));
    assert.equal(reservation?.reservedUsd, 0.05, "the cut's own hold is the render estimate");
  });

  test("refuses a cut whose hold would exceed the request budget, and sends nothing", async () => {
    const renderer = recordedRenderer();
    const outcome = await portFor({ renderer, budget: { requestBudgetUsd: 0.01, workspaceMonthBudgetUsd: 100 } })(cutOf("variant-budget"));
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.match(outcome.reason, /budget/i);
    assert.equal(renderer.submits.count, 0, "no call is sent when the hold is refused");
  });

  test("refuses a request with no budget set, and sends nothing", async () => {
    const renderer = recordedRenderer();
    const outcome = await portFor({ renderer, budget: null })(cutOf("variant-no-budget"));
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.match(outcome.reason, /no budget/i);
    assert.equal(renderer.submits.count, 0);
  });

  test("fails closed when the render price is not in the table: the integrity gate names it and nothing is sent", async () => {
    const renderer = recordedRenderer();
    const outcome = await portFor({ renderer, price: undefined })(cutOf("variant-unpriced"));
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.match(outcome.reason, /render price/i);
    assert.equal(renderer.submits.count, 0);
  });

  test("a provider error is not recorded as a rendered video: the port throws and the cut is left unresolved", async () => {
    const renderer = recordedRenderer({ failSubmit: true });
    // The first submit fails and is recorded as unsettled. The retry is refused rather than sent again, so the port throws.
    await assert.rejects(portFor({ renderer })(cutOf("variant-2", { artifactId: otherChildArtifactId, edl: otherChild })), /cost is unsettled, so it is not submitted again/);
    assert.equal(renderer.submits.count, 1, "the renderer is called once; the unsettled call is not sent again");
    const videos = await db.sql<{ n: number }>`
      select count(*)::int as n from engine_artifacts where request_id = ${REQ} and type = 'rendered_video' and parent_ids like ${`%${otherChildArtifactId}%`}
    `;
    assert.equal(videos[0]?.n ?? 0, 0, "the cut whose provider call failed has no rendered video");
  });
});
