/**
 * Model Capability and Lifecycle Registry
 *
 * Tracks provider models, API families, lifecycle dates, and capability matrices.
 * In accordance with Section 20.3:
 * - Model availability is mutable external state.
 * - Deprecated preview endpoints (e.g. veo-3.1-generate-preview with 2026-10-22 shutdown)
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
      durations: [5, 10, 15, 30],
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

    // 2. Veo 3.1 Preview (deprecated, shutting down 2026-10-22)
    this.register({
      model_id: "veo-3.1-generate-preview",
      provider_id: "veo",
      api_family: "predictLongRunning",
      release_channel: "preview",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-video", "image-to-video"],
      durations: [5, 8],
      aspect_ratios: ["9:16", "16:9"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_uri"],
      native_audio: false,
      editing_support: false,
      region_constraints: ["us-central1"],
      pricing_basis: "per_job",
      availability_state: "DEPRECATED",
      announced_shutdown_at: "2026-10-22T00:00:00Z",
      replacement_model_id: "gemini-omni-1.1-flash",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/deprecations/",
    });

    // 3. Veo 2.0 (Shut down on 2026-06-30 per Google deprecations schedule)
    this.register({
      model_id: "veo-2.0-generate-001",
      provider_id: "veo",
      api_family: "predictLongRunning",
      release_channel: "ga",
      supported_modalities: ["text", "image"],
      supported_tasks: ["text-to-video", "image-to-video"],
      durations: [5, 8],
      aspect_ratios: ["9:16", "16:9"],
      resolutions: ["720p", "1080p"],
      input_reference_types: ["image_uri"],
      native_audio: false,
      editing_support: false,
      region_constraints: ["us-central1"],
      pricing_basis: "per_job",
      availability_state: "SHUTDOWN",
      announced_shutdown_at: "2026-06-30T00:00:00Z",
      replacement_model_id: "gemini-omni-1.1-flash",
      last_verified_at: "2026-10-09",
      source_url: "https://ai.google.dev/gemini-api/docs/deprecations/",
    });

    // 4. Higgsfield
    this.register({
      model_id: "higgsfield-standard",
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
  }

  register(record: ModelCapabilityRecord): void {
    this.models.set(record.model_id, record);
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
}

export const modelCapabilityRegistry = new ModelCapabilityRegistry();
