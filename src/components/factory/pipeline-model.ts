/**
 * Pure model for the factory pipeline editor. No React and no server calls.
 *
 * Every fact here comes from the factory modules (pipeline-config.ts, pipeline.ts) or from the settings summary the factory
 * route already reads. Nothing claims that a saved setting is applied: no factory job reads the saved pipeline config, so the
 * copy in this file says "not applied" wherever that is true.
 */

import {
  DEFAULT_GENERATION_PARAMS,
  DEFAULT_GRADING_THRESHOLDS,
  DEFAULT_PROMPTS,
  PIPELINE_PRESETS,
  getDefaultPipelineConfig,
  getPresetConfig,
  validatePipelineConfig,
  type FactoryComponentId,
  type FactoryPipelineConfig,
  type PipelineGenerationParams,
  type PipelinePrompts,
  type StageCategory,
} from "@/lib/meridian/factory/pipeline-config";
import {
  FACTORY_GRAPH,
  factoryStageAllowed,
  minimumLevel,
  type FactoryStage,
  type FactoryStageSpec,
} from "@/lib/meridian/factory/pipeline";

export type EditorTab = "flow" | "volume" | "grading" | "prompts";
export type PromptKey = keyof PipelinePrompts;
export type GradingKey = "winnerScoreMin" | "pBeatMin" | "retention3sMin" | "confidenceMin";
export type NumericRange = { min: number; max: number };

/**
 * The limits are read from the server validator by feeding it values far outside them. The validator clamps, so the
 * result is the real limit. Nothing is copied by hand, so a limit change on the server shows up here.
 */
function probeRange(
  build: (value: number) => Partial<FactoryPipelineConfig>,
  read: (config: FactoryPipelineConfig) => number,
): NumericRange {
  return {
    min: read(validatePipelineConfig(build(-1_000_000))),
    max: read(validatePipelineConfig(build(1_000_000))),
  };
}

export const GRADING_RANGES: Record<GradingKey, NumericRange> = {
  winnerScoreMin: probeRange(
    (value) => ({ gradingThresholds: { ...DEFAULT_GRADING_THRESHOLDS, winnerScoreMin: value } }),
    (config) => config.gradingThresholds.winnerScoreMin,
  ),
  pBeatMin: probeRange(
    (value) => ({ gradingThresholds: { ...DEFAULT_GRADING_THRESHOLDS, pBeatMin: value } }),
    (config) => config.gradingThresholds.pBeatMin,
  ),
  retention3sMin: probeRange(
    (value) => ({ gradingThresholds: { ...DEFAULT_GRADING_THRESHOLDS, retention3sMin: value } }),
    (config) => config.gradingThresholds.retention3sMin,
  ),
  confidenceMin: probeRange(
    (value) => ({ gradingThresholds: { ...DEFAULT_GRADING_THRESHOLDS, confidenceMin: value } }),
    (config) => config.gradingThresholds.confidenceMin,
  ),
};

export const VIDEO_COUNT_RANGE = probeRange(
  (value) => ({ generationParams: { ...DEFAULT_GENERATION_PARAMS, videoCount: value } }),
  (config) => config.generationParams.videoCount,
);
export const DURATION_RANGE = probeRange(
  (value) => ({ generationParams: { ...DEFAULT_GENERATION_PARAMS, durationSeconds: value } }),
  (config) => config.generationParams.durationSeconds,
);
export const DAILY_CAP_RANGE = probeRange(
  (value) => ({ generationParams: { ...DEFAULT_GENERATION_PARAMS, dailyGenerationCap: value } }),
  (config) => config.generationParams.dailyGenerationCap,
);

/** The validator cuts longer prompts without saying so, so the editor stops at the same length. */
export const PROMPT_MAX_LENGTH = validatePipelineConfig({
  prompts: { ...DEFAULT_PROMPTS, briefPrompt: "x".repeat(5_000) },
}).prompts.briefPrompt.length;

export const toPercent = (fraction: number): number => Math.round(fraction * 100);
export const fromPercent = (percent: number): number => percent / 100;
export const formatPercent = (fraction: number): string => `${toPercent(fraction)}%`;

