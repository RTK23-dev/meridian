// The factory pipeline presets, and the three Content Factory start modes, as built-in cookbooks (round 3, K5, D4: replace and improve).
// Nothing is scrapped: each preset's stages become steps with their own on/off toggles, its four prompt texts become role instructions,
// and its generation and grading numbers become controls with the ranges the validator enforces. pipelineConfigFromCookbook is the
// inverse, so a test can show that a preset resolved through its cookbook gives back the same configuration as getPresetConfig.

import { DEFAULT_STAGES, PIPELINE_PRESETS, type FactoryComponentId, type FactoryPipelineConfig } from "../../factory/pipeline-config.ts";
import type { NodeKind } from "../../../../engine/orchestrator/contracts.ts";
import type { Control } from "../controls.ts";
import type { Cookbook, Step } from "../schema.ts";
import type { ResolvedCookbook } from "../resolve.ts";

/** The orchestrator node kind each factory stage runs as. */
const STAGE_KIND: Record<FactoryComponentId, NodeKind> = {
  discover: "reference",
  decode: "analysis",
  grade: "analysis",
  brief: "analysis",
  script: "script",
  produce: "video",
  gate: "analysis",
  review: "analysis",
  launch: "render",
};

/** Each prompt text becomes an instruction for the role that does its work. Each role has one prompt, so the mapping is one to one. */
const PROMPT_ROLE = {
  briefPrompt: "plan",
  scriptPrompt: "script",
  perceptionPrompt: "visual",
  gradingPrompt: "critic",
} as const;

const PRESET_LABEL: Record<string, string> = {
  viral_ugc: "Viral UGC",
  problem_solution: "Problem and solution",
  strict_quality: "Strict quality",
  manual_cloud: "Manual cloud",
};

const PRESET_FAMILY: Record<string, Cookbook["family"]> = {
  viral_ugc: "ugc",
  problem_solution: "product",
  strict_quality: "explainer",
  manual_cloud: "other",
};

export const FACTORY_PRESET_NAMES = ["viral_ugc", "problem_solution", "strict_quality", "manual_cloud"] as const;

