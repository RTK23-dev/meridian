import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import type { ResolvedRoute } from "../gateway/gateway.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { NodeKind, PlanNode } from "./contracts.ts";
import { CallRefusedError, NotConnectedError, StepQueuedError, type NodeHandler } from "./execute.ts";
import { analysisAnswerSchema, productionHandlers, scriptAnswerSchema, type ProductionDeps, type QueuedAsset } from "./production.ts";
import { queueAssetJob } from "./asset-poll.ts";
import { createPlanDraft } from "./store.ts";

const ORG = "org_production_a";
const CREATED = "2026-10-22T10:00:00.000Z";
const RES = newId("res_");
const REQ = newId("req_");

/** A reservation of the given amount on the memory ledger, shaped as the run's reservation is (run-budget.ts). */
async function ledgerWith(reservedUsd: number): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(
    budgetReservationSchema.parse({
      schema: BUDGET_RESERVATION_SCHEMA,
      reservationId: RES,
      requestId: REQ,
      workspaceId: ORG,
      mode: "cap",
      lines: [{ stage: "orchestrator_run", estimateUsd: reservedUsd }],
      estimateUsd: reservedUsd,
      redoAllowanceUsd: 0,
      reservedUsd,
      requestBudgetUsd: 5,
      workspaceMonthBudgetUsd: 100,
      state: "reserved",
      createdAt: CREATED,
    }),
  );
  return ledger;
}

function depsWith(ledger: LedgerStore, extra: Partial<ProductionDeps> = {}): ProductionDeps {
  return {
    organizationId: ORG,
    planId: "plan_1",
    requestId: REQ,
    reservationId: RES,
    ledger,
    now: () => CREATED,
    connection: async () => ({ connected: true, reason: null }),
    textRoute: (modelId) => ({ capability: "llm.analysis", provider: { id: "openrouter" } as ResolvedRoute["provider"], model: modelId, priceKey: null, verified: false }),
    structured: async () => {
      throw new Error("no answer recorded for this test");
    },
    brand: async () => null,
    catalogReadAt: "2026-10-13T09:00:04.000Z",
    ...extra,
  };
}

function node(over: Partial<PlanNode> & Pick<PlanNode, "id" | "kind">): PlanNode {
  return {
    title: "a step",
    why: "because the plan needs it",
    dependsOn: [],
    model: { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" },
    params: {},
    estimateUsd: 0.01,
    ...over,
  };
}

const NO_UPSTREAM = new Map<string, string | null>();
const NO_KINDS = new Map();

describe("production handlers: reference (no model call)", () => {
  test("a reference with text stores the text as its body and spends nothing", async () => {
    const ledger = await ledgerWith(1);
    const handler = productionHandlers(depsWith(ledger)).reference as NodeHandler;
    const out = await handler({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null, params: { text: "Launch day copy" } }), key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS });
    assert.equal(out.body, "Launch day copy");
    assert.equal(out.costUsd, null);
    assert.equal((await ledger.listEntries(RES)).length, 0, "no call, so no ledger entry");
  });

  test("a reference to a brand stores the brand's facts, and a brand outside the organization is refused", async () => {
    const facts = { name: "Acme", description: "tools", category: "", industry: "", website: "", countryMarket: "", sells: "" };
    const found = productionHandlers(depsWith(await ledgerWith(1), { brand: async () => facts }))
      .reference as NodeHandler;
    const out = await found({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null, params: { brandId: "brand_a" } }), key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS });
    assert.deepEqual(JSON.parse(out.body ?? "null"), facts);

    const missing = productionHandlers(depsWith(await ledgerWith(1))).reference as NodeHandler;
    await assert.rejects(
      missing({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null, params: { brandId: "brand_b" } }), key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }),
      /not in this organization/,
    );
  });

  test("a reference with neither a brand nor text fails and reads nothing", async () => {
    const handler = productionHandlers(depsWith(await ledgerWith(1))).reference as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null }), key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), /nothing to read/);
  });
});

