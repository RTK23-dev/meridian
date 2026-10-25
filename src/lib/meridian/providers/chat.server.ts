// Ordinary text generation: the studio's copy and scripts, the research analysis, the brand brain's suggestions and the Factory's image
// labels. Every call is for one workspace, and it goes through the engine gateway, which is the one place a provider request is made.
// The gateway reads the workspace's own OpenRouter key through the credential resolver: a usable saved key is used alone, and an
// unusable one is never replaced by the deployment key. The deployment-only key is never used here: a call needs a workspace.
//
// The model is the workspace's choice for the task (settings/generation-models.ts). A deployment default, OPENROUTER_MODEL, serves a
// text task the workspace has not chosen for, and it is reported as the deployment's. Image understanding has no default.
//
// Before a paid call, the call is bounded from the chosen model's stated prices (generation-ledger.ts) and refused when the bound is
// above the per-call ceiling or does not fit the workspace's monthly budget. The call's budget hold is written before the request is
// sent and settled once after it, with the cost OpenRouter reports. A call whose outcome is unknown is kept as an uncertain hold and is
// never retried here.

import { z } from "zod";
import { createGateway, type Gateway } from "../../../engine/gateway/gateway.ts";
import { fetchHttpTransport } from "../../../engine/gateway/transport.ts";
import { meridianCredentialSource } from "../../../engine/gateway/meridian.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import type { Sql } from "../learning/store.ts";
import { loadDefaultSql, resolveCredential, resolveDeploymentOnlyKey } from "../credentials/resolve.ts";
import type { CredentialResolution } from "../credentials/contract.ts";
import { eligibleForTask, GENERATION_TASKS, storedGenerationModel, type GenerationTask } from "../settings/generation-models.ts";
import {
  boundGenerationCall,
  generationCeilingUsd,
  GENERATION_CEILING_ENV,
  refusedBeforeGeneration,
  reserveGenerationCall,
  settleGenerationCall,
  type ContentPart,
  type Settlement,
} from "./generation-ledger.ts";

export type { ContentPart } from "./generation-ledger.ts";

/** How long a read of the live text catalogue is reused before the next paid call checks it again. */
export const CATALOG_REUSE_MS = 60_000;

/**
 * What a non-2xx answer means, in words for the person. The meanings are OpenRouter's documented status codes. The provider's body is
 * not shown: it is untrusted, and it may echo the key.
 */
export function statusReason(status: number): string {
  switch (status) {
    case 400:
      return "OpenRouter rejected the request as invalid (400). The model or its input may not be supported.";
    case 401:
      return "OpenRouter rejected the workspace's key (401). Check or replace the OpenRouter key in Settings.";
    case 402:
      return "OpenRouter reports insufficient credits for this key (402). Add credits on OpenRouter, then try again.";
    case 403:
      return "OpenRouter refused the request for this key (403). Check the key's permissions and guardrails on OpenRouter.";
    case 404:
      return "OpenRouter does not serve this model (404). Choose another model in Settings.";
    case 408:
      return "OpenRouter timed out the request (408).";
    case 413:
      return "The request is too large for OpenRouter (413). Shorten the input.";
    case 422:
      return "OpenRouter could not process the request (422). The model or its input may not be supported.";
    case 429:
      return "OpenRouter is rate-limiting this key (429). Try again later.";
    default:
      return `OpenRouter returned an error (${status}).`;
  }
}

/** The model a task will use, decided before the call. A task with no usable model sends nothing. */
export type ModelDecision =
  | { status: "ok"; model: string; source: "workspace" | "deployment"; catalogCheckedAt: string; choice: TextModelChoice }
  | { status: "unset"; reason: string }
  | { status: "unverified"; model: string; source: "workspace" | "deployment"; reason: string };

/** Where a call's model run is recorded. The row is the call's budget hold, so it is written before the request is sent. */
export type GenerationRecord = {
  sql: Sql;
  brandId: string | null;
  correlationId: string;
  operation: string;
  promptId: string;
  promptVersion: string;
  inputRef: string;
};

