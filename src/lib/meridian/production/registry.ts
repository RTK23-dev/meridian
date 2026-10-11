/**
 * Model Capability and Lifecycle Registry
 *
 * Tracks provider models, API families, lifecycle dates, and capability matrices.
 * In accordance with Section 20.3:
 * - Model availability is mutable external state.
 * - Deprecated preview endpoints with a dated shutdown are flagged or blocked once the date passes
 *   are flagged with warnings or blocked when expired.
 * - Recommends active replacements (e.g. gemini-omni-1.1-flash).
 */

export type ModelAvailabilityState = "ACTIVE" | "DEPRECATED" | "SHUTDOWN" | "PREVIEW";

export interface ModelCapabilityRecord {
  model_id: string;
  provider_id: string;
  api_family: "interactions" | "predictLongRunning" | "higgsfield_v1" | "hypit_v1" | "manual";
  release_channel: "ga" | "preview" | "experimental";
  supported_modalities: string[];
  supported_tasks: string[];
  durations: number[];
  aspect_ratios: string[];
  resolutions: string[];
  input_reference_types: string[];
  native_audio: boolean;
  editing_support: boolean;
  region_constraints: string[];
  pricing_basis: string;
  availability_state: ModelAvailabilityState;
  announced_shutdown_at?: string;
  replacement_model_id?: string;
  last_verified_at: string;
  source_url: string;
  /**
   * Set to true only when this provider/model pair is established as free of charge
   * (for example a zero-spend manual workflow or a test double). Absent means billable.
   */
  free_of_charge?: true;
}