describe("production handlers: analysis and script (paid text calls)", () => {
  test("a step whose provider is not connected stops before any call, and holds nothing", async () => {
    const ledger = await ledgerWith(1);
    let called = false;
    const deps = depsWith(ledger, {
      connection: async () => ({ connected: false, reason: "no key" }),
      structured: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    const handler = productionHandlers(deps).script as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "s", kind: "script" }), key: "k", upstream: new Map([["ref", "brief text"]]), upstreamKinds: NO_KINDS }), NotConnectedError);
    assert.equal(called, false);
    assert.equal((await ledger.listEntries(RES)).length, 0);
  });

  test("a script call is authorized, billed at the reported cost, and its lines are stored as the body", async () => {
    const ledger = await ledgerWith(1);
    const seen: string[] = [];
    const deps = depsWith(ledger, {
      structured: async (_route, call) => {
        seen.push(...call.messages.map((message) => String(message.content)));
        return { value: call.schema.parse({ lines: ["Hook line", "Second line"] }), actualUsd: 0.0012 };
      },
    });
    const handler = productionHandlers(deps).script as NodeHandler;
    const out = await handler({ node: node({ id: "s", kind: "script", dependsOn: ["ref"] }), key: "k1", upstream: new Map([["ref", "brief text"]]), upstreamKinds: NO_KINDS });
    assert.equal(out.body, "Hook line\nSecond line");
    assert.equal(out.costUsd, 0.0012);
    const entries = await ledger.listEntries(RES);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.actualUsd, 0.0012, "the bill is recorded on the ledger");
    assert.ok(seen.some((text) => text.includes("brief text")), "the upstream body reaches the model as data");
  });

  test("the same step is never paid twice: a second attempt with the same key is refused, and nothing is called", async () => {
    const ledger = await ledgerWith(1);
    let calls = 0;
    const deps = depsWith(ledger, {
      structured: async (_route, call) => {
        calls += 1;
        return { value: call.schema.parse({ summary: "ok", points: [] }), actualUsd: 0.001 };
      },
    });
    const handler = productionHandlers(deps).analysis as NodeHandler;
    const input = { node: node({ id: "a", kind: "analysis", dependsOn: ["ref"] }), key: "same", upstream: new Map([["ref", "x"]]), upstreamKinds: NO_KINDS };
    await handler(input);
    await assert.rejects(handler(input), /already made/);
    assert.equal(calls, 1);
  });

  test("a call past the request budget is not made", async () => {
    const ledger = await ledgerWith(0.001);
    let called = false;
    const deps = depsWith(ledger, {
      structured: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    const handler = productionHandlers(deps).analysis as NodeHandler;
    // The reservation carries its request budget ($5) and no allowance, so a $6 call is past the budget and is refused in cap mode.
    await assert.rejects(handler({ node: node({ id: "a", kind: "analysis", dependsOn: ["ref"], estimateUsd: 6 }), key: "k", upstream: new Map([["ref", "x"]]), upstreamKinds: NO_KINDS }), /budget refused/);
    assert.equal(called, false);
  });

  test("an answer that does not match its schema fails the step, and its hold stays on the ledger", async () => {
    const ledger = await ledgerWith(1);
    const deps = depsWith(ledger, {
      structured: async (_route, call) => ({ value: call.schema.parse({ wrong: true }), actualUsd: 0.001 }),
    });
    const handler = productionHandlers(deps).analysis as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "a", kind: "analysis", dependsOn: ["ref"] }), key: "k", upstream: new Map([["ref", "x"]]), upstreamKinds: NO_KINDS }));
    const entries = await ledger.listEntries(RES);
    assert.equal(entries.length, 1, "the call was authorized, so its hold is kept");
  });

  test("a step that reads an upstream step with no stored body fails closed, and calls nothing", async () => {
    const ledger = await ledgerWith(1);
    const handler = productionHandlers(depsWith(ledger)).script as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "s", kind: "script", dependsOn: ["ref"] }), key: "k", upstream: new Map([["ref", null]]), upstreamKinds: NO_KINDS }), /no stored content/);
    assert.equal((await ledger.listEntries(RES)).length, 0);
  });

  test("the answer schemas bound what a body can hold", () => {
    assert.throws(() => scriptAnswerSchema.parse({ lines: [] }));
    assert.throws(() => analysisAnswerSchema.parse({ summary: "", points: [] }));
    assert.ok(z.object({ lines: scriptAnswerSchema.shape.lines }).safeParse({ lines: ["a"] }).success);
  });

  test("the kinds with no production handler are not connected: they have no entry, so the executor reports them not_connected", () => {
    const handlers = productionHandlers(depsWith(memoryLedgerStore()));
    for (const kind of ["visual", "voice", "video", "avatar", "edit", "compose", "render"] as const) {
      assert.equal(handlers[kind], undefined, `${kind} has no production handler yet`);
    }
  });
});

