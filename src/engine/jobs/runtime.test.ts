import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { gatewayWith, recordedTransport } from "./test/harness.ts";
import { notConnectedWorkspaceBudget } from "./handlers/estimate-reserve.ts";
import { createEngineRuntime, type EngineComposition } from "./runtime.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";
import type { RenderPorts } from "./handlers/render.ts";

/** Ports that are only registered, never called: the runtime builds handlers and does not run them. */
function fakeRenderPorts(): RenderPorts {
  return {
    loadStyleKit: async () => undefined,
    renderEstimateUsd: async () => undefined,
    hyperframes: () => {
      throw new Error("not called in this test");
    },
    now: () => "2026-10-15T14:00:00.000Z",
  };
}

function fakePostRenderPorts(): PostRenderPorts {
  return {
    gateway: gatewayWith(recordedTransport({}).transport),
    media: {} as PostRenderPorts["media"],
    objects: {} as PostRenderPorts["objects"],
    now: () => "2026-10-15T14:00:00.000Z",
  };
}

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, "ws_runtime", "brand_runtime");
});

after(async () => {
  await db.close();
});

function composition(overrides: Partial<EngineComposition> = {}): EngineComposition {
  return {
    sql: db.sql,
    gateway: gatewayWith(recordedTransport({}).transport),
    workspaceBudget: notConnectedWorkspaceBudget,
    now: () => "2026-10-15T14:00:00.000Z",
    ...overrides,
  };
}

test("the stages that need no provider are registered on the kit store and the engine tables", () => {
  const runtime = createEngineRuntime(composition());
  for (const stage of ["pre_render_gate", "compose", "variants", "deliver", "intake", "plan", "estimate_reserve", "edit"] as const) {
    assert.ok(runtime.handlers[stage], `${stage} has a handler`);
  }
});

test("render and post-render review stay not_implemented without their ports (fail closed, never a success)", () => {
  const runtime = createEngineRuntime(composition());
  assert.equal(runtime.handlers.render, undefined);
  assert.equal(runtime.handlers.post_render_review, undefined);
  assert.equal(runtime.handlers.produce_shot, undefined, "produce_shot needs the shot ports");
});

test("the render stage and the post-render review are registered when their ports are given", () => {
  const runtime = createEngineRuntime(composition({ render: fakeRenderPorts(), postRender: fakePostRenderPorts() }));
  assert.ok(runtime.handlers.render, "render has a handler");
  assert.ok(runtime.handlers.post_render_review, "post_render_review has a handler");
});

test("the composition's style kit reader is the one compose and pre-render use", async () => {
  let reads = 0;
  const runtime = createEngineRuntime(
    composition({
      styleKit: async () => {
        reads += 1;
        return undefined;
      },
    }),
  );
  assert.ok(runtime.handlers.compose && runtime.handlers.pre_render_gate);
  assert.equal(reads, 0, "no kit is read when the runtime is built");
});
