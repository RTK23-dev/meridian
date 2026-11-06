import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireMembership, objectInput, asText } from "../api-shared";
import {
  getWorkspaceProviderSettings,
  saveWorkspaceProviderConfig,
  removeWorkspaceProviderConfig,
  testWorkspaceProviderConnection,
  type ProviderCategory,
  type ProviderConfigSummary,
} from "./provider-config.ts";
import { getDecisionEngineStatus } from "../decisions/status.ts";
import { createDecisionEngines } from "../decisions/dispatcher.ts";
import { isDecisionEngineId } from "../decisions/types.ts";
import { saveWorkspaceEngine } from "../decisions/selection.ts";
import { OpenRouterDecisionsEngine, validateDecisionModel } from "../decisions/openrouter-engine.ts";
import { decisionModelCeilingUsd, eligibleDecisionModels } from "../decisions/decision-catalog.ts";
import { openRouterSeam } from "../decisions/test-seam.ts";
import { recordOpenRouterCheck, writeOpenRouterModel } from "../decisions/openrouter-settings.ts";
import { JevDecisionEngine } from "../decisions/jev-engine.ts";
import { isJevBackend, isJevTypesafeModel, JEV_TYPESAFE_MODELS, readJevTypesafeModel, writeJevBackend, writeJevTypesafeModel, type JevTypesafeModel } from "../decisions/jev-backend.ts";
import { resolveJevConfig } from "../jev/config.ts";
import { deploymentTextModel, generationCredentialStatus } from "../providers/chat.server.ts";
import { GENERATION_TASKS, GENERATION_TASK_IDS, eligibleForTask, isGenerationTask, saveGenerationModel, storedGenerationModels } from "./generation-models.ts";
import { MODEL_PRESETS, imageCallFitsCeiling, isModelPreset, presetChoices } from "./model-presets.ts";
import { MEDIA_TASKS, eligibleForMediaTask, isMediaTask, saveMediaModel, storedMediaModels, type MediaModelChoice, type MediaTask } from "./media-models.ts";

/**
 * The models a Studio seat can choose from, for one workspace: image models from the live catalogue's image listing (per-image price),
 * video models from OpenRouter's video listing (per-second price at the resolution a Studio job asks for).
 */
async function mediaChoicesFor(sql: Awaited<ReturnType<typeof getSql>>, organizationId: string, task: MediaTask): Promise<{ ok: true; models: MediaModelChoice[] } | { ok: false; reason: string }> {
  if (MEDIA_TASKS[task].kind === "video") {
    const { studioVideoModels } = await import("../production/openrouter-video.ts");
    const listed = await studioVideoModels(organizationId);
    if (!listed.ok) return listed;
    return { ok: true, models: listed.models.map((model) => ({ id: model.id, name: model.name, kind: "video" as const, imageUsd: null, usdPerSecond: model.usdPerSecond })) };
  }
  const { mediaModelsFor } = await import("../../../engine/orchestrator/api.ts");
  const state = await mediaModelsFor(sql, { organizationId, now: () => new Date().toISOString() });
  if (state.status !== "ok") return { ok: false, reason: state.reason };
  // The listing's per-image field prices an image sent in, not one made, so no per-image price is carried for a Studio image seat.
  return { ok: true, models: state.models.filter((model) => model.kind === "image").map((model) => ({ id: model.id, name: model.name, kind: "image" as const, imageUsd: null, usdPerSecond: null })) };
}
import { generationCeilingUsd } from "../providers/generation-ledger.ts";
import { textModelsFor } from "../../../engine/orchestrator/api.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";

export const getProviderSettings = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<Record<ProviderCategory, ProviderConfigSummary>> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    return getWorkspaceProviderSettings(sql, data.organizationId);
  });

