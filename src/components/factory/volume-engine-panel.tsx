import { useId } from "react";
import type { PipelineGenerationParams } from "@/lib/meridian/factory/pipeline-config";
import { cn } from "@/lib/cn";
import { ChoiceGroup, EngineStateBadge, NotAppliedNote, SettingSlider } from "./pipeline-controls";
import {
  ASPECT_OPTIONS,
  DAILY_CAP_RANGE,
  DURATION_OPTIONS,
  DURATION_RANGE,
  NOT_READ_REASON,
  PACING_DETAIL,
  PACING_LABEL,
  VIDEO_COUNT_RANGE,
  type EngineRow,
} from "./pipeline-model";

type Pacing = PipelineGenerationParams["renderPacing"];
type Aspect = PipelineGenerationParams["aspectRatio"];

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

const PACING_OPTIONS = (Object.keys(PACING_LABEL) as Pacing[]).map((value) => ({ value, label: PACING_LABEL[value] }));

/**
 * Volume and engine. Every value here is saved on Save. None is read by a job yet. The engine choice is limited to engines
 * the server reports as configured; the rest are shown with the reason they cannot be chosen.
 */
export function VolumeEnginePanel({
  params,
  engines,
  canEdit,
  onChange,
}: {
  params: PipelineGenerationParams;
  engines: EngineRow[];
  canEdit: boolean;
  onChange: (patch: Partial<PipelineGenerationParams>) => void;
}) {
  const engineName = useId();
  const engineHintId = `${engineName}-hint`;
  const capId = useId();
  const selectedEngine = engines.find((row) => row.id === params.provider);
  const durationKnown = (DURATION_OPTIONS as readonly number[]).includes(params.durationSeconds);

  return (
    <div className="space-y-8">
      <ChoiceGroup<number>
        legend="Videos per concept"
        hint="How many variants each winning concept should produce."
        options={range(VIDEO_COUNT_RANGE.min, VIDEO_COUNT_RANGE.max).map((value) => ({
          value,
          label: `${value} ${value === 1 ? "video" : "videos"}`,
        }))}
        value={params.videoCount}
        onChange={(videoCount) => onChange({ videoCount })}
        disabled={!canEdit}
        note={<NotAppliedNote reason={NOT_READ_REASON.videoCount} />}
      />

      <ChoiceGroup<Aspect>
        legend="Aspect ratio"
        hint="One ratio per brand. The server stores a single value."
        options={ASPECT_OPTIONS}
        value={params.aspectRatio}
        onChange={(aspectRatio) => onChange({ aspectRatio })}
        disabled={!canEdit}
        note={<NotAppliedNote reason={NOT_READ_REASON.aspectRatio} />}
      />

      <fieldset disabled className="min-w-0 space-y-2">
        <legend className="text-sm font-semibold text-fg-muted">Several ratios at once</legend>
        <div className="flex flex-wrap gap-2">
          {ASPECT_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-dashed border-border-strong px-3 text-sm text-fg-muted opacity-70 sm:min-h-9"
            >
              <input type="checkbox" disabled className="size-4" />
              {option.value}
            </label>
          ))}
        </div>
        <NotAppliedNote preview reason="The server stores one aspect ratio per brand, so several ratios cannot be saved." />
      </fieldset>

      <ChoiceGroup<number>
        legend="Target duration"
        hint={durationKnown
          ? "Standard length of the timeline."
          : `The saved duration, ${params.durationSeconds} s, is not one of these options. Choosing one replaces it.`}
        options={DURATION_OPTIONS.map((value) => ({ value, label: `${value} s` }))}
        value={params.durationSeconds}
        onChange={(durationSeconds) => onChange({ durationSeconds })}
        disabled={!canEdit}
        note={<NotAppliedNote reason={NOT_READ_REASON.durationSeconds} />}
      />

      <ChoiceGroup<Pacing>
        legend="Cut pacing"
        hint="How quickly the timeline cuts between shots."
        options={PACING_OPTIONS}
        value={params.renderPacing}
        onChange={(renderPacing) => onChange({ renderPacing })}
        disabled={!canEdit}
        note={
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">{PACING_DETAIL[params.renderPacing]}</p>
            <NotAppliedNote reason={NOT_READ_REASON.renderPacing} />
          </div>
        }
      />

      <fieldset disabled={!canEdit} className="min-w-0 space-y-3" aria-describedby={engineHintId}>
        <legend className="text-sm font-semibold text-fg">Render engine</legend>
        <p id={engineHintId} className="text-sm text-fg-muted">
          Only an engine the server reports as configured can be chosen. No engine cost is shown, because the server returns none on this screen.
        </p>
        <div className="space-y-2">
          {engines.map((row) => {
            const id = `${engineName}-${row.id}`;
            const detailId = `${id}-detail`;
            return (
              <div key={row.id} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex min-h-11 flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex min-h-11 flex-1 items-center gap-3 text-sm font-semibold text-fg",
                      row.selectable ? "cursor-pointer" : "cursor-not-allowed text-fg-muted",
                    )}
                  >
                    <input
                      id={id}
                      type="radio"
                      name={engineName}
                      value={row.id}
                      checked={params.provider === row.id}
                      disabled={!row.selectable}
                      aria-describedby={detailId}
                      onChange={() => onChange({ provider: row.id })}
                      className="size-5 accent-accent"
                    />
                    {row.label}
                  </label>
                  <EngineStateBadge state={row.state} label={row.stateLabel} />
                </div>
                <p id={detailId} className="pl-8 text-sm text-fg-muted">
                  {row.description} {row.detail}
                </p>
              </div>
            );
          })}
        </div>
        {selectedEngine && !selectedEngine.selectable ? (
          <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">{selectedEngine.label}</span> is the draft choice, but its state is &quot;{selectedEngine.stateLabel}&quot;. Choose a configured engine to change it.
          </p>
        ) : null}
        <NotAppliedNote reason={NOT_READ_REASON.provider} />
      </fieldset>

      <SettingSlider
        id={capId}
        label="Daily generation cap"
        value={params.dailyGenerationCap}
        min={DAILY_CAP_RANGE.min}
        max={DAILY_CAP_RANGE.max}
        format={(value) => `${value} per day`}
        hint={`Limit on generated videos per day, from ${DAILY_CAP_RANGE.min} to ${DAILY_CAP_RANGE.max}. This is not the spend cap.`}
        disabled={!canEdit}
        onChange={(dailyGenerationCap) => onChange({ dailyGenerationCap })}
        note={<NotAppliedNote reason={NOT_READ_REASON.dailyGenerationCap} />}
      />
    </div>
  );
}
