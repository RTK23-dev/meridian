// Ordinary text generation: the studio's copy and scripts, the research analysis, the brand brain's suggestions and the Factory's image
// labels. Every call is for one workspace (or, with none, for the deployment itself), and it goes through the engine gateway, which is
// the one place a provider request is made. The gateway reads the workspace's own OpenRouter key through the credential resolver: a
// usable saved key is used alone, an unusable one is never replaced by the deployment key, and the deployment key is used only with
// OPENROUTER_SHARED_DEFAULT=deployment.
//
// The model is the workspace's choice for the task (settings/generation-models.ts). A deployment default, OPENROUTER_MODEL, is used only
// when the workspace has chosen nothing, and it is reported as the deployment's default. Before any paid request, the model is checked
// against the live catalogue: a model the catalogue does not list as a text model for the task is refused, and nothing is sent. A
// decision model is never a text model, so it cannot be used here.

import { z } from "zod";
import { createGateway, type Gateway } from "../../../engine/gateway/gateway.ts";
import { fetchHttpTransport } from "../../../engine/gateway/transport.ts";
import { meridianCredentialSource } from "../../../engine/gateway/meridian.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import type { Sql } from "../learning/store.ts";
import { loadDefaultSql, resolveCredential, resolveDeploymentOnlyKey } from "../credentials/resolve.ts";
import type { CredentialResolution } from "../credentials/contract.ts";
import { eligibleForTask, GENERATION_TASKS, storedGenerationModel, type GenerationTask } from "../settings/generation-models.ts";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** How long a read of the live text catalogue is reused before the next paid call checks it again. */
export const CATALOG_REUSE_MS = 60_000;

/** The model a task will use, decided before the call. A task with no usable model sends nothing. */
export type ModelDecision =
  | { status: "ok"; model: string; source: "workspace" | "deployment"; catalogCheckedAt: string }
  | { status: "unset"; reason: string }
  | { status: "unverified"; model: string; source: "workspace" | "deployment"; reason: string };

export type GenerationInput = {
  system: string;
  user: string | ContentPart[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
};

/** The answer of one generation call. `model` is the model requested; `returnedModel` is the model OpenRouter reports it answered with. */
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
  | { ok: false; status: "unavailable" | "failed"; provider: "openrouter"; error: string; model: string | null };

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
    const deployment = (deps.env ?? process.env).OPENROUTER_MODEL?.trim() ?? "";
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
  return { status: "ok", model, source, catalogCheckedAt: catalog.takenAt };
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
 * One text-generation call with the model given. The model must already have been checked by generationModelFor. A call is made only
 * with a usable key for the workspace (the gateway resolves it); without one, the answer says why and nothing is sent. The key is never
 * part of the answer or of any error.
 */
export async function completeWithModel(
  organizationId: string | null,
  input: GenerationInput & { model: string; modelSource?: "workspace" | "deployment" | "explicit" },
  deps: GenerationDeps = {},
): Promise<GenerationResult> {
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
    return { ok: false, status: "failed", provider: "openrouter", error: "OpenRouter could not be reached.", model: input.model };
  }
  if (result.status === "not_connected") {
    return { ok: false, status: "unavailable", provider: "openrouter", error: `OpenRouter is not connected for this workspace: ${result.reason}`, model: input.model };
  }
  const response = result.response;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: "failed", provider: "openrouter", error: `OpenRouter returned ${response.status}.`, model: input.model };
  }
  let parsed: z.infer<typeof chatBodySchema>;
  try {
    const safe = chatBodySchema.safeParse(JSON.parse(new TextDecoder().decode(response.body)));
    if (!safe.success) throw new Error("shape");
    parsed = safe.data;
  } catch {
    return { ok: false, status: "failed", provider: "openrouter", error: "OpenRouter answered with an unexpected shape.", model: input.model };
  }
  const content = parsed.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) {
    return { ok: false, status: "failed", provider: "openrouter", error: "OpenRouter returned an empty response.", model: input.model };
  }
  return {
    ok: true,
    content,
    latencyMs: Date.now() - started,
    tokens: typeof parsed.usage?.total_tokens === "number" ? parsed.usage.total_tokens : null,
    provider: "openrouter",
    model: input.model,
    modelSource: input.modelSource ?? "explicit",
    returnedModel: parsed.model ?? null,
    generationId: parsed.id ?? null,
    costUsd: typeof parsed.usage?.cost === "number" ? parsed.usage.cost : null,
  };
}

/**
 * One task's generation for one workspace: the model is chosen and checked first, then the call is made with it. A task with no usable
 * model returns the reason and sends nothing.
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
  return completeWithModel(organizationId, { ...input, model: decision.model, modelSource: decision.source }, deps);
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
