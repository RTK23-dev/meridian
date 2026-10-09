/**
 * Factory Line Pipeline Configuration & Process Customization
 *
 * Configures the modular stages of the Content Factory without requiring external tools like n8n:
 * - System prompts per stage (Brief synthesis, Scriptwriter, Multimodal perception, JEV grading)
 * - Dynamic generation parameters (Amount of videos made, aspect ratios, pacing, render engine)
 * - Cognitive grading levels (Winner score floor, Bayesian P(beat), 3s hook retention floor)
 * - Curated pipeline presets for fast switching
 */

export type FactoryComponentId =
  | "discover"
  | "decode"
  | "grade"
  | "brief"
  | "script"
  | "produce"
  | "gate"
  | "review"
  | "launch";

export type StageCategory = "input" | "intelligence" | "creative" | "production" | "qc";

export type PipelineStageConfig = {
  id: FactoryComponentId;
  enabled: boolean;
  label: string;
  description: string;
  category: StageCategory;
};

export type PipelinePrompts = {
  briefPrompt: string;
  scriptPrompt: string;
  perceptionPrompt: string;
  gradingPrompt: string;
};

export type PipelineGenerationParams = {
  videoCount: number; // 1 to 10
  aspectRatio: "9:16" | "1:1" | "16:9" | "4:5";
  durationSeconds: number; // 15, 30, 45, 60
  dailyGenerationCap: number;
  provider: "manual_cloud" | "hypit" | "veo" | "higgsfield";
  renderPacing: "hyper_fast" | "cinematic" | "steady" | "dynamic";
};

export type PipelineGradingThresholds = {
  winnerScoreMin: number; // 0.50 - 0.99
  pBeatMin: number; // 0.50 - 0.99
  retention3sMin: number; // 0.10 - 0.90
  confidenceMin: number; // 0.40 - 0.99
  autoApproveEnabled: boolean;
  strictClaimGate: boolean;
};

export type FactoryPipelineConfig = {
  presetName: "viral_ugc" | "problem_solution" | "strict_quality" | "manual_cloud" | "custom";
  stages: PipelineStageConfig[];
  prompts: PipelinePrompts;
  generationParams: PipelineGenerationParams;
  gradingThresholds: PipelineGradingThresholds;
  updatedAt?: string;
  updatedBy?: string;
};

export const DEFAULT_STAGES: PipelineStageConfig[] = [
  {
    id: "discover",
    enabled: true,
    label: "Discovery & Feed Ingestion",
    description: "Monitors TikTok, Reels, YouTube Shorts, and market ads for trending outlier concepts.",
    category: "input",
  },
  {
    id: "decode",
    enabled: true,
    label: "Multimodal Perception",
    description: "Decodes hook pacing, narrative beats, audio prosody, and visual craft aesthetics.",
    category: "intelligence",
  },
  {
    id: "grade",
    enabled: true,
    label: "JEV Cognitive Grading",
    description: "Evaluates psychological transferability, claim safety, and statistical win probability.",
    category: "intelligence",
  },
  {
    id: "brief",
    enabled: true,
    label: "Angle & Brief Synthesis",
    description: "Merges discovered mechanisms with written brand brain positioning and guidelines.",
    category: "creative",
  },
  {
    id: "script",
    enabled: true,
    label: "Script & Monologue Engine",
    description: "Writes high-retention spoken dialogue, visual overlays, and patterned CTAs.",
    category: "creative",
  },
  {
    id: "produce",
    enabled: true,
    label: "Video Production Router",
    description: "Dispatches timeline rendering across ManualCloud ($0 spend Drive drop) or AI engines.",
    category: "production",
  },
  {
    id: "gate",
    enabled: true,
    label: "Quality & Compliance Gates",
    description: "Enforces originality, safe zones, claim substantiation, and logo accuracy.",
    category: "qc",
  },
  {
    id: "review",
    enabled: true,
    label: "Review & Sign-Off",
    description: "Directs approved assets to publication or routes flagged variants to human review.",
    category: "qc",
  },
  {
    id: "launch",
    enabled: true,
    label: "Multi-Channel Distribution",
    description: "Dispatches variants to organic social feeds and paid testing ad networks.",
    category: "production",
  },
];