// ---------------------------------------------------------------------------------------------------------------------
// Stages and factory jobs
// ---------------------------------------------------------------------------------------------------------------------

export const CATEGORY_LABEL: Record<StageCategory, string> = {
  input: "Input",
  intelligence: "Intelligence",
  creative: "Creative",
  production: "Production",
  qc: "Quality control",
};

/** The factory job that runs each configured stage. Stages with no entry have no job in the factory graph. */
export const STAGE_JOB: Partial<Record<FactoryComponentId, FactoryStage>> = {
  discover: "factory.discover",
  decode: "factory.decode",
  grade: "factory.grade",
  produce: "factory.produce",
  gate: "factory.gate",
  review: "factory.review",
  launch: "factory.launch",
};

export function jobForStage(stageId: FactoryComponentId): FactoryStageSpec | null {
  const type = STAGE_JOB[stageId];
  return type ? FACTORY_GRAPH.find((job) => job.type === type) ?? null : null;
}

/** Factory jobs that no stage card represents. They still run. */
export function jobsWithoutStage(): FactoryStageSpec[] {
  const mapped = new Set<FactoryStage>(Object.values(STAGE_JOB).filter((type): type is FactoryStage => Boolean(type)));
  return FACTORY_GRAPH.filter((job) => !mapped.has(job.type));
}

export type StageRun =
  | { kind: "no_job" }
  | { kind: "queued"; job: FactoryStageSpec; minLevel: number }
  | { kind: "not_queued"; job: FactoryStageSpec; minLevel: number };

/**
 * Whether a run started at this autopilot level queues the stage's job. This is the only skip the server applies: a job is
 * left out when the run's level is below the job's minimum. A per-stage bypass switch would not change any run.
 */
export function stageRun(stageId: FactoryComponentId, level: number): StageRun {
  const job = jobForStage(stageId);
  if (!job) return { kind: "no_job" };
  const minLevel = minimumLevel(job.type);
  return factoryStageAllowed(level, job.type)
    ? { kind: "queued", job, minLevel }
    : { kind: "not_queued", job, minLevel };
}

/** The saved settings that feed each stage. Names only: values are shown on their own tab. */
export const STAGE_SETTINGS: Record<FactoryComponentId, { label: string; tab: EditorTab }[]> = {
  discover: [],
  decode: [{ label: "Multimodal perception prompt", tab: "prompts" }],
  grade: [
    { label: "Minimum winner score", tab: "grading" },
    { label: "Bayesian P(beat) confidence", tab: "grading" },
    { label: "3 s retention floor", tab: "grading" },
    { label: "Perceptual confidence floor", tab: "grading" },
  ],
  brief: [{ label: "Brief synthesis prompt", tab: "prompts" }],
  script: [{ label: "Scriptwriting prompt", tab: "prompts" }],
  produce: [
    { label: "Videos per concept", tab: "volume" },
    { label: "Aspect ratio", tab: "volume" },
    { label: "Duration", tab: "volume" },
    { label: "Cut pacing", tab: "volume" },
    { label: "Render engine", tab: "volume" },
    { label: "Daily generation cap", tab: "volume" },
  ],
  gate: [{ label: "Strict claim gate", tab: "grading" }],
  review: [{ label: "Auto-approve switch", tab: "grading" }],
  launch: [],
};

export const STAGE_NOTE: Partial<Record<FactoryComponentId, string>> = {
  discover: "Sources and their connection state are shown on the Discover tab of this page.",
  launch: "The spend caps on the Live tests tab are the caps this job reads.",
};

// ---------------------------------------------------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------------------------------------------------

export type EngineId = PipelineGenerationParams["provider"];
export const ENGINE_IDS: readonly EngineId[] = ["manual_cloud", "hypit", "veo", "higgsfield"];

export const ENGINE_LABEL: Record<EngineId, string> = {
  manual_cloud: "Manual Cloud",
  hypit: "Hypit",
  veo: "Google Veo",
  higgsfield: "Higgsfield",
};