export type GenerationInput = {
  system: string;
  user: string | ContentPart[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  record: GenerationRecord;
};

/**
 * The answer of one generation call. `model` is the model requested. `returnedModel` is the model OpenRouter reports it answered with.
 * A failure is `failed` when OpenRouter refused the request before generating it, `uncertain` when the call may have been billed (a
 * timeout, a server error, an unreadable reply), and `unavailable` when nothing was sent.
 */
export type GenerationResult =
  | {
      ok: true;
      content: string;
      latencyMs: number;
      tokens: number | null;
      provider: "openrouter";
      model: string;
      modelSource: "workspace" | "deployment" | "explicit";
      returnedModel: string | null;
      generationId: string | null;
      /** The cost OpenRouter reported for this call, in USD. Null when it reported none. Never an estimate. */
      costUsd: number | null;
    }
  | { ok: false; status: "unavailable" | "failed" | "uncertain"; provider: "openrouter"; error: string; model: string | null };

/** The seams a call uses. Production leaves them unset; tests pass fakes. */
export type GenerationDeps = {
  gateway?: Gateway;
  /** The stored model for a workspace's task. */
  stored?: (organizationId: string, task: GenerationTask) => Promise<string | null>;
  /** The live catalogue's text models for a workspace (null organization: the deployment's own listing). */
  catalog?: (organizationId: string) => Promise<{ status: "ok"; choices: TextModelChoice[]; takenAt: string } | { status: "unavailable"; reason: string }>;
  env?: Record<string, string | undefined>;
};

let defaultGatewayCache: Gateway | null = null;

function defaultGateway(): Gateway {
  // Built once. The credential source reads each workspace's key at the moment of each call; nothing is cached here.
  defaultGatewayCache ??= createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });
  return defaultGatewayCache;
}

const catalogCache = new Map<string, { at: number; choices: TextModelChoice[]; takenAt: string }>();

async function defaultStored(organizationId: string, task: GenerationTask): Promise<string | null> {
  return storedGenerationModel(await loadDefaultSql(), organizationId, task);
}

async function defaultCatalog(organizationId: string): Promise<{ status: "ok"; choices: TextModelChoice[]; takenAt: string } | { status: "unavailable"; reason: string }> {
  const held = catalogCache.get(organizationId);
  if (held && Date.now() - held.at < CATALOG_REUSE_MS) return { status: "ok", choices: held.choices, takenAt: held.takenAt };
  const sql: Sql = await loadDefaultSql();
  const { textModelsFor } = await import("../../../engine/orchestrator/api.ts");
  const state = await textModelsFor(sql, { organizationId, now: () => new Date().toISOString() });
  if (state.status !== "ok") return { status: "unavailable", reason: state.reason };
  const takenAt = new Date().toISOString();
  catalogCache.set(organizationId, { at: Date.now(), choices: state.models, takenAt });
  return { status: "ok", choices: state.models, takenAt };
}

/** The deployment's default text model, OPENROUTER_MODEL, or null. It serves only a text task the workspace has not chosen a model for. */
export function deploymentTextModel(env: Record<string, string | undefined> = process.env): string | null {
  return env.OPENROUTER_MODEL?.trim() || null;
}

/**
 * The model a task uses in one workspace, checked against the live catalogue. The workspace's own choice comes first. The deployment
 * default applies only when the workspace chose nothing, and never to the image task, whose inputs the default does not state.
 */
export async function generationModelFor(organizationId: string | null, task: GenerationTask, deps: GenerationDeps = {}): Promise<ModelDecision> {
  const stored = organizationId ? await (deps.stored ?? defaultStored)(organizationId, task) : null;
  let model: string;
  let source: "workspace" | "deployment";
  if (stored) {
    model = stored;
    source = "workspace";
  } else if (task === "vision") {
    return {
      status: "unset",
      reason: "Choose a model that takes images for Image understanding in Settings. The deployment default is not used for images, because its inputs are not verified.",
    };
  } else {
    const deployment = deploymentTextModel(deps.env);
    if (!deployment) {
      return { status: "unset", reason: `No model is chosen for ${GENERATION_TASKS[task].label}. Choose one in Settings, or set OPENROUTER_MODEL for the deployment.` };
    }
    model = deployment;
    source = "deployment";
  }

  if (!organizationId) {
    return { status: "unverified", model, source, reason: `No workspace is in scope, so ${model} cannot be checked against the catalogue, and nothing is sent.` };
  }
  const catalog = await (deps.catalog ?? defaultCatalog)(organizationId);
  if (catalog.status !== "ok") {
    return { status: "unverified", model, source, reason: `The live catalogue could not be read (${catalog.reason}), so ${model} cannot be checked, and nothing is sent.` };
  }
  const choice = catalog.choices.find((item) => item.id === model);
  if (!choice) {
    return { status: "unverified", model, source, reason: `${model} is not a text model with prices in the live catalogue, so nothing is sent.` };
  }
  const eligible = eligibleForTask(task, choice);
  if (!eligible.ok) return { status: "unverified", model, source, reason: `${eligible.reason} Nothing is sent.` };
  return { status: "ok", model, source, catalogCheckedAt: catalog.takenAt, choice };
}

