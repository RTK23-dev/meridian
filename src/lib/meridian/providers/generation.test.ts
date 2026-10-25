// Ordinary text generation through the gateway: the workspace's own key and chosen model, the checks and budget hold before each paid
// call, and what the call reports back. The gateway transport and the credential resolver are replaced; no test calls a live provider.
// Every key is a stub. Each scenario gets its own workspace on the embedded database, so holds are written to a real ledger.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createGateway } from "../../../engine/gateway/gateway.ts";
import { meridianCredentialSource, type MeridianResolver } from "../../../engine/gateway/meridian.ts";
import type { HttpRequest, HttpResponse } from "../../../engine/gateway/types.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import type { ResearchSegment } from "../research/schema.ts";
import { synthesizeResearchTranscript } from "../research/analyzer.ts";
import { resolveDeploymentOnlyKey } from "../credentials/resolve.ts";
import { openTestBackends, withEnv } from "../credentials/test-databases.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storedGenerationModel, storedGenerationModels, saveGenerationModel, type GenerationTask } from "../settings/generation-models.ts";
import { completeGenerationTask, completeWithModel, extractJson, generationModelFor, type GenerationDeps, type GenerationInput, type GenerationRecord } from "./chat.server.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const KEY_A = "stub-workspace-a-openrouter-key-1001";
const KEY_B = "stub-workspace-b-openrouter-key-2002";
const DEPLOYMENT_KEY = "stub-deployment-openrouter-key-3003";
const WRITER = "vendor/writer";
const LOOKER = "vendor/looker";
const DECIDER = "vendor/decider";
const RETIRED = "vendor/retired";

function choice(id: string, inputModalities: string[] = ["text"], contextLength: number | null = 8000): TextModelChoice {
  return { id, name: id, promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002, inputModalities, contextLength };
}

const CATALOG: TextModelChoice[] = [choice(WRITER), choice(LOOKER, ["text", "image"])];

const embedded: Sql = backends[0]!.sql;

/** One workspace and its record, on the embedded database. Each scenario gets its own, so holds never meet another test's. */
async function scenario(label: string, operation = "copy-test") {
  const tenant = await studioTenant(embedded, label);
  const record: GenerationRecord = {
    sql: embedded,
    brandId: tenant.brandId,
    correlationId: `corr-${label}`,
    operation,
    promptId: "prompt-test",
    promptVersion: "1",
    inputRef: `ref-${label}`,
  };
  return { organizationId: tenant.organizationId, record };
}

function input(record: GenerationRecord, overrides: Partial<GenerationInput> = {}): GenerationInput {
  return { system: "Write the script.", user: "The brief.", maxTokens: 100, temperature: 0, record, ...overrides };
}

type Resolution = Awaited<ReturnType<MeridianResolver["workspace"]>>;

/** A resolver that records every key read. A workspace with no entry has no saved key. */
function fakeResolver(workspace: Record<string, Resolution>, deployment: Resolution = { status: "not_configured", reason: "OPENROUTER_API_KEY is not set." }) {
  const reads: string[] = [];
  const resolver: MeridianResolver = {
    deploymentOnly: async (key) => {
      reads.push(`deployment:${key}`);
      return deployment;
    },
    workspace: async (organizationId, category) => {
      reads.push(`workspace:${organizationId}:${category}`);
      return workspace[organizationId] ?? { status: "not_configured", reason: "No OpenRouter key is saved for this workspace." };
    },
  };
  return { resolver, reads };
}

type Sent = { url: string; authorization: string | null; body: Record<string, unknown> };

/** A transport that records each request and answers with `answer`. A transport that throws stands for an unreachable host. */
function fakeTransport(answer: (sent: Sent) => HttpResponse) {
  const sent: Sent[] = [];
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? null;
    const text = typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
    const record: Sent = { url: request.url, authorization, body: JSON.parse(text) as Record<string, unknown> };
    sent.push(record);
    return answer(record);
  };
  return { transport, sent };
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