export class ModelCapabilityRegistry {
  private models: Map<string, ModelCapabilityRecord> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    // 1. Gemini Omni (recommended primary Google video generation)
    this.register({
      model_id: "gemini-omni-1.1-flash",
      provider_id: "google_omni",
      api_family: "interactions",
      release_channel: "ga",
      supported_modalities: ["text", "image", "video"],
      supported_tasks: ["text-to-video", "image-to-video", "edit", "extend"],
      durations: [3, 4, 5, 6, 7, 8, 9, 10],
      aspect_ratios: ["9:16", "16:9", "1:1"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_uri", "video_uri"],
      native_audio: true,
      editing_support: true,
      region_constraints: ["us-central1", "global"],
      pricing_basis: "per_second",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/omni",
    });

    // 1a. Gemini Nano Banana 2.1 (Default image generation/editing)
    this.register({
      model_id: "gemini-nano-banana-2.1",
      provider_id: "google_nano_banana",
      api_family: "interactions",
      release_channel: "ga",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-image", "image-to-image", "edit"],
      durations: [],
      aspect_ratios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
      resolutions: ["1024x1024", "1536x1024", "1024x1536"],
      input_reference_types: ["image_uri", "base64"],
      native_audio: false,
      editing_support: true,
      region_constraints: ["global"],
      pricing_basis: "per_image",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/image-generation",
    });

    // 1b. Gemini 3.1 Flash Lite Image (Cost/latency-sensitive batch image work)
    this.register({
      model_id: "gemini-3.1-flash-lite-image",
      provider_id: "google_nano_banana",
      api_family: "interactions",
      release_channel: "ga",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-image"],
      durations: [],
      aspect_ratios: ["1:1", "9:16", "16:9"],
      resolutions: ["1024x1024"],
      input_reference_types: ["base64"],
      native_audio: false,
      editing_support: false,
      region_constraints: ["global"],
      pricing_basis: "per_image",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/image-generation",
    });

    // 1c. Gemini 3 Pro Image (Premium / complex art direction)
    this.register({
      model_id: "gemini-3-pro-image",
      provider_id: "google_nano_banana",
      api_family: "interactions",
      release_channel: "ga",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-image", "image-to-image", "edit"],
      durations: [],
      aspect_ratios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
      resolutions: ["1024x1024", "2048x2048"],
      input_reference_types: ["image_uri", "base64"],
      native_audio: false,
      editing_support: true,
      region_constraints: ["global"],
      pricing_basis: "per_image",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/image-generation",
    });

    // 1d. Gemini 3.1 Flash Image (Nano Banana 2)
    this.register({
      model_id: "gemini-3.1-flash-image",
      provider_id: "google_nano_banana",
      api_family: "interactions",
      release_channel: "ga",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-image", "image-to-image", "edit"],
      durations: [],
      aspect_ratios: ["1:1", "3:4", "4:3", "9:16", "16:9"],
      resolutions: ["1024x1024"],
      input_reference_types: ["image_uri", "base64"],
      native_audio: false,
      editing_support: true,
      region_constraints: ["global"],
      pricing_basis: "per_image",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/image-generation",
    });

    // 4. Higgsfield
    this.register({
      model_id: "higgsfield-video-v1",
      provider_id: "higgsfield",
      api_family: "higgsfield_v1",
      release_channel: "ga",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-video", "image-to-video"],
      durations: [5, 10, 15],
      aspect_ratios: ["9:16", "16:9"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_url"],
      native_audio: false,
      editing_support: false,
      region_constraints: ["global"],
      pricing_basis: "per_second",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://open.higgsfield.ai/quick-start",
    });

    this.register({
      model_id: "hypit-hyperframes",
      provider_id: "hypit",
      api_family: "hypit_v1",
      release_channel: "ga",
      supported_modalities: ["text", "image", "video", "audio"],
      supported_tasks: ["text-to-video", "image-to-video", "edit"],
      durations: [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 60],
      aspect_ratios: ["9:16", "16:9", "1:1", "4:5"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_uri", "video_uri"],
      native_audio: true,
      editing_support: true,
      region_constraints: ["global"],
      pricing_basis: "per_second",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "https://hypit.dev/docs",
    });

    this.register({
      model_id: "manual-cloud",
      provider_id: "manual_cloud",
      api_family: "manual",
      release_channel: "ga",
      free_of_charge: true,
      supported_modalities: ["text", "image", "video"],
      supported_tasks: ["text-to-video", "image-to-video", "edit"],
      durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 60],
      aspect_ratios: ["9:16", "16:9", "1:1", "4:5"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_uri", "video_uri"],
      native_audio: false,
      editing_support: true,
      region_constraints: ["global"],
      pricing_basis: "manual",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "internal:manual-cloud",
    });

    this.register({
      model_id: "test-video-model",
      provider_id: "test:video",
      api_family: "manual",
      release_channel: "experimental",
      free_of_charge: true,
      supported_modalities: ["text", "image", "video", "audio"],
      supported_tasks: ["text-to-video", "image-to-video", "edit"],
      durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 60],
      aspect_ratios: ["9:16", "16:9", "1:1", "4:5"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_uri", "video_uri"],
      native_audio: true,
      editing_support: true,
      region_constraints: ["test"],
      pricing_basis: "test",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "internal:test",
    });

    this.register({
      model_id: "test-image-model",
      provider_id: "test:image",
      api_family: "manual",
      release_channel: "experimental",
      free_of_charge: true,
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-image"],
      durations: [],
      aspect_ratios: ["1:1", "9:16", "16:9", "4:5"],
      resolutions: ["1024x1024"],
      input_reference_types: ["base64"],
      native_audio: false,
      editing_support: false,
      region_constraints: ["test"],
      pricing_basis: "test",
      availability_state: "ACTIVE",
      last_verified_at: "2026-10-09",
      source_url: "internal:test",
    });

  }

  register(record: ModelCapabilityRecord): void {
    this.models.set(record.model_id, record);
  }

  /** True only when the registry explicitly marks this provider/model pair free of charge. */
  isEstablishedFree(providerId: string, modelId: string): boolean {
    const model = this.models.get(modelId);
    return model !== undefined && model.provider_id === providerId && model.free_of_charge === true;
  }

  getModel(modelId: string): ModelCapabilityRecord | undefined {
    return this.models.get(modelId);
  }

  listModels(providerId?: string): ModelCapabilityRecord[] {
    const list = Array.from(this.models.values());
    if (providerId) {
      return list.filter((m) => m.provider_id === providerId);
    }
    return list;
  }

  checkModelLifecycle(modelId: string, asOfDate: Date = new Date()): {
    state: ModelAvailabilityState;
    usable: boolean;
    warning?: string;
    replacement?: string;
  } {
    const record = this.models.get(modelId);
    if (!record) {
      return {
        state: "SHUTDOWN",
        usable: false,
        warning: `Model '${modelId}' is not found in capability registry.`,
      };
    }

    if (record.announced_shutdown_at) {
      const shutdownDate = new Date(record.announced_shutdown_at);
      if (asOfDate >= shutdownDate) {
        return {
          state: "SHUTDOWN",
          usable: false,
          warning: `Model '${modelId}' reached announced shutdown date (${record.announced_shutdown_at}).`,
          replacement: record.replacement_model_id,
        };
      }
      return {
        state: "DEPRECATED",
        usable: true,
        warning: `Model '${modelId}' is DEPRECATED and will shut down on ${record.announced_shutdown_at}. Recommended replacement: ${record.replacement_model_id ?? "none"}.`,
        replacement: record.replacement_model_id,
      };
    }

    return {
      state: record.availability_state,
      usable: record.availability_state === "ACTIVE" || record.availability_state === "PREVIEW",
    };
  }

  /**
   * Resolves the active recommended model for a provider and capability.
   */
  resolve(options: {
    provider: string;
    capability: "VIDEO_GENERATION" | "IMAGE_GENERATION" | "EDIT" | "EXTEND";
    asOfDate?: Date;
  }): ModelCapabilityRecord | undefined {
    const list = this.listModels(options.provider);
    const taskMap: Record<string, string> = {
      VIDEO_GENERATION: "text-to-video",
      IMAGE_GENERATION: "text-to-image",
      EDIT: "edit",
      EXTEND: "extend",
    };
    const targetTask = taskMap[options.capability] || options.capability.toLowerCase();
    const candidate = list.find((m) => {
      const lifecycle = this.checkModelLifecycle(m.model_id, options.asOfDate);
      return lifecycle.usable && m.supported_tasks.includes(targetTask);
    });
    return candidate;
  }
}

export const modelCapabilityRegistry = new ModelCapabilityRegistry();
export const ModelRegistry = modelCapabilityRegistry;