const ENGINE_DESCRIPTION: Record<EngineId, string> = {
  manual_cloud: "You render outside Meridian and drop the files in Google Drive.",
  hypit: "Hypit timeline video engine.",
  veo: "Google video model, run with the workspace Gemini key.",
  higgsfield: "Video model run through the Higgsfield API.",
};

export type EngineState = "configured" | "not_connected" | "not_verified" | "checking";

export type EngineRow = {
  id: EngineId;
  label: string;
  description: string;
  state: EngineState;
  stateLabel: string;
  /** Why the state is what it is. Server text where the server gives one. */
  detail: string;
  /** Only a configured engine can be chosen. */
  selectable: boolean;
};

/**
 * What the screen read from the server. `hypit` is the factory board's video status. `settings` is the workspace provider
 * summary, which carries the Gemini production key and the Google Drive setting.
 */
export type EngineSources = {
  hypit: { status: string; detail: string };
  settings: {
    state: "loading" | "error" | "ready";
    production?: { configured: boolean; credentialState?: string; credentialReason?: string };
    storage?: { configured: boolean };
  };
};

const STATE_LABEL: Record<EngineState, string> = {
  configured: "Configured",
  not_connected: "Not connected",
  not_verified: "Not verified here",
  checking: "Checking",
};

function engineRow(id: EngineId, state: EngineState, detail: string): EngineRow {
  return {
    id,
    label: ENGINE_LABEL[id],
    description: ENGINE_DESCRIPTION[id],
    state,
    stateLabel: STATE_LABEL[state],
    detail,
    selectable: state === "configured",
  };
}

/**
 * Connection state per engine, from what the server reports. An engine is "configured" only when a server status says so.
 * When this screen has no server status for an engine, the state is "not verified here" and the engine cannot be chosen.
 */
export function engineRows(sources: EngineSources): EngineRow[] {
  const { hypit, settings } = sources;
  const hypitRow = hypit.status === "CONFIGURED"
    ? engineRow("hypit", "configured", hypit.detail)
    : engineRow("hypit", "not_connected", hypit.detail || "Hypit is not configured.");

  let manualCloud: EngineRow;
  if (settings.state === "loading") {
    manualCloud = engineRow("manual_cloud", "checking", "Checking Google Drive.");
  } else if (settings.state === "error" || !settings.storage) {
    manualCloud = engineRow("manual_cloud", "not_verified", "The Google Drive status could not be read on this screen.");
  } else if (settings.storage.configured) {
    manualCloud = engineRow("manual_cloud", "configured", "Google Drive credentials are set. The drop folder is checked when a job is submitted.");
  } else {
    manualCloud = engineRow("manual_cloud", "not_connected", "Google Drive is not connected, so manual drops have nowhere to go.");
  }

  let veo: EngineRow;
  const production = settings.production;
  if (settings.state === "loading") {
    veo = engineRow("veo", "checking", "Checking the workspace Gemini key.");
  } else if (settings.state === "error" || !production) {
    veo = engineRow("veo", "not_verified", "The production key status could not be read on this screen.");
  } else if (production.credentialState === "usable") {
    veo = engineRow("veo", "not_verified", "The Gemini key is usable for this workspace. This screen cannot check the Veo model, so Veo is not shown as connected.");
  } else if (production.credentialState === undefined) {
    veo = engineRow("veo", "not_verified", "The production key status is not reported on this screen.");
  } else {
    veo = engineRow("veo", "not_connected", production.credentialReason || "No usable Gemini production key is saved for this workspace.");
  }

  const higgsfield = engineRow("higgsfield", "not_verified", "No server status for Higgsfield is available on this screen, so it is not shown as connected.");

  return [manualCloud, hypitRow, veo, higgsfield];
}

// ---------------------------------------------------------------------------------------------------------------------
// Grading, volume and prompts: labels and the reason each value is not read
// ---------------------------------------------------------------------------------------------------------------------

export const PACING_LABEL: Record<PipelineGenerationParams["renderPacing"], string> = {
  hyper_fast: "Hyper-fast",
  dynamic: "Dynamic",
  steady: "Steady",
  cinematic: "Cinematic",
};