/** A successful answer. The model that answered is the requested one with a dated suffix, as OpenRouter reports pinned builds. */
function answered(content: string, usage: Record<string, unknown> = { total_tokens: 42, cost: 0.00012 }): HttpResponse {
  return json(200, { id: "gen-1", model: `${WRITER}-2026-10`, choices: [{ message: { content } }], usage });
}

type Options = {
  resolver: MeridianResolver;
  transport: (request: HttpRequest) => Promise<HttpResponse>;
  stored?: (organizationId: string, task: GenerationTask) => Promise<string | null>;
  /** The live catalogue's text models. Null stands for a catalogue that could not be read. */
  choices?: TextModelChoice[] | null;
  env?: Record<string, string | undefined>;
};

function depsFor(options: Options): GenerationDeps {
  const gateway = createGateway({ transport: options.transport, credentials: meridianCredentialSource(options.resolver) });
  return {
    gateway,
    stored: options.stored ?? (async () => null),
    catalog: async () =>
      options.choices === null
        ? { status: "unavailable", reason: "the catalogue did not answer" }
        : { status: "ok", choices: options.choices ?? CATALOG, takenAt: "2026-10-25T00:00:00.000Z" },
    env: options.env ?? {},
  };
}

/** The ledger rows of one operation, read back from the database. */
async function runsOf(organizationId: string, operation: string) {
  return embedded<{ status: string; error: string; model: string; model_source: string; returned_model: string; generation_id: string; cost_usd: string | number | null; estimate_usd: string | number | null }>`
    select status, error, model, model_source, returned_model, generation_id, cost_usd, estimate_usd from model_runs
    where organization_id = ${organizationId} and operation = ${operation}
    order by created_at
  `;
}

test("the workspace's own key and chosen model are used, and what OpenRouter reports comes back with the answer", async () => {
  const { organizationId, record } = await scenario("ws-key");
  const { resolver, reads } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } }, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport, sent } = fakeTransport(() => answered('{"hook":"Stop"}'));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(result.ok);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent[0]?.authorization, `Bearer ${KEY_A}`);
  assert.equal(sent[0]?.body.model, WRITER);
  assert.equal(sent[0]?.body.max_tokens, 100);
  assert.deepEqual(reads, [`workspace:${organizationId}:openrouter`], "the deployment key is not read when the workspace has a usable one");
  assert.equal(result.model, WRITER);
  assert.equal(result.modelSource, "workspace");
  assert.equal(result.returnedModel, `${WRITER}-2026-10`);
  assert.equal(result.generationId, "gen-1");
  assert.equal(result.costUsd, 0.00012);
});

test("an unusable workspace key is never replaced by the deployment key, and nothing is held", async () => {
  const { organizationId, record } = await scenario("unusable");
  const { resolver, reads } = fakeResolver({ [organizationId]: { status: "unusable", reason: "The saved OpenRouter key was revoked." } }, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.equal(sent.length, 0, "nothing is sent with the unusable key or with the deployment key");
  assert.deepEqual(reads, [`workspace:${organizationId}:openrouter`]);
  assert.equal(JSON.stringify(result).includes(DEPLOYMENT_KEY), false);
  const runs = await runsOf(organizationId, "copy-test");
  assert.equal(runs[0]?.status, "failed", "a hold that was never sent is settled as not billed");
});

test("a workspace with no saved key sends nothing and is reported as not connected", async () => {
  const { organizationId, record } = await scenario("no-key");
  const { resolver } = fakeResolver({});
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /not connected/);
  assert.equal(sent.length, 0);
});

