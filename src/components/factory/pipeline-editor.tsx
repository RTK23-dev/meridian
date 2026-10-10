import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, errorText } from "@/components/ui";
import {
  DEFAULT_GRADING_THRESHOLDS,
  DEFAULT_PROMPTS,
  getPresetConfig,
  type FactoryPipelineConfig,
  type PipelineGenerationParams,
  type PipelineGradingThresholds,
} from "@/lib/meridian/factory/pipeline-config";
import { applyPipelinePreset, savePipelineConfig } from "@/lib/meridian/factory/pipeline-actions";
import { qk, userScopedQueryKey } from "@/lib/query/keys";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { FeedbackLine, type Feedback } from "./pipeline-controls";
import { StageFlow } from "./stage-flow";
import { VolumeEnginePanel } from "./volume-engine-panel";
import { GradingPanel } from "./grading-panel";
import { PromptsPanel } from "./prompts-panel";
import { PresetBar } from "./preset-bar";
import {
  PRESET_LABEL,
  PROMPT_MAX_LENGTH,
  TAB_LABEL,
  configToSave,
  draftProblems,
  engineRows,
  isDirty,
  matchingPresetKey,
  savedConfigOf,
  type EditorTab,
  type EngineSources,
  type PresetKey,
  type PromptKey,
} from "./pipeline-model";

export type SavedState = "loading" | "ready" | "error";

function saveStatusText(input: { savedState: SavedState; dirty: boolean; problemCount: number }): string {
  if (input.savedState === "loading") return "Loading the saved copy.";
  if (input.savedState === "error") return "The saved copy could not be loaded. The fields show defaults, not your saved settings.";
  if (input.problemCount > 0) return "A prompt is empty. Add text or restore the default before saving.";
  if (input.dirty) return "Unsaved changes. Save pipeline stores them for this brand.";
  return "Matches the copy the server returned.";
}

/**
 * Factory pipeline editor. The draft is the only thing edited. Two server calls write: savePipelineConfig (Save pipeline)
 * and applyPipelinePreset (Save preset). Filling a preset or restoring defaults only changes the draft.
 *
 * Nothing on this page is read by a factory job yet. The copy says so next to each control. The only run settings that
 * apply are the autopilot level and spend caps on the Live tests tab.
 */
