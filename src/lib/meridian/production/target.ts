import { modelCapabilityRegistry, type ModelCapabilityRegistry } from "./registry.ts";

export type ProductionCapability = "VIDEO_GENERATION" | "IMAGE_GENERATION" | "EDIT" | "EXTEND";

export interface ProductionTargetRequest {
  provider: string;
  model: string;
  capability: ProductionCapability;
  aspectRatio?: string;
  durationSeconds?: number;
}

/** Rejects unregistered or incompatible provider/model pairs before contacting a provider. */
export function resolveProductionTarget(
  request: ProductionTargetRequest,
  registry: ModelCapabilityRegistry = modelCapabilityRegistry,
): { provider: string; model: string } {
  const model = registry.getModel(request.model);
  if (!model) throw new Error(`Production model '${request.model}' is not registered.`);
  if (model.provider_id !== request.provider) {
    throw new Error(`Production model '${request.model}' belongs to '${model.provider_id}', not '${request.provider}'.`);
  }

  const taskByCapability: Record<ProductionCapability, string> = {
    VIDEO_GENERATION: "text-to-video",
    IMAGE_GENERATION: "text-to-image",
    EDIT: "edit",
    EXTEND: "extend",
  };
  if (!model.supported_tasks.includes(taskByCapability[request.capability])) {
    throw new Error(`Production model '${request.model}' does not support ${request.capability}.`);
  }
  if (request.aspectRatio && !model.aspect_ratios.includes(request.aspectRatio)) {
    throw new Error(`Production model '${request.model}' does not support aspect ratio ${request.aspectRatio}.`);
  }
  if (request.durationSeconds && model.durations.length > 0 && !model.durations.includes(request.durationSeconds)) {
    throw new Error(`Production model '${request.model}' does not support ${request.durationSeconds}-second output.`);
  }

  const lifecycle = registry.checkModelLifecycle(request.model);
  if (!lifecycle.usable) throw new Error(lifecycle.warning || `Production model '${request.model}' is unavailable.`);
  return { provider: request.provider, model: request.model };
}