test("the deployment-only key is read only for an unscoped caller, and only through its own name", async () => {
  const { resolver, reads } = fakeResolver({}, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const { meridianCredentialSource: source } = await import("../../../engine/gateway/meridian.ts");
  const credential = await source(resolver).get("openrouter", null);
  assert.equal(credential.status, "ready");
  assert.deepEqual(reads, ["deployment:openrouter_chat"], "no workspace key is read when no workspace is in scope");
  const { record } = await scenario("unscoped");
  const refused = await completeWithModel(null, { ...input(record), model: WRITER, choice: choice(WRITER) }, depsFor({ resolver, transport }));
  assert.ok(!refused.ok, "a paid call with no workspace has no budget to hold, so it is refused");
  assert.equal(sent.length, 0);
});

test("the deployment-only key is used only when OPENROUTER_SHARED_DEFAULT=deployment opts in", async () => {
  const resolver: MeridianResolver = {
    deploymentOnly: async (key) => resolveDeploymentOnlyKey(key, process.env),
    workspace: async () => ({ status: "not_configured", reason: "none" }),
  };
  await withEnv({ OPENROUTER_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { organizationId, record } = await scenario("optin-off");
    const { transport, sent } = fakeTransport(() => answered("never sent"));
    const result = await completeWithModel(organizationId, { ...input(record), model: WRITER, choice: choice(WRITER) }, depsFor({ resolver, transport }));
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0, "without the opt-in the deployment key is not used");
  });
  await withEnv({ OPENROUTER_SHARED_DEFAULT: "deployment", OPENROUTER_API_KEY: DEPLOYMENT_KEY }, async () => {
    assert.equal(resolveDeploymentOnlyKey("openrouter_chat", process.env).status, "ready");
  });
});

test("with no chosen model and no deployment default, nothing is sent", async () => {
  const { organizationId, record } = await scenario("unset");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const decision = await generationModelFor(organizationId, "copy", depsFor({ resolver, transport }));
  assert.equal(decision.status, "unset");
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport }));
  assert.ok(!result.ok);
  assert.equal(sent.length, 0);
});

test("the deployment default applies only when the workspace chose nothing, and is reported as the deployment's", async () => {
  const { organizationId } = await scenario("default");
  const { resolver } = fakeResolver({});
  const { transport } = fakeTransport(() => answered("ok"));
  const decision = await generationModelFor(organizationId, "copy", depsFor({ resolver, transport, env: { OPENROUTER_MODEL: WRITER } }));
  assert.equal(decision.status, "ok");
  if (decision.status === "ok") assert.equal(decision.source, "deployment");
});

test("a workspace's chosen model wins over the deployment default", async () => {
  const { organizationId } = await scenario("chosen-wins");
  const { resolver } = fakeResolver({});
  const { transport } = fakeTransport(() => answered("ok"));
  const decision = await generationModelFor(organizationId, "copy", depsFor({ resolver, transport, env: { OPENROUTER_MODEL: LOOKER }, stored: async () => WRITER }));
  assert.equal(decision.status, "ok");
  if (decision.status === "ok") {
    assert.equal(decision.model, WRITER);
    assert.equal(decision.source, "workspace");
  }
});

test("image understanding never falls back to the deployment default", async () => {
  const { organizationId } = await scenario("vision-default");
  const { resolver } = fakeResolver({});
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const decision = await generationModelFor(organizationId, "vision", depsFor({ resolver, transport, env: { OPENROUTER_MODEL: LOOKER } }));
  assert.equal(decision.status, "unset");
  if (decision.status === "unset") assert.match(decision.reason, /images/);
  assert.equal(sent.length, 0);
});

test("a model the live catalogue no longer lists is refused before any call, and nothing is held", async () => {
  const { organizationId, record } = await scenario("retired");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => RETIRED }));
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /not a text model/);
  assert.equal(sent.length, 0);
  assert.equal((await runsOf(organizationId, "copy-test")).length, 0, "a refused call writes no run");
});

test("an unreadable catalogue refuses the call, so nothing is sent on an unchecked model", async () => {
  const { organizationId, record } = await scenario("unreadable");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER, choices: null }));
  assert.ok(!result.ok);
  assert.match(result.error, /could not be read/);
  assert.equal(sent.length, 0);
});

test("a decision model is never a generation model, even when it is the stored choice", async () => {
  const { organizationId, record } = await scenario("decider");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => DECIDER }));
  assert.ok(!result.ok);
  assert.equal(sent.length, 0);
});