/** A router that answers every produce with the outcome it is given, and keeps what it was asked. */
function routerAnswering(outcome: unknown, asked: unknown[] = []): NonNullable<ProductionDeps["router"]> {
  return {
    produce: async (input: unknown) => {
      asked.push(input);
      return { outcome, decisions: [], alerts: [], attempts: [] } as never;
    },
    // A submit answers with the same step: a finished outcome, or a submitted job when the test gives one.
    submit: async (input: unknown) => {
      asked.push(input);
      return { step: outcome, decisions: [], alerts: [], attempts: [] } as never;
    },
  } as unknown as NonNullable<ProductionDeps["router"]>;
}

const SUBMITTED_JOB = { idempotencyKey: "job-1", jobRef: "provider-job-1" } as unknown as import("../assets/job.ts").AssetJob;

const DONE_ASSET = { status: "done", asset: { providerId: "openrouter:image", modelClass: "image.keyframe", uri: "engine/org/req/visual/asset.png", cacheKey: "k", costUsd: 0.02, cacheHit: false, savedUsd: 0, ledgerEntryId: null, generationId: null, mediaType: "image/png", submits: 1 } };

describe("production handlers: visual and voice (the run's asset router, D13)", () => {
  test("a visual step asks the router for one 9:16 image on the plan's model, and keeps its uri as the body", async () => {
    const asked: Array<{ spec: { modelChoice: { source: string; modelId: string }; modelClass: string; shotId: string; specId: string } }> = [];
    const handlers = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering(DONE_ASSET, asked) }));
    const handler = handlers.visual as NodeHandler;
    assert.ok(handler, "a visual handler exists when the run has a router");
    const visual = node({ id: "img", kind: "visual", model: { provider: "openrouter", id: "openai/image-model" }, params: { prompt: "A bowl of fruit" }, estimateUsd: 0.02 });
    const out = await handler({ node: visual, key: "k-img", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS });
    assert.equal(out.body, "engine/org/req/visual/asset.png");
    assert.equal(out.costUsd, 0.02, "the router's bill is the step's cost");
    assert.equal(asked[0]?.spec.modelClass, "image.keyframe");
    assert.equal(asked[0]?.spec.modelChoice.source, "orchestrator");
    assert.equal(asked[0]?.spec.modelChoice.modelId, "openai/image-model");
    assert.match(asked[0]?.spec.shotId ?? "", /^shot_0[0-9A-F]{25}$/, "the derived id is a valid shot id"); 
  });

  test("a voice step speaks the script it reads, with the plan's voice, and its spec is speech", async () => {
    const asked: Array<{ spec: { modelClass: string; prompt: string; durationMs: number }; voiceId: string | null }> = [];
    const handlers = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering({ ...DONE_ASSET, asset: { ...DONE_ASSET.asset, uri: "engine/org/req/voice/a.mp3", costUsd: 0.01 } }, asked) }));
    const voice = node({ id: "vo", kind: "voice", dependsOn: ["scr"], model: { provider: "openrouter", id: "elevenlabs/voice-model" }, params: { voice: "warm-narrator" }, estimateUsd: 0.01 });
    const out = await (handlers.voice as NodeHandler)({ node: voice, key: "k-vo", upstream: new Map([["scr", "Hook line\nSecond line"]]), upstreamKinds: NO_KINDS });
    assert.equal(out.body, "engine/org/req/voice/a.mp3");
    assert.equal(asked[0]?.spec.modelClass, "tts");
    assert.equal(asked[0]?.spec.prompt, "Hook line\nSecond line");
    assert.equal(asked[0]?.voiceId, "warm-narrator");
    assert.ok((asked[0]?.spec.durationMs ?? 0) >= 1000);
  });

  test("the same step names the same spec, so the cache can answer a repeat", async () => {
    const asked: Array<{ spec: { specId: string; seed: number } }> = [];
    const handler = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering(DONE_ASSET, asked) })).visual as NodeHandler;
    const visual = node({ id: "img", kind: "visual", model: { provider: "openrouter", id: "openai/image-model" }, params: { prompt: "A bowl" }, estimateUsd: 0.02 });
    await handler({ node: visual, key: "same", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS });
    await handler({ node: visual, key: "same", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS });
    assert.equal(asked[0]?.spec.specId, asked[1]?.spec.specId);
    assert.equal(asked[0]?.spec.seed, asked[1]?.spec.seed);
  });

  test("the router's refusals stop the step as the budget and the connection stop it: nothing is held for a refusal, and not_connected holds nothing", async () => {
    const visual = node({ id: "img", kind: "visual", model: { provider: "openrouter", id: "openai/image-model" }, params: { prompt: "A bowl" }, estimateUsd: 0.02 });
    const notConnected = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering({ status: "not_connected", reasons: ["no image provider"] }) })).visual as NodeHandler;
    await assert.rejects(notConnected({ node: visual, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), NotConnectedError);
    const refused = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering({ status: "refused", reasons: ["the reservation is full"] }) })).visual as NodeHandler;
    await assert.rejects(refused({ node: visual, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), CallRefusedError);
    const duplicate = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering({ status: "duplicate", providerId: "p", ledgerEntryId: "e" }) })).visual as NodeHandler;
    await assert.rejects(duplicate({ node: visual, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), CallRefusedError);
  });

  test("a video step names its video class: none, or a class that is not a video class, is refused before the router is asked", async () => {
    const asked: unknown[] = [];
    const handler = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering(DONE_ASSET, asked), queueAsset: async () => {} })).video as NodeHandler;
    const video = node({ id: "clip", kind: "video", model: { provider: "openrouter", id: "vendor/video-model" }, params: { prompt: "A wave", seconds: 4 }, estimateUsd: 0.4 });
    await assert.rejects(handler({ node: video, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), CallRefusedError);
    const wrong = { ...video, params: { ...video.params, model_class: "image.keyframe" } };
    await assert.rejects(handler({ node: wrong, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), CallRefusedError);
    assert.equal(asked.length, 0, "nothing reaches the router when the class is missing or wrong");
  });

  test("a video step submits on its named class and length, and a finished answer is its output", async () => {
    const asked: Array<{ spec: { modelClass: string; durationMs: number } }> = [];
    const handler = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering(DONE_ASSET, asked), queueAsset: async () => {} })).video as NodeHandler;
    const video = node({ id: "clip", kind: "video", model: { provider: "openrouter", id: "vendor/video-model" }, params: { prompt: "A wave", seconds: 4, model_class: "video.budget" }, estimateUsd: 0.4 });
    const out = await handler({ node: video, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS });
    assert.equal(asked[0]?.spec.modelClass, "video.budget");
    assert.equal(asked[0]?.spec.durationMs, 4000);
    assert.equal(out.body, DONE_ASSET.asset.uri);
  });

  test("an accepted video is queued: its submit is recorded for the poll, and the step stops as queued with no output", async () => {
    const queued: unknown[] = [];
    const submitted = { status: "submitted", job: SUBMITTED_JOB, runAfterMs: 5000 };
    const handler = productionHandlers(depsWith(await ledgerWith(1), {
      router: routerAnswering(submitted),
      queueAsset: async (entry) => { queued.push(entry); },
    })).video as NodeHandler;
    const video = node({ id: "clip", kind: "video", model: { provider: "openrouter", id: "vendor/video-model" }, params: { prompt: "A wave", seconds: 4, model_class: "video.budget" }, estimateUsd: 0.4 });
    await assert.rejects(handler({ node: video, key: "k", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), StepQueuedError);
    const entry = queued[0] as { kind: string; stepId: string; cacheKey: string; runAfterMs: number; job: unknown };
    assert.equal(queued.length, 1);
    assert.equal(entry.kind, "video");
    assert.equal(entry.stepId, "clip");
    assert.equal(entry.cacheKey, "k");
    assert.equal(entry.runAfterMs, 5000);
    assert.deepEqual(entry.job, SUBMITTED_JOB);
  });

  test("an avatar step reads its presenter image and its voice, and is refused when it reads no presenter image", async () => {
    const asked: Array<{ spec: { modelClass: string; refs: string[] } }> = [];
    const handler = productionHandlers(depsWith(await ledgerWith(1), { router: routerAnswering(DONE_ASSET, asked), queueAsset: async () => {} })).avatar as NodeHandler;
    const avatar = node({ id: "host", kind: "avatar", dependsOn: ["img", "vo"], model: { provider: "openrouter", id: "vendor/avatar-model" }, params: { prompt: "Say hello", seconds: 6 }, estimateUsd: 0.5 });
    const kinds = new Map<string, NodeKind>([["img", "visual"], ["vo", "voice"]]);
    await handler({ node: avatar, key: "k-av", upstream: new Map([["img", "engine/x/presenter.png"], ["vo", "engine/x/voice.mp3"]]), upstreamKinds: kinds });
    assert.equal(asked[0]?.spec.modelClass, "avatar");
    assert.deepEqual(asked[0]?.spec.refs, ["engine/x/presenter.png", "engine/x/voice.mp3"]);
    await assert.rejects(
      handler({ node: avatar, key: "k-av2", upstream: new Map([["vo", "engine/x/voice.mp3"]]), upstreamKinds: new Map<string, NodeKind>([["vo", "voice"]]) }),
      CallRefusedError,
    );
  });

  test("a video or avatar step with no durable poll connected is not connected, and nothing is submitted", () => {
    const handlers = productionHandlers(depsWith(memoryLedgerStore(), { router: routerAnswering(DONE_ASSET) }));
    assert.equal(handlers.video, undefined);
    assert.equal(handlers.avatar, undefined);
  });

  test("without a router the visual, voice and video steps have no handler, so the executor reports them not_connected", () => {
    const handlers = productionHandlers(depsWith(memoryLedgerStore()));
    assert.equal(handlers.visual, undefined);
    assert.equal(handlers.voice, undefined);
    assert.equal(handlers.video, undefined);
  });
});