export const saveProviderConfig = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const category = asText(obj.category) as ProviderCategory;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!category) throw new Error("category is required.");
    const credentials = obj.credentials ? (obj.credentials as Record<string, string>) : undefined;
    const settings = obj.settings ? (obj.settings as Record<string, any>) : undefined;
    return { organizationId, category, credentials, settings };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");

    return saveWorkspaceProviderConfig(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      category: data.category,
      credentials: data.credentials,
      settings: data.settings,
    });
  });

export const removeProviderConfig = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const category = asText(obj.category) as ProviderCategory;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!category) throw new Error("category is required.");
    return { organizationId, category };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");

    return removeWorkspaceProviderConfig(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      category: data.category,
    });
  });

export const testProviderConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const category = asText(obj.category) as ProviderCategory;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!category) throw new Error("category is required.");
    return { organizationId, category };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");

    return testWorkspaceProviderConnection(sql, {
      organizationId: data.organizationId,
      category: data.category,
    });
  });

/** Which decision engine is active for this workspace, and whether each engine is configured. No secrets are returned. */
export const getDecisionEngines = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    return getDecisionEngineStatus(sql, data.organizationId);
  });

/**
 * The decision models this workspace may choose from: the live catalogue's decision entries that have a verified profile, with what
 * each takes, its price and the most one call can cost. The models not offered are listed with the reason. A catalogue that cannot
 * be read offers nothing, and says so.
 */
export const getOpenRouterDecisionModels = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const catalog = await openRouterSeam().catalog.read();
    if (!catalog.ok) return { ok: false as const, reason: catalog.reason, endpoint: catalog.endpoint, readAt: catalog.readAt, eligible: [], notOffered: [] };
    const { eligible, notOffered } = eligibleDecisionModels(catalog);
    return {
      ok: true as const,
      endpoint: catalog.endpoint,
      readAt: catalog.readAt,
      eligible: eligible.map((model) => ({
        id: model.id,
        name: model.name,
        canonicalSlug: model.canonicalSlug,
        verified: model.verified,
        takes: model.profile.inputModalities,
        catalogueInputModalities: model.inputModalities,
        questionKinds: model.profile.questionKinds,
        contextLength: model.contextLength,
        promptUsdPerMillionTokens: model.promptUsdPerToken * 1_000_000,
        callCeilingUsd: decisionModelCeilingUsd(model),
        created: model.created,
      })),
      notOffered,
    };
  });

/** Switches the active decision engine. Refused unless the target engine is configured; the previous choice is kept. */
export const saveDecisionEngine = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const engineId = asText(obj.engineId);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!engineId) throw new Error("engineId is required.");
    return { organizationId, engineId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    if (!isDecisionEngineId(data.engineId)) {
      return { ok: false as const, reason: `'${data.engineId}' is not a decision engine.` };
    }
    const target = createDecisionEngines()[data.engineId];
    // The engine is checked for this workspace, so its own saved key is the one that decides READY.
    const health = target.healthFor ? await target.healthFor(data.organizationId) : await target.health();
    const result = await saveWorkspaceEngine(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      engineId: data.engineId,
      targetHealth: health,
    });
    return result.ok
      ? { ok: true as const, engineId: result.engineId }
      : { ok: false as const, reason: result.reason, activeEngineId: result.previous.engineId };
  });

/**
 * Saves the workspace's OpenRouter decision model. It must be a pinned, verified decision model. Saving it changes no active
 * engine, and it does not count as a passed connection: the connection test is what makes the engine READY.
 */
