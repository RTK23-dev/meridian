import { useState } from "react";
import {
  type FactoryPipelineConfig,
  type FactoryComponentId,
  PIPELINE_PRESETS,
  getDefaultPipelineConfig,
  validatePipelineConfig,
} from "@/lib/meridian/factory/pipeline-config";
import { savePipelineConfig, applyPipelinePreset } from "@/lib/meridian/factory/pipeline-actions";
import { useQueryClient } from "@tanstack/react-query";
import { qk, userScopedQueryKey } from "@/lib/query/keys";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export function PipelineEditor({
  brandId,
  initialConfig,
  canEdit = true,
}: {
  brandId: string;
  initialConfig?: FactoryPipelineConfig;
  canEdit?: boolean;
}) {
  const qc = useQueryClient();
  const { user } = useCurrentUserState();
  const [config, setConfig] = useState<FactoryPipelineConfig>(
    () => initialConfig || getDefaultPipelineConfig(),
  );
  const [selectedStage, setSelectedStage] = useState<FactoryComponentId>("produce");
  const [activeTab, setActiveTab] = useState<"pipeline" | "volume" | "grading" | "prompts">("pipeline");
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const handleStageToggle = (stageId: FactoryComponentId) => {
    if (!canEdit) return;
    setConfig((prev) => ({
      ...prev,
      presetName: "custom",
      stages: prev.stages.map((s) => (s.id === stageId ? { ...s, enabled: !s.enabled } : s)),
    }));
  };

  const handlePresetSelect = async (presetKey: string) => {
    if (!canEdit) return;
    const preset = PIPELINE_PRESETS[presetKey];
    if (!preset) return;

    setConfig({ ...preset });
    setIsSaving(true);
    setFeedback(null);
    try {
      await applyPipelinePreset({ data: { brandId, presetName: presetKey } });
      qc.invalidateQueries({ queryKey: userScopedQueryKey(user?.id, qk.pipelineConfig(brandId)) });
      setFeedback({ message: `Preset "${presetKey.replace(/_/g, " ")}" applied and saved.`, type: "success" });
    } catch (err) {
      setFeedback({ message: err instanceof Error ? err.message : String(err), type: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!canEdit) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const validated = validatePipelineConfig(config);
      await savePipelineConfig({ data: { brandId, config: validated } });
      qc.invalidateQueries({ queryKey: userScopedQueryKey(user?.id, qk.pipelineConfig(brandId)) });
      setFeedback({ message: "Factory line configuration saved successfully.", type: "success" });
    } catch (err) {
      setFeedback({ message: err instanceof Error ? err.message : String(err), type: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Preset Quick Bar */}
      <div className="rounded-xl border border-line bg-surface-elevated/70 p-5 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-brass animate-pulse" />
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">
                Modular Content Line
              </p>
            </div>
            <h2 className="font-display text-2xl font-semibold text-foreground">
              Factory Process Editor
            </h2>
            <p className="text-xs text-muted max-w-xl">
              Modify the exact factory process without third-party automation tools. Customize system prompts,
              video generation volumes, and winning concept grading thresholds in real-time.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted mr-1">Presets:</span>
            {Object.keys(PIPELINE_PRESETS).map((key) => {
              const active = config.presetName === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!canEdit || isSaving}
                  onClick={() => void handlePresetSelect(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    active
                      ? "border border-brass/60 bg-brass/15 text-brass shadow-sm font-semibold"
                      : "border border-line/70 bg-surface/50 text-muted hover:border-brass/30 hover:text-foreground"
                  }`}
                >
                  {key === "viral_ugc" && "🔥 Viral UGC (5 vids)"}
                  {key === "problem_solution" && "🎯 Problem-Solution (3 vids)"}
                  {key === "strict_quality" && "🛡️ Strict Quality (2 vids)"}
                  {key === "manual_cloud" && "☁️ ManualCloud ($0)"}
                </button>
              );
            })}
          </div>
        </div>

        {feedback && (
          <div
            className={`mt-4 rounded-lg px-3.5 py-2 text-xs font-medium border flex items-center justify-between ${
              feedback.type === "success"
                ? "border-emerald-500/30 bg-emerald-950/20 text-emerald-400"
                : "border-red-500/30 bg-red-950/20 text-red-400"
            }`}
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="ml-2 hover:opacity-75"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Editor Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setActiveTab("pipeline")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              activeTab === "pipeline"
                ? "bg-brass text-black shadow-sm"
                : "text-muted hover:text-foreground hover:bg-surface-elevated/40"
            }`}
          >
            🏭 Conveyor Belt Flow
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("volume")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              activeTab === "volume"
                ? "bg-brass text-black shadow-sm"
                : "text-muted hover:text-foreground hover:bg-surface-elevated/40"
            }`}
          >
            📹 Video Amounts & Engine
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("grading")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              activeTab === "grading"
                ? "bg-brass text-black shadow-sm"
                : "text-muted hover:text-foreground hover:bg-surface-elevated/40"
            }`}
          >
            ⚖️ Winner Grading Levels
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("prompts")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              activeTab === "prompts"
                ? "bg-brass text-black shadow-sm"
                : "text-muted hover:text-foreground hover:bg-surface-elevated/40"
            }`}
          >
            🧠 Stage System Prompts
          </button>
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="flex items-center gap-2 rounded-lg bg-brass px-4 py-1.5 text-xs font-semibold text-black shadow hover:brightness-110 active:scale-95 transition"
          >
            {isSaving ? "Saving..." : "Save Pipeline Process"}
          </button>
        )}
      </div>

      {/* Tab 1: Conveyor Belt Flow / Component Cards */}
      {activeTab === "pipeline" && (
        <div className="space-y-6">
          <div className="overflow-x-auto pb-4">
            <div className="flex items-stretch gap-3 min-w-[900px]">
              {config.stages.map((stage, idx) => {
                const isSelected = selectedStage === stage.id;
                return (
                  <div key={stage.id} className="flex items-center gap-3">
                    <div
                      onClick={() => setSelectedStage(stage.id)}
                      className={`relative flex w-56 flex-col justify-between rounded-xl border p-4 cursor-pointer transition-all ${
                        isSelected
                          ? "border-brass bg-surface-elevated shadow-lg ring-1 ring-brass/40 -translate-y-0.5"
                          : stage.enabled
                            ? "border-line bg-surface/80 hover:border-line-strong hover:bg-surface-elevated/50"
                            : "border-line/40 bg-surface/30 opacity-60 hover:opacity-80"
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-elevated text-[10px] font-bold text-muted border border-line">
                            {idx + 1}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
                              stage.enabled
                                ? "bg-emerald-950/40 text-emerald-400 border border-emerald-500/30"
                                : "bg-neutral-800 text-neutral-400 border border-neutral-700"
                            }`}
                          >
                            {stage.enabled ? "Active" : "Bypassed"}
                          </span>
                        </div>

                        <div>
                          <p className="font-semibold text-sm text-foreground leading-snug">
                            {stage.label}
                          </p>
                          <p className="text-[11px] text-muted line-clamp-2 mt-1">
                            {stage.description}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-line/50 flex items-center justify-between">
                        <span className="text-[10px] font-medium text-brass">
                          {stage.id === "produce" && `${config.generationParams.videoCount} variants`}
                          {stage.id === "grade" && `Score ≥ ${(config.gradingThresholds.winnerScoreMin * 100).toFixed(0)}%`}
                          {stage.id === "brief" && "11D Angle Bible"}
                          {stage.id === "discover" && "Universal Scraper"}
                          {stage.id === "gate" && "QC & Safe Zones"}
                          {stage.id === "decode" && "DNA Pacing"}
                          {stage.id === "script" && "Spoken Monologues"}
                          {stage.id === "review" && (config.gradingThresholds.autoApproveEnabled ? "Auto" : "Human")}
                          {stage.id === "launch" && "Multi-Channel"}
                        </span>

                        {canEdit && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStageToggle(stage.id);
                            }}
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded transition ${
                              stage.enabled
                                ? "text-neutral-400 hover:text-red-400"
                                : "text-emerald-400 hover:text-emerald-300 font-bold"
                            }`}
                          >
                            {stage.enabled ? "Bypass" : "Enable"}
                          </button>
                        )}
                      </div>
                    </div>

                    {idx < config.stages.length - 1 && (
                      <div className="flex items-center text-muted select-none">
                        <svg className="w-4 h-4 text-line-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected Stage Detail Inspector */}
          {selectedStage && (
            <div className="rounded-xl border border-line bg-surface-elevated/60 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-brass uppercase tracking-wider">
                    Stage Inspector
                  </p>
                  <h3 className="text-lg font-semibold text-foreground">
                    {config.stages.find((s) => s.id === selectedStage)?.label}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => handleStageToggle(selectedStage)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold border transition ${
                    config.stages.find((s) => s.id === selectedStage)?.enabled
                      ? "border-red-500/30 bg-red-950/20 text-red-400 hover:bg-red-900/30"
                      : "border-emerald-500/30 bg-emerald-950/20 text-emerald-400 hover:bg-emerald-900/30"
                  }`}
                >
                  {config.stages.find((s) => s.id === selectedStage)?.enabled ? "Disable this stage" : "Enable this stage"}
                </button>
              </div>

              <p className="text-xs text-muted">
                {config.stages.find((s) => s.id === selectedStage)?.description}
              </p>

              {/* Contextual inspector content depending on stage */}
              {selectedStage === "produce" && (
                <div className="grid gap-4 md:grid-cols-3 pt-2">
                  <div className="space-y-1.5 rounded-lg border border-line p-3 bg-surface/50">
                    <label className="text-xs font-medium text-foreground">Video Variants Made</label>
                    <p className="text-[11px] text-muted">Number of distinct hooks/variations rendered per concept.</p>
                    <div className="flex items-center gap-1.5 pt-1">
                      {[1, 2, 3, 5, 8].map((num) => (
                        <button
                          key={num}
                          type="button"
                          onClick={() => setConfig((p) => ({
                            ...p,
                            presetName: "custom",
                            generationParams: { ...p.generationParams, videoCount: num },
                          }))}
                          className={`rounded px-2.5 py-1 text-xs font-semibold transition ${
                            config.generationParams.videoCount === num
                              ? "bg-brass text-black"
                              : "border border-line bg-surface text-muted hover:text-foreground"
                          }`}
                        >
                          {num}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-line p-3 bg-surface/50">
                    <label className="text-xs font-medium text-foreground">Render Engine</label>
                    <p className="text-[11px] text-muted">Production provider dispatched for video assembly.</p>
                    <select
                      value={config.generationParams.provider}
                      onChange={(e) => setConfig((p) => ({
                        ...p,
                        presetName: "custom",
                        generationParams: {
                          ...p.generationParams,
                          provider: e.target.value as FactoryPipelineConfig["generationParams"]["provider"],
                        },
                      }))}
                      className="mt-1 w-full rounded border border-line bg-surface p-1.5 text-xs text-foreground"
                    >
                      <option value="manual_cloud">ManualCloud ($0 spend Drive drop)</option>
                      <option value="hypit">Hypit Timeline Engine</option>
                      <option value="veo">Google Veo AI</option>
                      <option value="higgsfield">Higgsfield</option>
                    </select>
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-line p-3 bg-surface/50">
                    <label className="text-xs font-medium text-foreground">Cut Pacing</label>
                    <p className="text-[11px] text-muted">Tempo and frequency of camera / visual transitions.</p>
                    <select
                      value={config.generationParams.renderPacing}
                      onChange={(e) => setConfig((p) => ({
                        ...p,
                        presetName: "custom",
                        generationParams: {
                          ...p.generationParams,
                          renderPacing: e.target.value as FactoryPipelineConfig["generationParams"]["renderPacing"],
                        },
                      }))}
                      className="mt-1 w-full rounded border border-line bg-surface p-1.5 text-xs text-foreground"
                    >
                      <option value="hyper_fast">Hyper-Fast (&lt;1s cuts, maximum retention)</option>
                      <option value="dynamic">Dynamic (1.2-2.5s cuts, standard short-form)</option>
                      <option value="steady">Steady (2.5-4s cuts, problem-solution)</option>
                      <option value="cinematic">Cinematic (Polished commercial)</option>
                    </select>
                  </div>
                </div>
              )}

              {selectedStage === "grade" && (
                <div className="grid gap-4 md:grid-cols-3 pt-2">
                  <div className="space-y-1.5 rounded-lg border border-line p-3 bg-surface/50">
                    <label className="text-xs font-medium text-foreground">
                      Winner Threshold: {(config.gradingThresholds.winnerScoreMin * 100).toFixed(0)}%
                    </label>
                    <p className="text-[11px] text-muted">Minimum combined score to graduate an ad concept.</p>
                    <input
                      type="range"
                      min="50"
                      max="95"
                      step="1"
                      value={Math.round(config.gradingThresholds.winnerScoreMin * 100)}
                      onChange={(e) => setConfig((p) => ({
                        ...p,
                        presetName: "custom",
                        gradingThresholds: { ...p.gradingThresholds, winnerScoreMin: Number(e.target.value) / 100 },
                      }))}
                      className="w-full accent-brass"
                    />
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-line p-3 bg-surface/50">
                    <label className="text-xs font-medium text-foreground">
                      Bayesian P(Beat): {(config.gradingThresholds.pBeatMin * 100).toFixed(0)}%
                    </label>
                    <p className="text-[11px] text-muted">Statistical probability of beating brand historical baseline.</p>
                    <input
                      type="range"
                      min="50"
                      max="95"
                      step="1"
                      value={Math.round(config.gradingThresholds.pBeatMin * 100)}
                      onChange={(e) => setConfig((p) => ({
                        ...p,
                        presetName: "custom",
                        gradingThresholds: { ...p.gradingThresholds, pBeatMin: Number(e.target.value) / 100 },
                      }))}
                      className="w-full accent-brass"
                    />
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-line p-3 bg-surface/50">
                    <label className="text-xs font-medium text-foreground">
                      3s Retention Floor: {(config.gradingThresholds.retention3sMin * 100).toFixed(0)}%
                    </label>
                    <p className="text-[11px] text-muted">Required hook hold rate in organic telemetry.</p>
                    <input
                      type="range"
                      min="20"
                      max="75"
                      step="1"
                      value={Math.round(config.gradingThresholds.retention3sMin * 100)}
                      onChange={(e) => setConfig((p) => ({
                        ...p,
                        presetName: "custom",
                        gradingThresholds: { ...p.gradingThresholds, retention3sMin: Number(e.target.value) / 100 },
                      }))}
                      className="w-full accent-brass"
                    />
                  </div>
                </div>
              )}

              {selectedStage === "script" && (
                <div className="space-y-2 pt-2">
                  <label className="text-xs font-medium text-foreground">
                    Scriptwriter System Prompt
                  </label>
                  <p className="text-[11px] text-muted">
                    Controls dialogue pacing, hook sentence structures, and CTA urgency for mobile actors or text overlays.
                  </p>
                  <textarea
                    rows={4}
                    value={config.prompts.scriptPrompt}
                    onChange={(e) => setConfig((p) => ({
                      ...p,
                      presetName: "custom",
                      prompts: { ...p.prompts, scriptPrompt: e.target.value },
                    }))}
                    className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
                  />
                </div>
              )}

              {selectedStage === "brief" && (
                <div className="space-y-2 pt-2">
                  <label className="text-xs font-medium text-foreground">
                    Brief Synthesis System Prompt
                  </label>
                  <p className="text-[11px] text-muted">
                    Instructs how market mechanisms are synthesized into brand-compliant creative opportunities.
                  </p>
                  <textarea
                    rows={4}
                    value={config.prompts.briefPrompt}
                    onChange={(e) => setConfig((p) => ({
                      ...p,
                      presetName: "custom",
                      prompts: { ...p.prompts, briefPrompt: e.target.value },
                    }))}
                    className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
                  />
                </div>
              )}

              {selectedStage === "decode" && (
                <div className="space-y-2 pt-2">
                  <label className="text-xs font-medium text-foreground">
                    Multimodal Perception Prompt
                  </label>
                  <p className="text-[11px] text-muted">
                    Directs the vision model to categorize hook dynamics, cuts, visual craft, and audio prosody.
                  </p>
                  <textarea
                    rows={4}
                    value={config.prompts.perceptionPrompt}
                    onChange={(e) => setConfig((p) => ({
                      ...p,
                      presetName: "custom",
                      prompts: { ...p.prompts, perceptionPrompt: e.target.value },
                    }))}
                    className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
                  />
                </div>
              )}

              {selectedStage === "discover" && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-foreground font-medium">Supported Discovery Ingestion Fabrics</p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">📸 Instagram Reels</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">🎵 TikTok Videos</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">▶️ YouTube Shorts</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">🐦 Twitter / X</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">🧵 Threads</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">📌 Pinterest</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">👾 Reddit</span>
                    <span className="rounded bg-surface px-2.5 py-1 border border-line text-muted">💼 LinkedIn</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Video Amounts & Engine Settings */}
      {activeTab === "volume" && (
        <div className="rounded-xl border border-line bg-surface-elevated/70 p-6 space-y-6">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-foreground">
              Production Volume & Rendering Configuration
            </h3>
            <p className="text-xs text-muted">
              Configure how many video variations are produced, target format specifications, and provider routing.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                Amount of Videos Made Per Concept
              </label>
              <p className="text-xs text-muted">
                How many creative variations (different hooks, pacing, or audio) are rendered per winning opportunity.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {[1, 2, 3, 5, 8, 10].map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setConfig((p) => ({
                      ...p,
                      presetName: "custom",
                      generationParams: { ...p.generationParams, videoCount: count },
                    }))}
                    className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                      config.generationParams.videoCount === count
                        ? "bg-brass text-black shadow-sm"
                        : "border border-line bg-surface text-muted hover:text-foreground hover:border-line-strong"
                    }`}
                  >
                    {count} {count === 1 ? "Video" : "Videos"}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                Target Aspect Ratio
              </label>
              <p className="text-xs text-muted">
                Canvas resolution layout for render composition and overlay safe zones.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {[
                  { value: "9:16", label: "9:16 (Shorts/Reels/TikTok)" },
                  { value: "1:1", label: "1:1 (Square Feed)" },
                  { value: "4:5", label: "4:5 (Portrait Feed)" },
                  { value: "16:9", label: "16:9 (Landscape)" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setConfig((p) => ({
                      ...p,
                      presetName: "custom",
                      generationParams: {
                        ...p.generationParams,
                        aspectRatio: opt.value as FactoryPipelineConfig["generationParams"]["aspectRatio"],
                      },
                    }))}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                      config.generationParams.aspectRatio === opt.value
                        ? "bg-brass text-black shadow-sm"
                        : "border border-line bg-surface text-muted hover:text-foreground hover:border-line-strong"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                Target Video Duration
              </label>
              <p className="text-xs text-muted">
                Standard cut duration for synthesized short-form video timelines.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {[15, 30, 45, 60].map((dur) => (
                  <button
                    key={dur}
                    type="button"
                    onClick={() => setConfig((p) => ({
                      ...p,
                      presetName: "custom",
                      generationParams: { ...p.generationParams, durationSeconds: dur },
                    }))}
                    className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                      config.generationParams.durationSeconds === dur
                        ? "bg-brass text-black shadow-sm"
                        : "border border-line bg-surface text-muted hover:text-foreground hover:border-line-strong"
                    }`}
                  >
                    {dur} Seconds
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                Daily Batch Generation Limit
              </label>
              <p className="text-xs text-muted">
                Safety cap preventing runaway automated video rendering jobs in 24 hours.
              </p>
              <div className="flex items-center gap-3 pt-1">
                <input
                  type="range"
                  min="2"
                  max="50"
                  step="2"
                  value={config.generationParams.dailyGenerationCap}
                  onChange={(e) => setConfig((p) => ({
                    ...p,
                    presetName: "custom",
                    generationParams: { ...p.generationParams, dailyGenerationCap: Number(e.target.value) },
                  }))}
                  className="w-full accent-brass"
                />
                <span className="text-xs font-bold text-brass min-w-[70px]">
                  {config.generationParams.dailyGenerationCap} / day
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Winner Grading Levels & Thresholds */}
      {activeTab === "grading" && (
        <div className="rounded-xl border border-line bg-surface-elevated/70 p-6 space-y-6">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-foreground">
              Cognitive Grading Levels & Winner Qualification
            </h3>
            <p className="text-xs text-muted">
              Define the strictness filters before an ad concept or organic outlier graduates to production.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Winning Concept Score Floor
                </label>
                <span className="text-sm font-bold text-brass">
                  {(config.gradingThresholds.winnerScoreMin * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-xs text-muted">
                Minimum composite Winner Score (novelty, market signal, brand fit, historical evidence) to proceed.
              </p>
              <input
                type="range"
                min="50"
                max="95"
                step="1"
                value={Math.round(config.gradingThresholds.winnerScoreMin * 100)}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  gradingThresholds: { ...p.gradingThresholds, winnerScoreMin: Number(e.target.value) / 100 },
                }))}
                className="w-full accent-brass"
              />
              <div className="flex justify-between text-[10px] text-muted">
                <span>50% (Permissive)</span>
                <span>70% (Balanced)</span>
                <span>95% (Strict Outlier)</span>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Bayesian P(Beat Baseline)
                </label>
                <span className="text-sm font-bold text-brass">
                  {(config.gradingThresholds.pBeatMin * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-xs text-muted">
                Bayesian posterior certainty required before an angle or hook mechanism is accepted as a winning pattern.
              </p>
              <input
                type="range"
                min="50"
                max="95"
                step="1"
                value={Math.round(config.gradingThresholds.pBeatMin * 100)}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  gradingThresholds: { ...p.gradingThresholds, pBeatMin: Number(e.target.value) / 100 },
                }))}
                className="w-full accent-brass"
              />
              <div className="flex justify-between text-[10px] text-muted">
                <span>50% (Coin Toss)</span>
                <span>80% (Statistically Sound)</span>
                <span>95% (Hard Evidence)</span>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  3s Hook Retention Floor
                </label>
                <span className="text-sm font-bold text-brass">
                  {(config.gradingThresholds.retention3sMin * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-xs text-muted">
                Organic videos must clear this hold rate in testing before the pattern is added to the brand’s Angle Bible.
              </p>
              <input
                type="range"
                min="20"
                max="75"
                step="1"
                value={Math.round(config.gradingThresholds.retention3sMin * 100)}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  gradingThresholds: { ...p.gradingThresholds, retention3sMin: Number(e.target.value) / 100 },
                }))}
                className="w-full accent-brass"
              />
              <div className="flex justify-between text-[10px] text-muted">
                <span>20% (Low)</span>
                <span>45% (Standard Mobile)</span>
                <span>75% (Viral Tier)</span>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-surface/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Perceptual Confidence Floor
                </label>
                <span className="text-sm font-bold text-brass">
                  {(config.gradingThresholds.confidenceMin * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-xs text-muted">
                Minimum computer vision and audio confidence required to accept decoded traits without human review.
              </p>
              <input
                type="range"
                min="40"
                max="95"
                step="1"
                value={Math.round(config.gradingThresholds.confidenceMin * 100)}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  gradingThresholds: { ...p.gradingThresholds, confidenceMin: Number(e.target.value) / 100 },
                }))}
                className="w-full accent-brass"
              />
              <div className="flex justify-between text-[10px] text-muted">
                <span>40% (Loose)</span>
                <span>65% (Standard)</span>
                <span>95% (High Precision)</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-line p-4 bg-surface/40 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-xs font-semibold text-foreground">Auto-Approve High-Confidence Winners</p>
              <p className="text-[11px] text-muted">
                When enabled, concepts with &gt;85% score and zero claim risks bypass manual operator sign-off.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfig((p) => ({
                ...p,
                presetName: "custom",
                gradingThresholds: { ...p.gradingThresholds, autoApproveEnabled: !p.gradingThresholds.autoApproveEnabled },
              }))}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                config.gradingThresholds.autoApproveEnabled
                  ? "bg-emerald-500 text-black shadow-sm"
                  : "bg-surface border border-line text-muted"
              }`}
            >
              {config.gradingThresholds.autoApproveEnabled ? "Enabled" : "Manual Review Required"}
            </button>
          </div>
        </div>
      )}

      {/* Tab 4: System Prompts Editor */}
      {activeTab === "prompts" && (
        <div className="rounded-xl border border-line bg-surface-elevated/70 p-6 space-y-6">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-foreground">
              Factory Stage System Prompts
            </h3>
            <p className="text-xs text-muted">
              Modify the exact cognitive instructions dispatched to LLMs and multimodal agents across each pipeline node.
            </p>
          </div>

          <div className="space-y-5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Brief Synthesis System Prompt
                </label>
                <span className="text-[11px] text-muted">
                  {config.prompts.briefPrompt.length} / 4000 characters
                </span>
              </div>
              <p className="text-[11px] text-muted">
                Directs the creative strategist when turning market observations into brand-specific opportunity briefs.
              </p>
              <textarea
                rows={5}
                value={config.prompts.briefPrompt}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  prompts: { ...p.prompts, briefPrompt: e.target.value },
                }))}
                className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Script & Dialogue Generator Prompt
                </label>
                <span className="text-[11px] text-muted">
                  {config.prompts.scriptPrompt.length} / 4000 characters
                </span>
              </div>
              <p className="text-[11px] text-muted">
                Controls the tone, monologue pacing, text overlays, and hook psychology for short-form scripts.
              </p>
              <textarea
                rows={5}
                value={config.prompts.scriptPrompt}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  prompts: { ...p.prompts, scriptPrompt: e.target.value },
                }))}
                className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Multimodal Perception Prompt
                </label>
                <span className="text-[11px] text-muted">
                  {config.prompts.perceptionPrompt.length} / 4000 characters
                </span>
              </div>
              <p className="text-[11px] text-muted">
                Instructs computer vision and audio prosody models when extracting structural traits from video.
              </p>
              <textarea
                rows={4}
                value={config.prompts.perceptionPrompt}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  prompts: { ...p.prompts, perceptionPrompt: e.target.value },
                }))}
                className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  JEV Cognitive Grading & Policy Prompt
                </label>
                <span className="text-[11px] text-muted">
                  {config.prompts.gradingPrompt.length} / 4000 characters
                </span>
              </div>
              <p className="text-[11px] text-muted">
                Governs claim verification, brand risk rubrics, and transferability assessments.
              </p>
              <textarea
                rows={4}
                value={config.prompts.gradingPrompt}
                onChange={(e) => setConfig((p) => ({
                  ...p,
                  presetName: "custom",
                  prompts: { ...p.prompts, gradingPrompt: e.target.value },
                }))}
                className="w-full rounded-lg border border-line bg-surface p-3 text-xs font-mono text-foreground focus:border-brass focus:outline-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