test("a text-only model cannot read a keyframe, so image understanding sends nothing to it", async () => {
  const { organizationId } = await scenario("text-only-vision");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const decision = await generationModelFor(organizationId, "vision", depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.equal(decision.status, "unverified");
  if (decision.status === "unverified") assert.match(decision.reason, /does not take images/);
  assert.equal(sent.length, 0);
});

test("a vision call sends the keyframe in the user message, to a model that takes images", async () => {
  const { organizationId, record } = await scenario("vision-send");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered('{"shot_type":"close"}'));
  const image = "data:image/png;base64,AAAA";
  const result = await completeGenerationTask(
    organizationId,
    "vision",
    input(record, { user: [{ type: "text", text: "Analyze scene 0." }, { type: "image_url", image_url: { url: image } }] }),
    depsFor({ resolver, transport, stored: async () => LOOKER }),
  );
  assert.ok(result.ok);
  const messages = sent[0]?.body.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(messages[1]?.content, [
    { type: "text", text: "Analyze scene 0." },
    { type: "image_url", image_url: { url: image } },
  ]);
});

test("a server error is uncertain, is not retried, and its body is not echoed", async () => {
  const { organizationId, record } = await scenario("server-error");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => json(500, { error: `echo ${KEY_A}` }));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "uncertain");
  assert.match(result.error, /returned 500\. The call may have been billed/);
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
  const runs = await runsOf(organizationId, "copy-test");
  assert.equal(runs[0]?.status, "uncertain", "the hold stays on the ledger");
});

test("a request refused before generation (400) is failed, and its hold is released", async () => {
  const { organizationId, record } = await scenario("refused");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => json(400, { error: "bad request" }));
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "OpenRouter returned 400.");
  const runs = await runsOf(organizationId, "copy-test");
  assert.equal(runs[0]?.status, "failed");
  assert.equal(runs[0]?.cost_usd, null);
});

test("a host that cannot be reached, or a timed-out request, is uncertain and carries no key", async () => {
  const { organizationId, record } = await scenario("unreachable");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => {
    throw new Error(`The request was aborted while ${KEY_A} was in use.`);
  });
  const result = await completeGenerationTask(organizationId, "copy", input(record), depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "uncertain");
  assert.equal(result.error, "OpenRouter could not be reached. The call may have been billed, so it was not retried.");
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
  const runs = await runsOf(organizationId, "copy-test");
  assert.equal(runs[0]?.status, "uncertain");
});

test("an answer of the wrong shape is uncertain; an empty answer is failed but its billed cost is kept", async () => {
  const { organizationId, record } = await scenario("shape");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const notJson = fakeTransport(() => ({ status: 200, headers: {}, body: new TextEncoder().encode("<html>") }));
  const wrongShape = await completeWithModel(organizationId, { ...input(record), model: WRITER, choice: choice(WRITER) }, depsFor({ resolver, transport: notJson.transport }));
  assert.ok(!wrongShape.ok);
  assert.equal(wrongShape.status, "uncertain");
  const empty = fakeTransport(() => json(200, { id: "gen-2", model: WRITER, choices: [{ message: { content: "   " } }], usage: { cost: 0.00003 } }));
  const noContent = await completeWithModel(organizationId, { ...input(record), model: WRITER, choice: choice(WRITER) }, depsFor({ resolver, transport: empty.transport }));
  assert.ok(!noContent.ok);
  assert.equal(noContent.status, "failed");
  assert.equal(noContent.error, "OpenRouter returned an empty response.");
  const runs = await runsOf(organizationId, "copy-test");
  assert.deepEqual(runs.map((run) => run.status).sort(), ["completed", "uncertain"]);
  const billedEmpty = runs.find((run) => run.status === "completed");
  assert.equal(Number(billedEmpty?.cost_usd), 0.00003, "a billed empty answer keeps its reported cost");
});