export const saveOpenRouterDecisionModel = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const model = asText(obj.model);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!model) throw new Error("model is required.");
    return { organizationId, model };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const checked = validateDecisionModel(data.model);
    if (!checked.ok) return { ok: false as const, reason: checked.reason };
    // The model must be in the live catalogue and have a verified profile. The catalogue is read here, so a model cannot be saved by typing its ID.
    const catalog = await openRouterSeam().catalog.read();
    if (!catalog.ok) return { ok: false as const, reason: `${catalog.reason} The decision model is unchanged.` };
    if (!eligibleDecisionModels(catalog).eligible.some((model) => model.id === checked.model)) {
      return { ok: false as const, reason: `${checked.model} is not offered: it is not a decision model in the live catalogue with a verified profile. The decision model is unchanged.` };
    }
    await writeOpenRouterModel(sql, { organizationId: data.organizationId, actorId: context.userId, model: checked.model });
    const health = await new OpenRouterDecisionsEngine(openRouterSeam()).healthFor(data.organizationId);
    return { ok: true as const, model: checked.model, health };
  });

/**
 * An explicit connection test for the OpenRouter decision engine. It sends one real request, which may incur model usage, and it
 * records the outcome. It changes no product data and no active engine. The result only says whether the provider answered.
 */
export const testOpenRouterDecisionConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const engine = new OpenRouterDecisionsEngine(openRouterSeam());
    const outcome = await engine.connectionCheck(data.organizationId);
    if (outcome.kind === "not_run") {
      return { ok: false as const, status: "NOT_RUN" as const, message: outcome.message, health: await engine.healthFor(data.organizationId) };
    }
    await recordOpenRouterCheck(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      check: {
        status: outcome.status,
        model: outcome.model,
        keyFingerprint: outcome.keyFingerprint,
        message: outcome.message,
        returnedModel: outcome.returnedModel,
        upstreamProvider: outcome.upstreamProvider,
        providerRequestId: outcome.providerRequestId,
      },
    });
    return {
      ok: outcome.status === "passed",
      status: outcome.status === "passed" ? ("PASSED" as const) : ("FAILED" as const),
      message: outcome.message,
      health: await engine.healthFor(data.organizationId),
    };
  });

/**
 * Chooses the backend JEV decisions use for this workspace: TypeSafe or OpenRouter. The chosen backend must report READY first,
 * and the stored choice is kept if it does not. Only the backend is stored. The model comes from that backend's own settings.
 */
export const saveJevBackend = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const backend = asText(obj.backend);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!backend) throw new Error("backend is required.");
    return { organizationId, backend };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    if (!isJevBackend(data.backend)) {
      return { ok: false as const, reason: `'${data.backend}' is not a JEV backend. Choose TypeSafe or OpenRouter.` };
    }
    const target = await new JevDecisionEngine().healthForBackend(data.organizationId, data.backend);
    if (target.status !== "READY") return { ok: false as const, reason: `${target.message} The JEV backend is unchanged.` };
    await writeJevBackend(sql, { organizationId: data.organizationId, actorId: context.userId, backend: data.backend });
    return { ok: true as const, backend: data.backend };
  });

/** The workspace's TypeSafe model for direct TypeSafe decisions, and the models it can choose. Any member may read it. */
export const getJevTypesafeModel = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const organizationId = asText(objectInput(input).organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const stored = await readJevTypesafeModel(sql, data.organizationId);
    return { stored, deploymentDefault: resolveJevConfig().typesafe.model, choices: [...JEV_TYPESAFE_MODELS] };
  });

/** Saves the TypeSafe model for this workspace, or clears it (an empty value) so the deployment's model applies. Admin only. */
export const saveJevTypesafeModel = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId, model: asText(obj.model) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    if (data.model !== "" && !isJevTypesafeModel(data.model)) {
      return { ok: false as const, reason: `'${data.model}' is not a TypeSafe model Meridian has verified. Choose ${JEV_TYPESAFE_MODELS.join(" or ")}.` };
    }
    await writeJevTypesafeModel(sql, { organizationId: data.organizationId, actorId: context.userId, model: data.model === "" ? null : (data.model as JevTypesafeModel) });
    return { ok: true as const, model: data.model === "" ? null : data.model };
  });

/**
 * Each text-generation task's model in this workspace: the model the workspace chose, or, for a text task it has not chosen for, the
 * deployment default. It also says whether OpenRouter is connected for the workspace. It reads no catalogue and sends nothing.
 */