export const DEFAULT_PROMPTS: PipelinePrompts = {
  briefPrompt: `You are the Meridian Creative Director. Analyze the opportunity hypothesis and brand guidelines.
Synthesize a performance brief that copies the underlying psychological framework, never the competitor's ad copy.
Mandatory requirements:
1. Frame the problem through the brand's verified positioning.
2. Establish a clear open loop in the opening 2.5 seconds.
3. Ground every functional claim in recorded product facts.
4. Adhere strictly to prohibited claims and words to avoid.`,

  scriptPrompt: `You are a direct-response video scriptwriter specializing in short-form mobile video.
Write high-engagement scripts designed for organic retention and paid conversion.
Rules:
- Hook (0-3s): Punchy pattern interrupt or counterintuitive question.
- Body (3-25s): Relatable demonstration, fast cuts, concise sentences.
- Payoff (25-30s): Clear transformation and low-friction call-to-action.
- Tone: Native, conversational, natural spoken cadence (140-180 WPM).`,

  perceptionPrompt: `Analyze the provided video asset and transcript.
Extract key structural traits:
- Hook mechanism type (curiosity, pain_point, bold_claim, pov_relatable).
- Cut pacing classification (hyper_fast, dynamic, cinematic).
- Dominant visual style (raw_phone, lo_fi, studio_clean).
- Audio prosody and speaking rate.
Do not hallucinate metrics not present in evidence.`,

  gradingPrompt: `You are JEV, the deterministic System One advertising intelligence model.
Evaluate this creative concept against brand safety, claim truthfulness, and transferability.
Reject any concept that:
1. Claims unsubstantiated medical or performance guarantees.
2. Plagiarizes competitor slogans or copyrighted audio.
3. Exceeds brand risk tolerance.
Assign calibrated probabilities to each rubric gate.`,
};

export const DEFAULT_GENERATION_PARAMS: PipelineGenerationParams = {
  videoCount: 3,
  aspectRatio: "9:16",
  durationSeconds: 30,
  dailyGenerationCap: 12,
  provider: "manual_cloud",
  renderPacing: "dynamic",
};

export const DEFAULT_GRADING_THRESHOLDS: PipelineGradingThresholds = {
  winnerScoreMin: 0.70,
  pBeatMin: 0.80,
  retention3sMin: 0.45,
  confidenceMin: 0.65,
  autoApproveEnabled: false,
  strictClaimGate: true,
};

export const PIPELINE_PRESETS: Record<string, FactoryPipelineConfig> = {
  viral_ugc: {
    presetName: "viral_ugc",
    stages: DEFAULT_STAGES.map((s) => ({ ...s, enabled: true })),
    prompts: {
      ...DEFAULT_PROMPTS,
      scriptPrompt: `You are a TikTok/Reels native UGC creator. Write relatable, humorous, and lo-fi scripts with rapid pattern interrupts. Use casual conversational language with natural pauses.`,
    },
    generationParams: {
      videoCount: 5,
      aspectRatio: "9:16",
      durationSeconds: 15,
      dailyGenerationCap: 20,
      provider: "manual_cloud",
      renderPacing: "hyper_fast",
    },
    gradingThresholds: {
      winnerScoreMin: 0.68,
      pBeatMin: 0.75,
      retention3sMin: 0.40,
      confidenceMin: 0.60,
      autoApproveEnabled: false,
      strictClaimGate: true,
    },
  },

  problem_solution: {
    presetName: "problem_solution",
    stages: DEFAULT_STAGES.map((s) => ({ ...s, enabled: true })),
    prompts: {
      ...DEFAULT_PROMPTS,
      scriptPrompt: `Focus on agitation of common frustrations followed by dramatic demonstration of solution. Build high perceived value and address audience objections before presenting the CTA.`,
    },
    generationParams: {
      videoCount: 3,
      aspectRatio: "9:16",
      durationSeconds: 30,
      dailyGenerationCap: 10,
      provider: "manual_cloud",
      renderPacing: "steady",
    },
    gradingThresholds: {
      winnerScoreMin: 0.78,
      pBeatMin: 0.85,
      retention3sMin: 0.50,
      confidenceMin: 0.70,
      autoApproveEnabled: false,
      strictClaimGate: true,
    },
  },

  strict_quality: {
    presetName: "strict_quality",
    stages: DEFAULT_STAGES.map((s) => ({ ...s, enabled: true })),
    prompts: {
      ...DEFAULT_PROMPTS,
      briefPrompt: `${DEFAULT_PROMPTS.briefPrompt}\nApply maximum conservatism: reject any aggressive phrasing or unproven assertions.`,
    },
    generationParams: {
      videoCount: 2,
      aspectRatio: "9:16",
      durationSeconds: 45,
      dailyGenerationCap: 6,
      provider: "manual_cloud",
      renderPacing: "cinematic",
    },
    gradingThresholds: {
      winnerScoreMin: 0.85,
      pBeatMin: 0.90,
      retention3sMin: 0.55,
      confidenceMin: 0.80,
      autoApproveEnabled: false,
      strictClaimGate: true,
    },
  },

  manual_cloud: {
    presetName: "manual_cloud",
    stages: DEFAULT_STAGES.map((s) => ({ ...s, enabled: true })),
    prompts: DEFAULT_PROMPTS,
    generationParams: {
      videoCount: 3,
      aspectRatio: "9:16",
      durationSeconds: 30,
      dailyGenerationCap: 15,
      provider: "manual_cloud",
      renderPacing: "dynamic",
    },
    gradingThresholds: DEFAULT_GRADING_THRESHOLDS,
  },
};

