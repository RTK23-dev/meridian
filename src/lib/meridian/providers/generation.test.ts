// Ordinary text generation through the gateway: the workspace's own key and chosen model, the checks before a paid call, and what a call
// reports back. The gateway transport and the credential resolver are replaced; no test calls a live provider. Every key is a stub.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createGateway } from "../../../engine/gateway/gateway.ts";
import { meridianCredentialSource, type MeridianResolver } from "../../../engine/gateway/meridian.ts";
import type { HttpRequest, HttpResponse } from "../../../engine/gateway/types.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import { resolveDeploymentOnlyKey } from "../credentials/resolve.ts";
import { openTestBackends, withEnv } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storedGenerationModel, storedGenerationModels, saveGenerationModel, type GenerationTask } from "../settings/generation-models.ts";
import { completeGenerationTask, completeWithModel, extractJson, generationModelFor, type GenerationDeps, type GenerationInput } from "./chat.server.ts";
import { recordGenerationRun } from "./model-run.ts";

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

const input: GenerationInput = { system: "Write the script.", user: "The brief.", maxTokens: 100, temperature: 0 };

function choice(id: string, inputModalities: string[] = ["text"]): TextModelChoice {
  return { id, name: id, promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002, inputModalities };
}

const CATALOG: TextModelChoice[] = [choice(WRITER), choice(LOOKER, ["text", "image"])];

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

test("the workspace's own key and chosen model are used, and what OpenRouter reports comes back with the answer", async () => {
  const { resolver, reads } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } }, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport, sent } = fakeTransport(() => answered('{"hook":"Stop"}'));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(result.ok);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent[0]?.authorization, `Bearer ${KEY_A}`);
  assert.equal(sent[0]?.body.model, WRITER);
  assert.equal(sent[0]?.body.max_tokens, 100);
  assert.equal(sent[0]?.body.temperature, 0);
  assert.deepEqual(reads, ["workspace:org-a:openrouter"], "the deployment key is not read when the workspace has a usable one");
  assert.equal(result.model, WRITER);
  assert.equal(result.modelSource, "workspace");
  assert.equal(result.returnedModel, `${WRITER}-2026-10`, "the model that answered is recorded beside the one asked for");
  assert.equal(result.generationId, "gen-1");
  assert.equal(result.costUsd, 0.00012);
});

test("an unusable workspace key is never replaced by the deployment key", async () => {
  const { resolver, reads } = fakeResolver({ "org-a": { status: "unusable", reason: "The saved OpenRouter key was revoked." } }, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.equal(sent.length, 0, "nothing is sent with the unusable key or with the deployment key");
  assert.deepEqual(reads, ["workspace:org-a:openrouter"]);
  assert.equal(JSON.stringify(result).includes(DEPLOYMENT_KEY), false);
});

test("a workspace with no saved key sends nothing and is reported as not connected", async () => {
  const { resolver } = fakeResolver({});
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /not connected/);
  assert.equal(sent.length, 0);
});

test("with no workspace in scope, only the deployment-only key is read, and only through its own name", async () => {
  const { resolver, reads } = fakeResolver({}, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport, sent } = fakeTransport(() => answered("ok"));
  const result = await completeWithModel(null, { ...input, model: WRITER }, depsFor({ resolver, transport }));
  assert.ok(result.ok);
  assert.equal(sent[0]?.authorization, `Bearer ${DEPLOYMENT_KEY}`);
  assert.deepEqual(reads, ["deployment:openrouter_chat"], "no workspace key is read when no workspace is in scope");
});

test("the deployment-only key is used only when OPENROUTER_SHARED_DEFAULT=deployment opts in", async () => {
  const resolver: MeridianResolver = {
    deploymentOnly: async (key) => resolveDeploymentOnlyKey(key, process.env),
    workspace: async () => ({ status: "not_configured", reason: "none" }),
  };
  await withEnv({ OPENROUTER_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { transport, sent } = fakeTransport(() => answered("never sent"));
    const result = await completeWithModel(null, { ...input, model: WRITER }, depsFor({ resolver, transport }));
    assert.equal(result.ok, false);
    assert.equal(sent.length, 0, "without the opt-in the deployment key is not used");
  });
  await withEnv({ OPENROUTER_SHARED_DEFAULT: "deployment", OPENROUTER_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { transport, sent } = fakeTransport(() => answered("ok"));
    const result = await completeWithModel(null, { ...input, model: WRITER }, depsFor({ resolver, transport }));
    assert.ok(result.ok);
    assert.equal(sent[0]?.authorization, `Bearer ${DEPLOYMENT_KEY}`);
  });
});

test("with no chosen model and no deployment default, nothing is sent", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const decision = await generationModelFor("org-a", "copy", depsFor({ resolver, transport }));
  assert.equal(decision.status, "unset");
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport }));
  assert.ok(!result.ok);
  assert.equal(sent.length, 0);
});