const chatBodySchema = z.object({
  id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional() })).optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

/**
 * Records the settlement of a held call. A failure to write it is logged without the key or the reply, and the hold stays in flight:
 * it still counts against the month, so an unrecorded outcome is never treated as free.
 */
async function settleSafely(sql: Sql, holdId: string, settlement: Settlement): Promise<void> {
  try {
    await settleGenerationCall(sql, holdId, settlement);
  } catch {
    console.error(`generation: the outcome of hold ${holdId} could not be recorded; the hold stays in flight and counts against the month.`);
  }
}

/** One text-generation call with the model given. The model must already have been checked by generationModelFor. */
export async function completeWithModel(
  organizationId: string | null,
  input: GenerationInput & { model: string; modelSource?: "workspace" | "deployment" | "explicit"; choice: TextModelChoice },
  deps: GenerationDeps = {},
): Promise<GenerationResult> {
  const unavailable = (error: string): GenerationResult => ({ ok: false, status: "unavailable", provider: "openrouter", error, model: input.model });
  if (!organizationId) return unavailable("No workspace is in scope, so no budget can be held and nothing is sent.");

  const bound = boundGenerationCall({ choice: input.choice, system: input.system, user: input.user, maxTokens: input.maxTokens });
  if (!bound.ok) return unavailable(bound.reason);
  const ceiling = generationCeilingUsd(deps.env);
  if (!ceiling.ok) return unavailable(ceiling.reason);
  if (bound.usd > ceiling.usd) {
    return unavailable(`This call could cost up to $${bound.usd.toFixed(6)}, above the per-call ceiling of $${ceiling.usd.toFixed(6)} (${GENERATION_CEILING_ENV}). Nothing was sent.`);
  }

  const { sql, ...record } = input.record;
  const hold = await reserveGenerationCall(
    sql,
    {
      organizationId,
      brandId: record.brandId,
      correlationId: record.correlationId,
      operation: record.operation,
      promptId: record.promptId,
      promptVersion: record.promptVersion,
      inputRef: record.inputRef,
      provider: "openrouter",
      model: input.model,
      modelSource: input.modelSource ?? "explicit",
    },
    bound.usd,
  );
  if (hold.status === "refused") return unavailable(hold.reason);

  const gateway = deps.gateway ?? defaultGateway();
  const started = Date.now();
  const body = {
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    max_tokens: input.maxTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
  };
  const uncertainError = "OpenRouter could not be reached. The call may have been billed, so it was not retried.";
  let result;
  try {
    result = await gateway.call({
      provider: "openrouter",
      organizationId,
      method: "POST",
      path: "/chat/completions",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: input.timeoutMs ?? 25_000,
    });
  } catch {
    await settleSafely(sql, hold.id, { status: "uncertain", error: uncertainError, latencyMs: Date.now() - started });
    return { ok: false, status: "uncertain", provider: "openrouter", error: uncertainError, model: input.model };
  }
  if (result.status === "not_connected") {
    await settleSafely(sql, hold.id, { status: "failed", error: `Not sent: ${result.reason}`, latencyMs: 0 });
    return unavailable(`OpenRouter is not connected for this workspace: ${result.reason}`);
  }
  const response = result.response;
  const latencyMs = Date.now() - started;
  if (response.status < 200 || response.status >= 300) {
    const reason = statusReason(response.status);
    if (refusedBeforeGeneration(response.status)) {
      await settleSafely(sql, hold.id, { status: "failed", error: reason, latencyMs });
      return { ok: false, status: "failed", provider: "openrouter", error: reason, model: input.model };
    }
    const uncertain = `${reason} The call may have been billed, so it was not retried.`;
    await settleSafely(sql, hold.id, { status: "uncertain", error: uncertain, latencyMs });
    return { ok: false, status: "uncertain", provider: "openrouter", error: uncertain, model: input.model };
  }
  let parsed: z.infer<typeof chatBodySchema>;
  try {
    const safe = chatBodySchema.safeParse(JSON.parse(new TextDecoder().decode(response.body)));
    if (!safe.success) throw new Error("shape");
    parsed = safe.data;
  } catch {
    const error = "OpenRouter answered with an unexpected shape. The call may have been billed, so it was not retried.";
    await settleSafely(sql, hold.id, { status: "uncertain", error, latencyMs });
    return { ok: false, status: "uncertain", provider: "openrouter", error, model: input.model };
  }
  const content = parsed.choices?.[0]?.message?.content ?? "";
  const tokens = typeof parsed.usage?.total_tokens === "number" ? parsed.usage.total_tokens : null;
  const costUsd = typeof parsed.usage?.cost === "number" ? parsed.usage.cost : null;
  if (!content.trim()) {
    // The provider answered and billed the call, so the hold is settled as completed, with the failure recorded beside it.
    const error = "OpenRouter returned an empty response.";
    await settleSafely(sql, hold.id, {
      status: "completed",
      output: "",
      latencyMs,
      tokens,
      returnedModel: parsed.model ?? null,
      generationId: parsed.id ?? null,
      costUsd,
      error,
    });
    return { ok: false, status: "failed", provider: "openrouter", error, model: input.model };
  }
  await settleSafely(sql, hold.id, {
    status: "completed",
    output: content,
    latencyMs,
    tokens,
    returnedModel: parsed.model ?? null,
    generationId: parsed.id ?? null,
    costUsd,
    error: "",
  });
  return {
    ok: true,
    content,
    latencyMs,
    tokens,
    provider: "openrouter",
    model: input.model,
    modelSource: input.modelSource ?? "explicit",
    returnedModel: parsed.model ?? null,
    generationId: parsed.id ?? null,
    costUsd,
  };
}