export function getDefaultPipelineConfig(): FactoryPipelineConfig {
  return {
    presetName: "viral_ugc",
    stages: DEFAULT_STAGES.map((s) => ({ ...s })),
    prompts: { ...DEFAULT_PROMPTS },
    generationParams: { ...DEFAULT_GENERATION_PARAMS },
    gradingThresholds: { ...DEFAULT_GRADING_THRESHOLDS },
  };
}

export function getPresetConfig(presetName: string): FactoryPipelineConfig {
  if (presetName in PIPELINE_PRESETS) {
    const preset = PIPELINE_PRESETS[presetName as keyof typeof PIPELINE_PRESETS];
    return {
      presetName: preset.presetName,
      stages: preset.stages.map((s) => ({ ...s })),
      prompts: { ...preset.prompts },
      generationParams: { ...preset.generationParams },
      gradingThresholds: { ...preset.gradingThresholds },
    };
  }
  return getDefaultPipelineConfig();
}

export function validatePipelineConfig(input: Partial<FactoryPipelineConfig>): FactoryPipelineConfig {
  const defaults = getDefaultPipelineConfig();

  const presetName = input.presetName && input.presetName in PIPELINE_PRESETS
    ? input.presetName
    : "custom";

  const stages = Array.isArray(input.stages) && input.stages.length > 0
    ? input.stages.map((st) => ({
        id: st.id || "discover",
        enabled: st.enabled !== false,
        label: String(st.label || "").slice(0, 80),
        description: String(st.description || "").slice(0, 200),
        category: (st.category || "input") as StageCategory,
      }))
    : defaults.stages;

  const prompts: PipelinePrompts = {
    briefPrompt: String(input.prompts?.briefPrompt || defaults.prompts.briefPrompt).slice(0, 4000),
    scriptPrompt: String(input.prompts?.scriptPrompt || defaults.prompts.scriptPrompt).slice(0, 4000),
    perceptionPrompt: String(input.prompts?.perceptionPrompt || defaults.prompts.perceptionPrompt).slice(0, 4000),
    gradingPrompt: String(input.prompts?.gradingPrompt || defaults.prompts.gradingPrompt).slice(0, 4000),
  };

  const gen = input.generationParams || defaults.generationParams;
  const generationParams: PipelineGenerationParams = {
    videoCount: Math.min(10, Math.max(1, Math.round(Number(gen.videoCount) || 3))),
    aspectRatio: ["9:16", "1:1", "16:9", "4:5"].includes(gen.aspectRatio) ? gen.aspectRatio : "9:16",
    durationSeconds: Math.min(120, Math.max(10, Math.round(Number(gen.durationSeconds) || 30))),
    dailyGenerationCap: Math.min(100, Math.max(1, Math.round(Number(gen.dailyGenerationCap) || 12))),
    provider: ["manual_cloud", "hypit", "veo", "higgsfield"].includes(gen.provider) ? gen.provider : "manual_cloud",
    renderPacing: ["hyper_fast", "cinematic", "steady", "dynamic"].includes(gen.renderPacing) ? gen.renderPacing : "dynamic",
  };

  const gt = input.gradingThresholds || defaults.gradingThresholds;
  const gradingThresholds: PipelineGradingThresholds = {
    winnerScoreMin: Math.min(0.99, Math.max(0.50, Number(gt.winnerScoreMin) || 0.70)),
    pBeatMin: Math.min(0.99, Math.max(0.50, Number(gt.pBeatMin) || 0.80)),
    retention3sMin: Math.min(0.90, Math.max(0.10, Number(gt.retention3sMin) || 0.45)),
    confidenceMin: Math.min(0.99, Math.max(0.40, Number(gt.confidenceMin) || 0.65)),
    autoApproveEnabled: gt.autoApproveEnabled === true,
    strictClaimGate: gt.strictClaimGate !== false,
  };

  return {
    presetName,
    stages,
    prompts,
    generationParams,
    gradingThresholds,
  };
}