export const getGenerationModels = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const stored = await storedGenerationModels(sql, data.organizationId);
    const media = await storedMediaModels(sql, data.organizationId);
    const deployment = deploymentTextModel();
    const credential = await generationCredentialStatus(data.organizationId);
    return {
      // The Studio's model seats that have a model, so Connections can say which Studio features OpenRouter serves (no catalogue read).
      mediaChosen: Object.keys(media),
      connected: credential.status === "ready",
      connectionReason: credential.status === "ready" ? null : credential.reason,
      tasks: GENERATION_TASK_IDS.map((task) => {
        const saved = stored[task] ?? null;
        return {
          task,
          label: GENERATION_TASKS[task].label,
          description: GENERATION_TASKS[task].description,
          needsImage: GENERATION_TASKS[task].needsImage,
          saved,
          // The deployment default serves a text task only, and only while the workspace has chosen nothing for it. A task with its own
          // Auto (direction's seats) uses that instead.
          deploymentDefault: saved === null && !GENERATION_TASKS[task].needsImage && GENERATION_TASKS[task].auto === null ? deployment : null,
          auto: GENERATION_TASKS[task].auto,
        };
      }),
    };
  });

/**
 * The live OpenRouter catalogue's text models with stated prices, read now, and the tasks each one suits. A catalogue that cannot be
 * read offers no model, and says why. Decision models are not in this list: a decision model is never a text model.
 */
export const getGenerationCatalogue = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const state = await textModelsFor(sql, { organizationId: data.organizationId, now: () => new Date().toISOString() });
    if (state.status !== "ok") return { ok: false as const, reason: state.reason, readAt: null, models: [] };
    return {
      ok: true as const,
      reason: null,
      readAt: new Date().toISOString(),
      models: state.models.map((model) => ({
        id: model.id,
        name: model.name,
        takes: model.inputModalities,
        promptUsdPerMillionTokens: model.promptUsdPerToken * 1_000_000,
        completionUsdPerMillionTokens: model.completionUsdPerToken * 1_000_000,
        suitsTasks: GENERATION_TASK_IDS.filter((task) => eligibleForTask(task, model).ok),
      })),
    };
  });

/**
 * Saves or clears one task's model. A model is saved only when the live catalogue lists it now as a text model that suits the task, and
 * the catalogue is read again here, not taken from the page. Clearing needs no catalogue. The stored choice is unchanged on any refusal.
 */
export const saveGenerationModelChoice = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const task = asText(obj.task);
    const modelId = obj.modelId === null || obj.modelId === undefined ? null : asText(obj.modelId).trim() || null;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!isGenerationTask(task)) throw new Error(`'${task}' is not a generation task.`);
    return { organizationId, task, modelId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    let choices: TextModelChoice[] | null = null;
    if (data.modelId !== null) {
      const state = await textModelsFor(sql, { organizationId: data.organizationId, now: () => new Date().toISOString() });
      if (state.status !== "ok") return { ok: false as const, reason: `${state.reason} The model is unchanged.` };
      choices = state.models;
    }
    try {
      const result = await saveGenerationModel(sql, {
        organizationId: data.organizationId,
        task: data.task,
        modelId: data.modelId,
        actorId: context.userId,
        choices,
      });
      return result.status === "saved"
        ? { ok: true as const, status: "saved" as const, modelId: result.modelId }
        : { ok: true as const, status: "cleared" as const, modelId: null };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : "The model could not be saved." };
    }
  });

/**
 * Applies a model preset: every writing task's model, picked from the live OpenRouter catalogue as it is now (model-presets.ts), and
 * saved through the same checked path as one task's choice. A task the preset leaves on Auto is cleared. Admin only. When the catalogue
 * cannot be read, nothing changes.
 */