test("the deployment default applies only when the workspace chose nothing, and is reported as the deployment's", async () => {
  const { resolver } = fakeResolver({});
  const { transport } = fakeTransport(() => answered("ok"));
  const decision = await generationModelFor("org-a", "copy", depsFor({ resolver, transport, env: { OPENROUTER_MODEL: WRITER } }));
  assert.equal(decision.status, "ok");
  if (decision.status === "ok") assert.equal(decision.source, "deployment");
});

test("a workspace's chosen model wins over the deployment default", async () => {
  const { resolver } = fakeResolver({});
  const { transport } = fakeTransport(() => answered("ok"));
  const decision = await generationModelFor(
    "org-a",
    "copy",
    depsFor({ resolver, transport, env: { OPENROUTER_MODEL: LOOKER }, stored: async () => WRITER }),
  );
  assert.equal(decision.status, "ok");
  if (decision.status === "ok") {
    assert.equal(decision.model, WRITER);
    assert.equal(decision.source, "workspace");
  }
});

test("image understanding never falls back to the deployment default", async () => {
  const { resolver } = fakeResolver({});
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const decision = await generationModelFor("org-a", "vision", depsFor({ resolver, transport, env: { OPENROUTER_MODEL: LOOKER } }));
  assert.equal(decision.status, "unset");
  if (decision.status === "unset") assert.match(decision.reason, /images/);
  assert.equal(sent.length, 0);
});

test("a model the live catalogue no longer lists is refused before any call", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => RETIRED }));
  assert.ok(!result.ok);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /not a text model/);
  assert.equal(sent.length, 0, "a stale model is not sent");
});

test("an unreadable catalogue refuses the call, so nothing is sent on an unchecked model", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER, choices: null }));
  assert.ok(!result.ok);
  assert.match(result.error, /could not be read/);
  assert.equal(sent.length, 0);
});

test("a decision model is never a generation model, even when it is the stored choice", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  // The text catalogue (textChoices) does not list a decision model, so it is not among the choices a task may use.
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => DECIDER }));
  assert.ok(!result.ok);
  assert.equal(sent.length, 0);
});

test("a text-only model cannot read a keyframe, so image understanding sends nothing to it", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered("never sent"));
  const decision = await generationModelFor("org-a", "vision", depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.equal(decision.status, "unverified");
  if (decision.status === "unverified") assert.match(decision.reason, /does not take images/);
  assert.equal(sent.length, 0);
});

test("a vision call sends the keyframe in the user message, to a model that takes images", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport, sent } = fakeTransport(() => answered('{"shot_type":"close"}'));
  const image = "data:image/png;base64,AAAA";
  const result = await completeGenerationTask(
    "org-a",
    "vision",
    { ...input, user: [{ type: "text", text: "Analyze scene 0." }, { type: "image_url", image_url: { url: image } }] },
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

test("a server error is reported as failed with its status, and the body is not echoed", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => json(500, { error: `echo ${KEY_A}` }));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "OpenRouter returned 500.");
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
});

test("a host that cannot be reached, or a timed-out request, is failed and carries no key", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => {
    throw new Error(`The request was aborted while ${KEY_A} was in use.`);
  });
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.ok(!result.ok);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "OpenRouter could not be reached.");
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
});

test("an answer of the wrong shape, or with no content, is failed", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const notJson = fakeTransport(() => ({ status: 200, headers: {}, body: new TextEncoder().encode("<html>") }));
  const wrongShape = await completeWithModel("org-a", { ...input, model: WRITER }, depsFor({ resolver, transport: notJson.transport }));
  assert.ok(!wrongShape.ok);
  assert.equal(wrongShape.status === "failed" && wrongShape.error, "OpenRouter answered with an unexpected shape.");
  const empty = fakeTransport(() => json(200, { choices: [{ message: { content: "   " } }] }));
  const noContent = await completeWithModel("org-a", { ...input, model: WRITER }, depsFor({ resolver, transport: empty.transport }));
  assert.ok(!noContent.ok);
  assert.equal(noContent.status === "failed" && noContent.error, "OpenRouter returned an empty response.");
});

test("a cost is recorded only when OpenRouter reports one, and is never zero by default", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } });
  const { transport } = fakeTransport(() => answered("ok", { total_tokens: 7 }));
  const result = await completeWithModel("org-a", { ...input, model: WRITER }, depsFor({ resolver, transport }));
  assert.ok(result.ok);
  assert.equal(result.costUsd, null);
  assert.equal(result.tokens, 7);
});

