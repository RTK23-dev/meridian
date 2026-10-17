import { useId } from "react";
import { DEFAULT_GRADING_THRESHOLDS, type PipelineGradingThresholds } from "@/lib/meridian/factory/pipeline-config";
import { Button, DisabledReason } from "@/components/ui";
import { SettingSlider, SettingSwitch } from "./pipeline-controls";
import {
  GRADING_META,
  GRADING_RANGES,
  NOT_READ_REASON,
  formatPercent,
  fromPercent,
  toPercent,
  type GradingKey,
} from "./pipeline-model";

const SLIDER_KEYS: readonly GradingKey[] = ["winnerScoreMin", "pBeatMin", "retention3sMin", "confidenceMin"];

/** One key at a time, so the update type-checks without casting. */
function gradingPatch(key: GradingKey, value: number): Partial<PipelineGradingThresholds> {
  switch (key) {
    case "winnerScoreMin":
      return { winnerScoreMin: value };
    case "pBeatMin":
      return { pBeatMin: value };
    case "retention3sMin":
      return { retention3sMin: value };
    case "confidenceMin":
      return { confidenceMin: value };
  }
}

/**
 * Winner grading levels. The sliders use the limits the server validator enforces and start at the server defaults. None
 * of these values is read by a job yet, so each control says so next to it.
 */
export function GradingPanel({
  thresholds,
  canEdit,
  onChange,
  onRestoreDefaults,
}: {
  thresholds: PipelineGradingThresholds;
  canEdit: boolean;
  onChange: (patch: Partial<PipelineGradingThresholds>) => void;
  onRestoreDefaults: () => void;
}) {
  const sliderBase = useId();
  const autoId = useId();
  const claimId = useId();

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg-muted">
        These thresholds save to this brand. Pick uses them when a line is saved. A brand with no saved line does not apply them.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {SLIDER_KEYS.map((key) => {
          const range = GRADING_RANGES[key];
          const min = toPercent(range.min);
          const max = toPercent(range.max);
          return (
            <div key={key} className="space-y-3 panel">
              <SettingSlider
                id={`${sliderBase}-${key}`}
                label={GRADING_META[key].label}
                value={toPercent(thresholds[key])}
                min={min}
                max={max}
                format={(value) => `${value}%`}
                hint={`${GRADING_META[key].detail} Default ${formatPercent(DEFAULT_GRADING_THRESHOLDS[key])}. Allowed ${min}% to ${max}%.`}
                disabled={!canEdit}
                onChange={(percent) => onChange(gradingPatch(key, fromPercent(percent)))}
                note={<p className="text-sm text-fg-muted">{NOT_READ_REASON[key]}</p>}
              />
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SettingSwitch
          id={autoId}
          label="Auto-approve high-confidence winners"
          hint="Lets manual mode pass the review step without a person. Publishing still needs the creative to be approved."
          checked={thresholds.autoApproveEnabled}
          disabled={!canEdit}
          onCheckedChange={(autoApproveEnabled) => onChange({ autoApproveEnabled })}
          onText="On"
          offText="Off. Review stays with a person."
          note={<p className="text-sm text-fg-muted">{NOT_READ_REASON.autoApproveEnabled}</p>}
        />
        <SettingSwitch
          id={claimId}
          label="Strict claim gate"
          hint="On, a claim that is not approved blocks the variant. Off, a person reviews it. Banned words still block."
          checked={thresholds.strictClaimGate}
          disabled={!canEdit}
          onCheckedChange={(strictClaimGate) => onChange({ strictClaimGate })}
          onText="On"
          offText="Off"
          note={<p className="text-sm text-fg-muted">{NOT_READ_REASON.strictClaimGate}</p>}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">Restoring defaults only fills the draft. Nothing is saved until you save the pipeline.</p>
        <div className="flex flex-col items-end gap-1">
          <Button type="button" variant="secondary" size="sm" disabled={!canEdit} aria-describedby={canEdit ? undefined : "grading-restore-reason"} onClick={onRestoreDefaults}>
            Restore default grading values
          </Button>
          {canEdit ? null : <DisabledReason id="grading-restore-reason">Only members can change these settings.</DisabledReason>}
        </div>
      </div>
    </div>
  );
}