test("a cost is recorded only when OpenRouter reports one, and is never zero by default", async () => {
  const { organizationId, record } = await scenario("no-cost");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => answered("ok", { total_tokens: 7 }));
  const result = await completeWithModel(organizationId, { ...input(record), model: WRITER, choice: choice(WRITER) }, depsFor({ resolver, transport }));
  assert.ok(result.ok);
  assert.equal(result.costUsd, null);
  assert.equal(result.tokens, 7);
  const runs = await runsOf(organizationId, "copy-test");
  assert.equal(runs[0]?.cost_usd, null, "the ledger keeps null, never an estimate, when the provider reports no cost");
  assert.ok(Number(runs[0]?.estimate_usd) > 0, "the hold keeps the estimate beside it");
});

test("a call above the per-call ceiling is refused before a hold is written or anything is sent", async () => {
  const { organizationId, record } = await scenario("ceiling");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const big = choice(WRITER, ["text"], 128000);
  const result = await completeWithModel(
    organizationId,
    { ...input(record, { maxTokens: 100_000 }), model: WRITER, choice: big },
    depsFor({ resolver, transport, env: { OPENROUTER_GENERATION_MAX_USD_PER_CALL: "0.01" } }),
  );
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /above the per-call ceiling/);
  assert.equal(sent.length, 0);
  assert.equal((await runsOf(organizationId, "copy-test")).length, 0);
});

test("an invalid per-call ceiling refuses every call", async () => {
  const { organizationId, record } = await scenario("bad-ceiling");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeWithModel(organizationId, { ...input(record), model: WRITER, choice: choice(WRITER) }, depsFor({ resolver, transport, env: { OPENROUTER_GENERATION_MAX_USD_PER_CALL: "lots" } }));
  assert.ok(!result.ok);
  assert.match(result.error, /must be a positive number/);
  assert.equal(sent.length, 0);
});