/**
 * One task's generation for one workspace: the model is chosen and checked first, then the call is bounded, held and made with it. A
 * task with no usable model returns the reason and sends nothing.
 */
export async function completeGenerationTask(organizationId: string | null, task: GenerationTask, input: GenerationInput, deps: GenerationDeps = {}): Promise<GenerationResult> {
  const decision = await generationModelFor(organizationId, task, deps);
  if (decision.status !== "ok") {
    return {
      ok: false,
      status: "unavailable",
      provider: "openrouter",
      error: decision.reason,
      model: decision.status === "unset" ? null : decision.model,
    };
  }
  return completeWithModel(organizationId, { ...input, model: decision.model, modelSource: decision.source, choice: decision.choice }, deps);
}

/**
 * Whether a workspace's OpenRouter key is usable, from the credential resolver alone: no request is made, so this says the key is
 * present and allowed, not that the provider accepts it. A null workspace reads the deployment-only key.
 */
export async function generationCredentialStatus(organizationId: string | null): Promise<{ status: CredentialResolution["status"]; reason: string; fingerprint: string | null }> {
  if (!organizationId) {
    const resolution = resolveDeploymentOnlyKey("openrouter_chat");
    return { status: resolution.status, reason: resolution.status === "ready" ? "" : resolution.reason, fingerprint: resolution.status === "ready" ? resolution.fingerprint : null };
  }
  try {
    const resolution = await resolveCredential(await loadDefaultSql(), organizationId, "openrouter");
    return { status: resolution.status, reason: resolution.status === "ready" ? "" : resolution.reason, fingerprint: resolution.status === "ready" ? resolution.fingerprint : null };
  } catch {
    return { status: "not_configured", reason: "The OpenRouter credential could not be checked, so no request is made.", fingerprint: null };
  }
}

/** Extracts a JSON object from a model's answer, which may be fenced or wrapped in prose. Throws when there is none. */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("The model did not return JSON.");
  }
}