test("one workspace's call reads only its own key, model and catalogue", async () => {
  const { resolver, reads } = fakeResolver({
    "org-a": { status: "ready", secret: KEY_A },
    "org-b": { status: "ready", secret: KEY_B },
  });
  const { transport, sent } = fakeTransport(() => answered("ok"));
  const storedFor: string[] = [];
  const result = await completeGenerationTask(
    "org-b",
    "copy",
    input,
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
  assert.deepEqual(storedFor, ["org-b"]);
  assert.deepEqual(reads, ["workspace:org-b:openrouter"]);
  assert.equal(sent[0]?.authorization, `Bearer ${KEY_B}`);
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
});

test("an answer never carries the key, whichever workspace made the call", async () => {
  const { resolver } = fakeResolver({ "org-a": { status: "ready", secret: KEY_A } }, { status: "ready", secret: DEPLOYMENT_KEY });
  const { transport } = fakeTransport(() => answered("ok"));
  const result = await completeGenerationTask("org-a", "copy", input, depsFor({ resolver, transport, stored: async () => WRITER }));
  assert.equal(JSON.stringify(result).includes(KEY_A), false);
  assert.equal(JSON.stringify(result).includes(DEPLOYMENT_KEY), false);
});

test("extractJson reads fenced JSON and JSON inside prose, and refuses an answer with none", () => {
  assert.deepEqual(extractJson('```json\n{"hook":"a"}\n```'), { hook: "a" });
  assert.deepEqual(extractJson('Here it is: {"hook":"b"} thanks'), { hook: "b" });
  assert.throws(() => extractJson("no object here"), /did not return JSON/);
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
    await assert.rejects(
      saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: DECIDER, actorId: "user-a", choices: CATALOG }),
      /is not a text model/,
    );
    await assert.rejects(
      saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: "~vendor/writer-latest", actorId: "user-a", choices: CATALOG }),
      /pinned OpenRouter id/,
    );
    await assert.rejects(
      saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "vision", modelId: WRITER, actorId: "user-a", choices: CATALOG }),
      /does not take images/,
    );
    assert.deepEqual(await storedGenerationModels(sql, tenant.organizationId), {});
  });

  test(`[${name}] a model is never saved without a readable catalogue`, async () => {
    const tenant = await studioTenant(sql, `gen-nocatalog-${name}`);
    await assert.rejects(
      saveGenerationModel(sql, { organizationId: tenant.organizationId, task: "copy", modelId: WRITER, actorId: "user-a", choices: null }),
      /could not be read/,
    );
    assert.equal(await storedGenerationModel(sql, tenant.organizationId, "copy"), null);
  });

  test(`[${name}] one workspace's chosen model is never read by another`, async () => {
    const a = await studioTenant(sql, `gen-iso-a-${name}`);
    const b = await studioTenant(sql, `gen-iso-b-${name}`);
    await saveGenerationModel(sql, { organizationId: a.organizationId, task: "research_analysis", modelId: WRITER, actorId: "user-a", choices: CATALOG });
    assert.equal(await storedGenerationModel(sql, b.organizationId, "research_analysis"), null);
    assert.deepEqual(await storedGenerationModels(sql, b.organizationId), {});
  });

  test(`[${name}] a model run keeps the model that answered, the generation id, the reported cost and the model source`, async () => {
    const tenant = await studioTenant(sql, `gen-run-${name}`);
    const operation = `copy-test-${name}-${Date.now()}`;
    const result = await completeWithModel(
      tenant.organizationId,
      { ...input, model: WRITER, modelSource: "workspace" },
      depsFor({ resolver: fakeResolver({ [tenant.organizationId]: { status: "ready", secret: KEY_A } }).resolver, transport: fakeTransport(() => answered("ok")).transport }),
    );
    await recordGenerationRun(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, correlationId: "corr-1", operation, promptId: "creative_script", promptVersion: "1", inputRef: "brief-1" }, result);
    const rows = await sql<{ model: string; model_source: string; returned_model: string; generation_id: string; cost_usd: string | number | null; status: string }>`
      select model, model_source, returned_model, generation_id, cost_usd, status from model_runs
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

  test(`[${name}] a failed run is recorded with its reason and no cost, not as zero`, async () => {
    const tenant = await studioTenant(sql, `gen-fail-${name}`);
    const operation = `copy-fail-${name}-${Date.now()}`;
    const result = await completeWithModel(
      tenant.organizationId,
      { ...input, model: WRITER },
      depsFor({ resolver: fakeResolver({ [tenant.organizationId]: { status: "ready", secret: KEY_A } }).resolver, transport: fakeTransport(() => json(429, {})).transport }),
    );
    await recordGenerationRun(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, correlationId: "corr-2", operation, promptId: "creative_script", promptVersion: "1", inputRef: "brief-2" }, result);
    const rows = await sql<{ status: string; error: string; cost_usd: string | number | null; returned_model: string }>`
      select status, error, cost_usd, returned_model from model_runs where organization_id = ${tenant.organizationId} and operation = ${operation}
    `;
    assert.equal(rows[0]?.status, "failed");
    assert.equal(rows[0]?.error, "OpenRouter returned 429.");
    assert.equal(rows[0]?.cost_usd, null);
    assert.equal(rows[0]?.returned_model, "");
  });
}