/** The cookbook of one factory preset. Its id is `ck_factory_<preset>`, so a saved configuration can name the preset it came from. */
export function factoryPresetCookbook(presetName: (typeof FACTORY_PRESET_NAMES)[number]): Cookbook {
  const preset = PIPELINE_PRESETS[presetName];
  if (preset === undefined) throw new Error(`there is no factory preset ${presetName}`);
  const stages = DEFAULT_STAGES;

  const steps: Step[] = stages.map((stage, index) => {
    const previous = stages[index - 1];
    const after = previous ? [previous.id] : [];
    const params: Step["params"] = { category: stage.category, description: stage.description };
    if (stage.id === "produce") {
      Object.assign(params, {
        video_count: preset.generationParams.videoCount,
        aspect_ratio: preset.generationParams.aspectRatio,
        duration_seconds: preset.generationParams.durationSeconds,
        daily_generation_cap: preset.generationParams.dailyGenerationCap,
        provider: preset.generationParams.provider,
        render_pacing: preset.generationParams.renderPacing,
      });
    }
    if (stage.id === "grade") {
      Object.assign(params, {
        winner_score_min: preset.gradingThresholds.winnerScoreMin,
        p_beat_min: preset.gradingThresholds.pBeatMin,
        retention_3s_min: preset.gradingThresholds.retention3sMin,
        confidence_min: preset.gradingThresholds.confidenceMin,
        auto_approve_enabled: preset.gradingThresholds.autoApproveEnabled,
        strict_claim_gate: preset.gradingThresholds.strictClaimGate,
      });
    }
    return { id: stage.id, kind: STAGE_KIND[stage.id], label: stage.label, after, uses: {}, params };
  });

  const controls: Control[] = [
    ...stages.map((stage): Control => ({
      id: `stage_${stage.id}`,
      kind: "toggle",
      label: stage.label,
      help: stage.description,
      default: preset.stages.find((candidate) => candidate.id === stage.id)?.enabled ?? stage.enabled,
      binds: [{ enable: stage.id }],
    })),
    {
      id: "video_count",
      kind: "slider",
      label: "Videos per run",
      min: 1,
      max: 10,
      step: 1,
      default: preset.generationParams.videoCount,
      binds: [{ set: "step.produce.video_count" }],
    },
    {
      id: "aspect_ratio",
      kind: "select",
      label: "Aspect ratio",
      options: [
        { value: "9:16", label: "9:16" },
        { value: "1:1", label: "1:1" },
        { value: "16:9", label: "16:9" },
        { value: "4:5", label: "4:5" },
      ],
      default: preset.generationParams.aspectRatio,
      binds: [{ set: "step.produce.aspect_ratio" }],
    },
    {
      id: "duration_seconds",
      kind: "select",
      label: "Length",
      options: [
        { value: "15", label: "15 seconds" },
        { value: "30", label: "30 seconds" },
        { value: "45", label: "45 seconds" },
        { value: "60", label: "60 seconds" },
      ],
      default: String(preset.generationParams.durationSeconds),
      binds: [{ set: "step.produce.duration_seconds", map: { table: { "15": 15, "30": 30, "45": 45, "60": 60 } } }],
    },
    {
      id: "daily_generation_cap",
      kind: "slider",
      label: "Daily generation cap",
      min: 1,
      max: 200,
      step: 1,
      default: preset.generationParams.dailyGenerationCap,
      binds: [{ set: "step.produce.daily_generation_cap" }],
    },
    {
      id: "provider",
      kind: "select",
      label: "Render provider",
      options: [
        { value: "manual_cloud", label: "Manual cloud" },
        { value: "hypit", label: "Hypit" },
        { value: "higgsfield", label: "Higgsfield" },
      ],
      default: preset.generationParams.provider,
      binds: [{ set: "step.produce.provider" }],
    },
    {
      id: "render_pacing",
      kind: "select",
      label: "Pacing",
      options: [
        { value: "hyper_fast", label: "Hyper fast" },
        { value: "cinematic", label: "Cinematic" },
        { value: "steady", label: "Steady" },
        { value: "dynamic", label: "Dynamic" },
      ],
      default: preset.generationParams.renderPacing,
      binds: [{ set: "step.produce.render_pacing" }],
    },
    {
      id: "winner_score_min",
      kind: "slider",
      label: "Winner score floor",
      min: 0.5,
      max: 0.99,
      step: 0.01,
      default: preset.gradingThresholds.winnerScoreMin,
      binds: [{ set: "step.grade.winner_score_min" }],
    },
    {
      id: "p_beat_min",
      kind: "slider",
      label: "Chance to beat the baseline",
      min: 0.5,
      max: 0.99,
      step: 0.01,
      default: preset.gradingThresholds.pBeatMin,
      binds: [{ set: "step.grade.p_beat_min" }],
    },
    {
      id: "retention_3s_min",
      kind: "slider",
      label: "3-second retention floor",
      min: 0.1,
      max: 0.9,
      step: 0.01,
      default: preset.gradingThresholds.retention3sMin,
      binds: [{ set: "step.grade.retention_3s_min" }],
    },
    {
      id: "confidence_min",
      kind: "slider",
      label: "Confidence floor",
      min: 0.4,
      max: 0.99,
      step: 0.01,
      default: preset.gradingThresholds.confidenceMin,
      binds: [{ set: "step.grade.confidence_min" }],
    },
    {
      id: "auto_approve",
      kind: "toggle",
      label: "Approve winners automatically",
      help: "Off keeps a person in the approval step.",
      default: preset.gradingThresholds.autoApproveEnabled,
      binds: [{ set: "step.grade.auto_approve_enabled" }],
    },
    {
      id: "strict_claim_gate",
      kind: "toggle",
      label: "Strict claim gate",
      default: preset.gradingThresholds.strictClaimGate,
      binds: [{ set: "step.grade.strict_claim_gate" }],
    },
  ];

  const instructions = (Object.keys(PROMPT_ROLE) as Array<keyof typeof PROMPT_ROLE>).map((key) => ({
    role: PROMPT_ROLE[key],
    text: preset.prompts[key],
  }));

  return {
    schema: "meridian.cookbook/v1",
    cookbookId: `ck_factory_${presetName}`,
    version: 1,
    label: PRESET_LABEL[presetName] ?? presetName,
    summary: `The factory pipeline preset "${PRESET_LABEL[presetName] ?? presetName}": its stages, prompts and thresholds, now as a cookbook.`,
    family: PRESET_FAMILY[presetName] ?? "other",
    scope: "builtin",
    modes: ["engine"],
    ingredients: [],
    steps,
    instructions,
    grammar: { structure: [] },
    controls,
    checks: [],
  };
}