test("an image whose model states no context length is refused, because its cost cannot be bounded", async () => {
  const { organizationId, record } = await scenario("unbounded-image");
  const { resolver } = fakeResolver({ [organizationId]: { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeWithModel(
    organizationId,
    { ...input(record, { user: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }), model: LOOKER, choice: choice(LOOKER, ["text", "image"], null) },
    depsFor({ resolver, transport }),
  );
  assert.ok(!result.ok);
  assert.match(result.error, /context length is not stated/);
  assert.equal(sent.length, 0);
});

test("one workspace's call reads only its own key, model and catalogue, and holds only its own budget", async () => {
  const a = await scenario("iso-a");
  const b = await scenario("iso-b");
  const { resolver, reads } = fakeResolver({
    [a.organizationId]: { status: "ready", secret: KEY_A },
    [b.organizationId]: { status: "ready", secret: KEY_B },
  });
  const { transport, sent } = fakeTransport(() => answered("ok"));
  const storedFor: string[] = [];
  const result = await completeGenerationTask(
    b.organizationId,
    "copy",
    input(b.record),
    depsFor({
      resolver,
      transport,
      stored: async (organizationId) => {
        storedFor.push(organizationId);
        return WRITER;
      },
    }),
  );
  assert.ok(result.ok);
  assert.deepEqual(storedFor, [b.organizationId]);
  assert.deepEqual(reads, [`workspace:${b.organizationId}:openrouter`]);
  assert.equal(sent[0]?.authorization, `Bearer ${KEY_B}`);
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
  assert.equal((await runsOf(a.organizationId, "copy-test")).length, 0, "the other workspace's ledger is untouched");
});

test("extractJson reads fenced JSON and JSON inside prose, and refuses an answer with none", () => {
  assert.deepEqual(extractJson('```json\n{"hook":"a"}\n```'), { hook: "a" });
  assert.deepEqual(extractJson('Here it is: {"hook":"b"} thanks'), { hook: "b" });
  assert.throws(() => extractJson("no object here"), /did not return JSON/);
});

test("an uncertain research analysis reports uncertain, so the job does not retry it", async () => {
  const segments = [{ id: "s1", text: "Hello there", startMs: 0, endMs: 1000 }] as unknown as ResearchSegment[];
  const result = await synthesizeResearchTranscript({
    sourceId: "ad-1",
    transcript: "Hello there",
    segments,
    provider: "openrouter",
    model: WRITER,
    complete: async () => ({ ok: false, status: "uncertain", provider: "openrouter", error: "OpenRouter could not be reached." }),
  });
  assert.equal(result.status, "uncertain");
});

// Stored choices, read and written through the database. Each backend runs the same checks.
for (const { name, sql } of backends) {
  test(`[${name}] a workspace's text model is saved, read back and cleared`, async () => {
    const tenant = await studioTenant(sql, `gen-save-${name}`);
    const saved = await saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: WRITER, actorId: "user-a", choices: CATALOG });
    assert.deepEqual(saved, { status: "saved", modelId: WRITER });
    assert.equal(await storedGenerationModel(sql, tenant.organizationId, "copy"), WRITER);
    const all = await storedGenerationModels(sql, tenant.organizationId);
    assert.equal(all.copy?.modelId, WRITER);
    assert.equal(all.copy?.updatedBy, "user-a");
    await saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: null, actorId: "user-a", choices: null });
    assert.equal(await storedGenerationModel(sql, tenant.organizationId, "copy"), null, "clearing needs no catalogue");
  });

  test(`[${name}] a decision model, an alias, and a text-only model for images are all refused, and nothing is stored`, async () => {
    const tenant = await studioTenant(sql, `gen-refuse-${name}`);
    await assert.rejects(saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: DECIDER, actorId: "user-a", choices: CATALOG }), /is not a text model/);
    await assert.rejects(saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: "~vendor/writer-latest", actorId: "user-a", choices: CATALOG }), /pinned OpenRouter id/);
    await assert.rejects(saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "vision", modelId: WRITER, actorId: "user-a", choices: CATALOG }), /does not take images/);
    assert.deepEqual(await storedGenerationModels(sql, tenant.organizationId), {});
  });

  test(`[${name}] a model is never saved without a readable catalogue`, async () => {
    const tenant = await studioTenant(sql, `gen-nocatalog-${name}`);
    await assert.rejects(saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: WRITER, actorId: "user-a", choices: null }), /could not be read/);
    assert.equal(await storedGenerationModel(sql, tenant.organizationId, "copy"), null);
  });

  test(`[${name}] one workspace's chosen model is never read by another`, async () => {
    const a = await studioTenant(sql, `gen-iso-a-${name}`);
    const b = await studioTenant(sql, `gen-iso-b-${name}`);
    await saveGenerationModel(sql, { organizationId: a.organizationId, task: "research_analysis", modelId: WRITER, actorId: "user-a", choices: CATALOG });
    assert.equal(await storedGenerationModel(sql, b.organizationId, "research_analysis"), null);
    assert.deepEqual(await storedGenerationModels(sql, b.organizationId), {});
  });

  test(`[${name}] a settled call keeps its provenance, and a second settlement changes nothing`, async () => {
    const tenant = await studioTenant(sql, `gen-prov-${name}`);
    const operation = `copy-prov-${name}-${Date.now()}`;
    const record: GenerationRecord = { sql, brandId: tenant.brandId, correlationId: "corr-p", operation, promptId: "p", promptVersion: "1", inputRef: "r" };
    const { transport } = fakeTransport(() => answered("ok"));
    const { resolver } = fakeResolver({ [tenant.organizationId]: { status: "ready", secret: KEY_A } });
    const result = await completeWithModel(tenant.organizationId, { ...input(record), model: WRITER, modelSource: "workspace", choice: choice(WRITER) }, depsFor({ resolver, transport }));
    assert.ok(result.ok);
    const rows = await sql<{ id: string; model: string; model_source: string; returned_model: string; generation_id: string; cost_usd: string | number | null; status: string }>`
      select id, model, model_source, returned_model, generation_id, cost_usd, status from model_runs
      where organization_id = ${tenant.organizationId} and operation = ${operation}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, WRITER);
    assert.equal(rows[0]?.model_source, "workspace");
    assert.equal(rows[0]?.returned_model, `${WRITER}-2026-10`);
    assert.equal(rows[0]?.generation_id, "gen-1");
    assert.equal(Number(rows[0]?.cost_usd), 0.00012);
    assert.equal(rows[0]?.status, "completed");
  });
}