export const PACING_DETAIL: Record<PipelineGenerationParams["renderPacing"], string> = {
  hyper_fast: "Target cuts under 1 s.",
  dynamic: "Target cuts of about 1.2 to 2.5 s.",
  steady: "Target cuts of about 2.5 to 4 s.",
  cinematic: "Longer shots with a polished pace.",
};

export const ASPECT_OPTIONS: { value: PipelineGenerationParams["aspectRatio"]; label: string }[] = [
  { value: "9:16", label: "9:16 · Shorts, Reels, TikTok" },
  { value: "1:1", label: "1:1 · Square feed" },
  { value: "4:5", label: "4:5 · Portrait feed" },
  { value: "16:9", label: "16:9 · Landscape" },
];

export const DURATION_OPTIONS = [15, 30, 45, 60] as const;

export const GRADING_META: Record<GradingKey, { label: string; detail: string }> = {
  winnerScoreMin: {
    label: "Minimum winner score",
    detail: "Floor for the winner score, which is built from survival, variant count, country and platform spread, advertiser record and creative quality.",
  },
  pBeatMin: {
    label: "Bayesian P(beat) confidence",
    detail: "Minimum probability that a variant beats the brand's historical baseline.",
  },
  retention3sMin: {
    label: "3 s retention floor",
    detail: "Minimum share of viewers still watching at 3 seconds, from organic telemetry.",
  },
  confidenceMin: {
    label: "Perceptual confidence floor",
    detail: "Minimum confidence in decoded visual and audio traits before they are accepted without review.",
  },
};

export const PROMPT_KEYS: readonly PromptKey[] = ["briefPrompt", "scriptPrompt", "perceptionPrompt", "gradingPrompt"];

export const PROMPT_META: Record<PromptKey, { label: string; purpose: string }> = {
  briefPrompt: { label: "Brief synthesis", purpose: "Instructions for turning a market pattern into a brief." },
  scriptPrompt: { label: "Scriptwriting", purpose: "Instructions for script structure and spoken lines." },
  perceptionPrompt: { label: "Multimodal perception", purpose: "Instructions for reading video structure and audio." },
  gradingPrompt: { label: "JEV cognitive grading", purpose: "Instructions for the grading rubric wording." },
};