/** The three Content Factory start modes as blank cookbooks: one step each, with nothing pre-set. Admin-only is decided by the screen (K18). */
export function blankCookbook(mode: "brief" | "reference" | "studio"): Cookbook {
  const start = {
    brief: { label: "Brief", kind: "script" as NodeKind, summary: "Describe the video. The engine writes the script, plans the shots and renders them." },
    reference: { label: "Reference", kind: "reference" as NodeKind, summary: "Attach a video you like. The engine plans a new one in the same style." },
    studio: { label: "Studio", kind: "reference" as NodeKind, summary: "Build the video yourself in the studio, step by step." },
  }[mode];
  return {
    schema: "meridian.cookbook/v1",
    cookbookId: `ck_blank_${mode}`,
    version: 1,
    label: start.label,
    summary: start.summary,
    family: "other",
    scope: "builtin",
    modes: ["engine"],
    ingredients: [],
    steps: [{ id: "start", kind: start.kind, label: `Start from ${start.label.toLowerCase()}`, after: [], uses: {}, params: {} }],
    instructions: [],
    grammar: { structure: [] },
    controls: [],
    checks: [],
  };
}

/** The factory configuration a resolved factory cookbook gives back: the same shape getPresetConfig returns. Throws when a value is missing. */
export function pipelineConfigFromCookbook(resolved: ResolvedCookbook, presetName: (typeof FACTORY_PRESET_NAMES)[number]): FactoryPipelineConfig {
  const byId = new Map(resolved.steps.map((step) => [step.id, step] as const));
  const param = (stepId: string, key: string): string | number | boolean => {
    const value = byId.get(stepId)?.params[key];
    if (value === undefined || value === null) throw new Error(`step ${stepId} has no ${key}`);
    return value as string | number | boolean;
  };
  const role = (name: string): string => {
    const text = resolved.instructions[name as keyof typeof resolved.instructions]?.[0];
    if (text === undefined) throw new Error(`no instruction for ${name}`);
    return text;
  };
  return {
    presetName,
    stages: DEFAULT_STAGES.map((stage) => {
      const step = byId.get(stage.id);
      return {
        id: stage.id,
        enabled: step?.enabled ?? false,
        label: step?.label ?? stage.label,
        description: String(param(stage.id, "description")),
        category: String(param(stage.id, "category")) as FactoryPipelineConfig["stages"][number]["category"],
      };
    }),
    prompts: {
      briefPrompt: role("plan"),
      scriptPrompt: role("script"),
      perceptionPrompt: role("visual"),
      gradingPrompt: role("critic"),
    },
    generationParams: {
      videoCount: Number(param("produce", "video_count")),
      aspectRatio: String(param("produce", "aspect_ratio")) as FactoryPipelineConfig["generationParams"]["aspectRatio"],
      durationSeconds: Number(param("produce", "duration_seconds")),
      dailyGenerationCap: Number(param("produce", "daily_generation_cap")),
      provider: String(param("produce", "provider")) as FactoryPipelineConfig["generationParams"]["provider"],
      renderPacing: String(param("produce", "render_pacing")) as FactoryPipelineConfig["generationParams"]["renderPacing"],
    },
    gradingThresholds: {
      winnerScoreMin: Number(param("grade", "winner_score_min")),
      pBeatMin: Number(param("grade", "p_beat_min")),
      retention3sMin: Number(param("grade", "retention_3s_min")),
      confidenceMin: Number(param("grade", "confidence_min")),
      autoApproveEnabled: Boolean(param("grade", "auto_approve_enabled")),
      strictClaimGate: Boolean(param("grade", "strict_claim_gate")),
    },
  };
}