export const applyModelPreset = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const preset = asText(obj.preset);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!isModelPreset(preset)) throw new Error(`'${preset}' is not a model preset.`);
    return { organizationId, preset };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const state = await textModelsFor(sql, { organizationId: data.organizationId, now: () => new Date().toISOString() });
    if (state.status !== "ok") return { ok: false as const, reason: `${state.reason} No model was changed.`, applied: [] };
    // An image task's call is bounded at the model's whole context (the listing states no image tokens), so a model whose bound is above
    // the per-call ceiling would be refused on every call. Such a model does not suit an image task here.
    const ceiling = generationCeilingUsd();
    const imageCallFits = (model: TextModelChoice) => ceiling.ok && imageCallFitsCeiling(model, ceiling.usd);
    const catalogue = state.models.map((model) => ({
      id: model.id,
      name: model.name,
      promptUsdPerMillionTokens: model.promptUsdPerToken * 1_000_000,
      completionUsdPerMillionTokens: model.completionUsdPerToken * 1_000_000,
      created: model.created ?? null,
      suitsTasks: GENERATION_TASK_IDS.filter((task) => eligibleForTask(task, model).ok && (!GENERATION_TASKS[task].needsImage || imageCallFits(model))),
    }));
    const applied: Array<{ task: string; label: string; modelId: string | null; reason: string; saved: boolean }> = [];
    for (const choice of presetChoices(data.preset, catalogue)) {
      try {
        await saveGenerationModel(sql, { organizationId: data.organizationId, task: choice.task, modelId: choice.modelId, actorId: context.userId, choices: state.models });
        applied.push({ task: choice.task, label: GENERATION_TASKS[choice.task].label, modelId: choice.modelId, reason: choice.reason, saved: true });
      } catch (error) {
        applied.push({ task: choice.task, label: GENERATION_TASKS[choice.task].label, modelId: null, reason: error instanceof Error ? error.message : "Not saved.", saved: false });
      }
    }
    return { ok: true as const, preset: data.preset, label: MODEL_PRESETS[data.preset].label, applied };
  });

/** The Studio model seats that are wired to a provider. A seat is shown only once something uses it. */
export const WIRED_MEDIA_TASKS: readonly MediaTask[] = ["studio_image", "studio_video"];

/**
 * The Studio's image and video model seats: each seat's saved model, and the live catalogue's models of its kind with their stated prices.
 * A catalogue that cannot be read offers no model, and says why.
 */
export const getMediaModels = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const stored = await storedMediaModels(sql, data.organizationId);
    const seats = [];
    for (const task of WIRED_MEDIA_TASKS) {
      const choices = await mediaChoicesFor(sql, data.organizationId, task);
      seats.push({
        task,
        label: MEDIA_TASKS[task].label,
        description: MEDIA_TASKS[task].description,
        kind: MEDIA_TASKS[task].kind,
        saved: stored[task] ?? null,
        unavailable: choices.ok ? null : choices.reason,
        models: choices.ok ? choices.models.filter((model) => eligibleForMediaTask(task, model).ok) : [],
      });
    }
    return { seats };
  });

/** Saves or clears one Studio model seat. The model is checked against the live catalogue first; admin only. */
export const saveMediaModelChoice = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const task = asText(obj.task);
    const modelId = obj.modelId === null ? null : asText(obj.modelId);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!isMediaTask(task) || !WIRED_MEDIA_TASKS.includes(task)) throw new Error(`'${task}' is not a Studio model seat.`);
    return { organizationId, task, modelId: modelId || null };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    let choices: MediaModelChoice[] | null = null;
    if (data.modelId !== null) {
      const read = await mediaChoicesFor(sql, data.organizationId, data.task);
      choices = read.ok ? read.models : null;
    }
    try {
      const result = await saveMediaModel(sql, { organizationId: data.organizationId, task: data.task, modelId: data.modelId, actorId: context.userId, choices });
      return { ok: true as const, result };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : "The model could not be saved." };
    }
  });