export function PipelineEditor({
  brandId,
  initialConfig,
  canEdit = false,
  savedState = "ready",
  currentLevel = 0,
  engineSources,
}: {
  brandId: string;
  initialConfig?: FactoryPipelineConfig;
  canEdit?: boolean;
  savedState?: SavedState;
  currentLevel?: number;
  engineSources: EngineSources;
}) {
  const qc = useQueryClient();
  const { user } = useCurrentUserState();
  const saved = useMemo(() => savedConfigOf(initialConfig), [initialConfig]);
  const [draft, setDraft] = useState<FactoryPipelineConfig>(saved);
  const lastSaved = useRef(saved);
  const [tab, setTab] = useState<EditorTab>("flow");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Adopt a new server copy unless the draft holds edits that are not saved yet.
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setDraft((current) => (isDirty(current, previous) ? current : saved));
  }, [saved]);

  const dirty = isDirty(draft, saved);
  const problems = draftProblems(draft);
  const engines = engineRows(engineSources);
  const matchKey = matchingPresetKey(draft);

  const refreshSaved = () => {
    void qc.invalidateQueries({ queryKey: userScopedQueryKey(user?.id, qk.pipelineConfig(brandId)) });
  };

  const patchGeneration = (patch: Partial<PipelineGenerationParams>) =>
    setDraft((current) => ({ ...current, generationParams: { ...current.generationParams, ...patch } }));
  const patchGrading = (patch: Partial<PipelineGradingThresholds>) =>
    setDraft((current) => ({ ...current, gradingThresholds: { ...current.gradingThresholds, ...patch } }));
  const setPrompt = (key: PromptKey, value: string) =>
    setDraft((current) => ({ ...current, prompts: { ...current.prompts, [key]: value.slice(0, PROMPT_MAX_LENGTH) } }));

  const fillPreset = (key: PresetKey) => {
    setDraft(getPresetConfig(key));
    setFeedback({
      tone: "info",
      message: `Draft filled from ${PRESET_LABEL[key]}. Nothing is saved yet. Save pipeline stores it for this brand. Factory runs do not read it yet.`,
    });
  };

  const savePreset = async (key: PresetKey) => {
    if (!canEdit) return;
    setBusy(`preset:${key}`);
    setFeedback(null);
    try {
      await applyPipelinePreset({ data: { brandId, presetName: key } });
      refreshSaved();
      setDraft(getPresetConfig(key));
      setFeedback({ tone: "success", message: `${PRESET_LABEL[key]} is saved to this brand. Factory runs do not read it yet.` });
    } catch (error) {
      setFeedback({ tone: "error", message: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!canEdit || !dirty || problems.length > 0) return;
    setBusy("save");
    setFeedback(null);
    try {
      await savePipelineConfig({ data: { brandId, config: configToSave(draft) } });
      refreshSaved();
      setFeedback({ tone: "success", message: "Saved to this brand. Factory runs do not read these settings yet." });
    } catch (error) {
      setFeedback({ tone: "error", message: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const discard = () => {
    setDraft(saved);
    setFeedback(null);
  };

  const restorePrompts = () => {
    setDraft((current) => ({ ...current, prompts: { ...DEFAULT_PROMPTS } }));
    setFeedback({ tone: "info", message: "Default prompt text is in the draft. Nothing is saved yet." });
  };

  const restoreGrading = () => {
    setDraft((current) => ({ ...current, gradingThresholds: { ...DEFAULT_GRADING_THRESHOLDS } }));
    setFeedback({ tone: "info", message: "Default grading values are in the draft. Nothing is saved yet." });
  };

  const statusText = saveStatusText({ savedState, dirty, problemCount: problems.length });
  const saveBlocked = busy !== null || !dirty || problems.length > 0;

  return (
    <section aria-labelledby="factory-pipeline-settings" className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-brass">Factory line</p>
        <h2 id="factory-pipeline-settings" className="font-display text-2xl text-fg">Pipeline settings</h2>
        <p className="max-w-3xl text-sm text-fg-muted">
          Settings save to this brand. Factory runs read the autopilot level and spend caps on the Live tests tab. They do not read the values on this page yet.
        </p>
      </header>

      <PresetBar canEdit={canEdit} busy={busy} matchKey={matchKey} onFill={fillPreset} onSave={(key) => void savePreset(key)} />

      <FeedbackLine feedback={feedback} onDismiss={() => setFeedback(null)} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4">
        <p aria-live="polite" className="text-sm text-fg">{statusText}</p>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && dirty ? (
            <Button type="button" variant="quiet" size="sm" onClick={discard} disabled={busy !== null}>
              Discard changes
            </Button>
          ) : null}
          {canEdit ? (
            <Button type="button" onClick={() => void save()} disabled={saveBlocked}>
              {busy === "save" ? "Saving" : "Save pipeline"}
            </Button>
          ) : (
            <p className="text-sm text-fg-muted">Only members can change these settings.</p>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as EditorTab)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:flex sm:w-auto">
          {(Object.keys(TAB_LABEL) as EditorTab[]).map((value) => (
            <TabsTrigger key={value} value={value} className="min-h-11 px-3 text-sm sm:min-h-10">
              {TAB_LABEL[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="flow" className="pt-6">
          <StageFlow stages={draft.stages} level={currentLevel} onOpenTab={setTab} />
        </TabsContent>

        <TabsContent value="volume" className="pt-6">
          <VolumeEnginePanel
            params={draft.generationParams}
            engines={engines}
            canEdit={canEdit}
            onChange={patchGeneration}
          />
        </TabsContent>

        <TabsContent value="grading" className="pt-6">
          <GradingPanel
            thresholds={draft.gradingThresholds}
            canEdit={canEdit}
            onChange={patchGrading}
            onRestoreDefaults={restoreGrading}
          />
        </TabsContent>

        <TabsContent value="prompts" className="pt-6">
          <PromptsPanel
            prompts={draft.prompts}
            problems={problems}
            canEdit={canEdit}
            onChange={setPrompt}
            onRestoreDefaults={restorePrompts}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