/** Why a saved value does not change any run. Shown next to the control, so no control looks active. */
export const NOT_READ_REASON = {
  videoCount: "No factory job reads the video count yet.",
  aspectRatio: "No factory job reads the aspect ratio yet.",
  durationSeconds: "No factory job reads the duration yet.",
  renderPacing: "No factory job reads the cut pacing yet.",
  provider: "No factory job reads the render engine yet.",
  dailyGenerationCap: "No factory job reads this daily cap yet. The spend caps on the Live tests tab are the ones launch reads.",
  winnerScoreMin: "winner-score.ts defines no floor, and no job reads this value.",
  pBeatMin: "No factory job computes or checks P(beat) against this value yet.",
  retention3sMin: "No factory job checks 3 s retention against this value yet.",
  confidenceMin: "No factory job reads this value yet.",
  autoApproveEnabled: "No job reads this switch. JEV's own approval rules run separately.",
  strictClaimGate: "The gate job passes no claim text to the claims check, so this switch cannot block a variant today.",
  prompt: "No model call reads this text yet.",
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------------------------------

export const PRESET_KEYS = ["viral_ugc", "problem_solution", "strict_quality", "manual_cloud"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

export const PRESET_LABEL: Record<PresetKey, string> = {
  viral_ugc: "Viral UGC",
  problem_solution: "Problem-Solution",
  strict_quality: "Strict Quality",
  manual_cloud: "Manual Cloud",
};

/** The values a preset fills, read from the preset itself. A preset states values only, never results. */
export function presetSettingLines(key: PresetKey): string[] {
  const preset = PIPELINE_PRESETS[key];
  const generation = preset.generationParams;
  const grading = preset.gradingThresholds;
  const lines = [
    `${generation.videoCount} ${generation.videoCount === 1 ? "video" : "videos"} per concept`,
    `${generation.aspectRatio} aspect ratio`,
    `${generation.durationSeconds} s duration`,
    `${PACING_LABEL[generation.renderPacing]} cut pacing`,
    `${ENGINE_LABEL[generation.provider]} engine`,
    `${generation.dailyGenerationCap} per day generation cap`,
    `winner score ${formatPercent(grading.winnerScoreMin)} minimum`,
    `P(beat) ${formatPercent(grading.pBeatMin)}`,
    `3 s retention ${formatPercent(grading.retention3sMin)}`,
    `auto-approve ${grading.autoApproveEnabled ? "on" : "off"}`,
    `strict claim gate ${grading.strictClaimGate ? "on" : "off"}`,
  ];
  const changedPrompts = PROMPT_KEYS.filter((prompt) => preset.prompts[prompt] !== DEFAULT_PROMPTS[prompt]);
  if (changedPrompts.length > 0) {
    lines.push(`${changedPrompts.length === 1 ? "1 prompt" : `${changedPrompts.length} prompts`} changed: ${changedPrompts.map((prompt) => PROMPT_META[prompt].label.toLowerCase()).join(", ")}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Draft, saved copy and validation
// ---------------------------------------------------------------------------------------------------------------------

/** The saved copy the editor compares against. With nothing saved, the defaults are shown under the "custom" label. */
export function savedConfigOf(saved?: FactoryPipelineConfig): FactoryPipelineConfig {
  return saved ? validatePipelineConfig(saved) : { ...getDefaultPipelineConfig(), presetName: "custom" };
}

/** The fields that define a configuration. The preset label is left out: it is set from the values on save. */
function comparable(config: FactoryPipelineConfig) {
  return {
    stages: config.stages.map((stage) => [stage.id, stage.enabled, stage.label, stage.description, stage.category]),
    prompts: {
      briefPrompt: config.prompts.briefPrompt,
      scriptPrompt: config.prompts.scriptPrompt,
      perceptionPrompt: config.prompts.perceptionPrompt,
      gradingPrompt: config.prompts.gradingPrompt,
    },
    generationParams: {
      videoCount: config.generationParams.videoCount,
      aspectRatio: config.generationParams.aspectRatio,
      durationSeconds: config.generationParams.durationSeconds,
      dailyGenerationCap: config.generationParams.dailyGenerationCap,
      provider: config.generationParams.provider,
      renderPacing: config.generationParams.renderPacing,
    },
    gradingThresholds: {
      winnerScoreMin: config.gradingThresholds.winnerScoreMin,
      pBeatMin: config.gradingThresholds.pBeatMin,
      retention3sMin: config.gradingThresholds.retention3sMin,
      confidenceMin: config.gradingThresholds.confidenceMin,
      autoApproveEnabled: config.gradingThresholds.autoApproveEnabled,
      strictClaimGate: config.gradingThresholds.strictClaimGate,
    },
  };
}

export function isDirty(draft: FactoryPipelineConfig, saved: FactoryPipelineConfig): boolean {
  return JSON.stringify(comparable(draft)) !== JSON.stringify(comparable(saved));
}

/** The preset whose values equal the draft exactly. It describes values only and marks no preset as active. */
export function matchingPresetKey(config: FactoryPipelineConfig): PresetKey | null {
  const target = JSON.stringify(comparable(config));
  return PRESET_KEYS.find((key) => JSON.stringify(comparable(getPresetConfig(key))) === target) ?? null;
}

/** The config sent to the server. The label says a preset only when the values are that preset's values. */
export function configToSave(draft: FactoryPipelineConfig): FactoryPipelineConfig {
  return validatePipelineConfig({ ...draft, presetName: matchingPresetKey(draft) ?? "custom" });
}

export type DraftProblem = { key: PromptKey; message: string };

/**
 * An empty prompt would be replaced by the default on save, without a message. Blocking the save says so instead.
 * Prompt text is never part of a message.
 */
export function draftProblems(config: FactoryPipelineConfig): DraftProblem[] {
  return PROMPT_KEYS.filter((key) => config.prompts[key].trim() === "").map((key) => ({
    key,
    message: `${PROMPT_META[key].label} prompt is empty. Saving would swap in the default text, so add text or restore the default.`,
  }));
}