describe("production handlers: a queued clip waits once, and measure mode holds an unpriced one (D14, D15)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
  });

  after(async () => {
    await db.close();
  });

  /** A workspace with one plan, so the queued rows belong to it. */
  async function planIn(org: string, planId: string): Promise<void> {
    await seedWorkspace(db.sql, org);
    await createPlanDraft(db.sql, { id: planId, organizationId: org, title: planId, brief: {}, orchestratorModel: "orchestrator-test-model", budgetUsd: 5 });
  }

  /** A router that counts its submits, and answers each one with the step it is given. */
  function countingRouter(counted: { submits: number }): NonNullable<ProductionDeps["router"]> {
    return {
      produce: async () => {
        throw new Error("a queued clip is never produced inline");
      },
      submit: async () => {
        counted.submits += 1;
        return { step: SUBMITTED_STEP, decisions: [], alerts: [], attempts: [] } as never;
      },
    } as unknown as NonNullable<ProductionDeps["router"]>;
  }

  const SUBMITTED_STEP = { status: "submitted", job: SUBMITTED_JOB, runAfterMs: 5000 };

  const clip = (over: Partial<PlanNode> = {}): PlanNode =>
    node({ id: "clip", kind: "video", model: { provider: "openrouter", id: "vendor/video-model" }, params: { prompt: "A wave", seconds: 8, model_class: "video.budget" }, estimateUsd: null, ...over });

  test("a re-run while the job waits reports the step queued, and submits nothing", async () => {
    const org = "org_queued_guard";
    await planIn(org, "plan_queued_guard");
    const counted = { submits: 0 };
    const handler = productionHandlers(depsWith(await ledgerWith(1), {
      organizationId: org,
      planId: "plan_queued_guard",
      sql: db.sql,
      router: countingRouter(counted),
      queueAsset: (entry: QueuedAsset) => queueAssetJob(db.sql, org, entry),
    })).video as NodeHandler;
    const priced = clip({ estimateUsd: 0.4 });

    await assert.rejects(handler({ node: priced, key: "k-guard", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), StepQueuedError);
    assert.equal(counted.submits, 1, "the first run submits the job once");

    await assert.rejects(
      handler({ node: priced, key: "k-guard", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }),
      (error) => error instanceof StepQueuedError && /already counted/.test(error.message),
    );
    assert.equal(counted.submits, 1, "the re-run submits nothing: its hold is already counted");
    const [count] = await db.sql<{ n: unknown }>`select count(*) as n from orchestrator_asset_jobs where organization_id = ${org}`;
    assert.equal(Number(count?.n), 1, "one waiting job, not two");
  });

  test("a job waiting in another plan does not block this plan's step", async () => {
    const org = "org_queued_other_plan";
    await planIn(org, "plan_queued_first");
    await planIn(org, "plan_queued_second");
    const first = { submits: 0 };
    await assert.rejects(
      (productionHandlers(depsWith(await ledgerWith(1), { organizationId: org, planId: "plan_queued_first", sql: db.sql, router: countingRouter(first), queueAsset: (entry: QueuedAsset) => queueAssetJob(db.sql, org, entry) })).video as NodeHandler)({ node: clip({ estimateUsd: 0.4 }), key: "k-shared", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }),
      StepQueuedError,
    );
    const second = { submits: 0 };
    await assert.rejects(
      (productionHandlers(depsWith(await ledgerWith(1), { organizationId: org, planId: "plan_queued_second", sql: db.sql, router: countingRouter(second), queueAsset: (entry: QueuedAsset) => queueAssetJob(db.sql, org, entry) })).video as NodeHandler)({ node: clip({ estimateUsd: 0.4 }), key: "k-shared", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }),
      StepQueuedError,
    );
    assert.equal(second.submits, 1, "the second plan's step is its own: it submits");
  });

  test("measure mode holds an unpriced clip to its ceiling times its length, and the queued job carries that hold and length", async () => {
    const counted = { submits: 0 };
    const queued: QueuedAsset[] = [];
    const handler = productionHandlers(depsWith(await ledgerWith(1), {
      router: countingRouter(counted),
      queueAsset: async (entry) => {
        queued.push(entry);
      },
      measure: { ceilingUsdPerSecond: 0.5 },
    })).video as NodeHandler;

    await assert.rejects(handler({ node: clip(), key: "k-measure", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), StepQueuedError);
    assert.equal(counted.submits, 1);
    assert.equal(queued[0]?.hold, 4, "8 seconds at 0.50 a second");
    assert.equal(queued[0]?.seconds, 8);
  });

  test("without measure mode an unpriced clip is refused before anything is submitted or queued", async () => {
    for (const measure of [undefined, null] as const) {
      const counted = { submits: 0 };
      const queued: QueuedAsset[] = [];
      const handler = productionHandlers(depsWith(await ledgerWith(1), {
        router: countingRouter(counted),
        queueAsset: async (entry) => {
          queued.push(entry);
        },
        measure,
      })).video as NodeHandler;
      await assert.rejects(handler({ node: clip(), key: "k-off", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), CallRefusedError);
      assert.equal(counted.submits, 0, "nothing is submitted when the step has no hold");
      assert.equal(queued.length, 0);
    }
  });

  test("a priced clip is queued with its estimate as its hold, and the queued row holds that amount until the poll settles it", async () => {
    const org = "org_queued_priced";
    await planIn(org, "plan_queued_priced");
    const counted = { submits: 0 };
    const handler = productionHandlers(depsWith(await ledgerWith(1), {
      organizationId: org,
      planId: "plan_queued_priced",
      sql: db.sql,
      router: countingRouter(counted),
      queueAsset: (entry: QueuedAsset) => queueAssetJob(db.sql, org, entry),
    })).video as NodeHandler;

    await assert.rejects(handler({ node: clip({ estimateUsd: 0.4 }), key: "k-priced", upstream: NO_UPSTREAM, upstreamKinds: NO_KINDS }), StepQueuedError);
    const [found] = await db.sql<{ held_usd: unknown; hold_usd: unknown; seconds: unknown }>`
      select held_usd, hold_usd, seconds from orchestrator_asset_jobs where organization_id = ${org} and cache_key = 'k-priced'
    `;
    assert.deepEqual([Number(found?.held_usd), Number(found?.hold_usd), Number(found?.seconds)], [0.4, 0.4, 8]);
  });
});

