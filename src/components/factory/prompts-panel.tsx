import { useId } from "react";
import type { PipelinePrompts } from "@/lib/meridian/factory/pipeline-config";
import { Button, DisabledReason, Textarea } from "@/components/ui";
import { NotAppliedNote } from "./pipeline-controls";
import {
  NOT_READ_REASON,
  PROMPT_KEYS,
  PROMPT_MAX_LENGTH,
  PROMPT_META,
  type DraftProblem,
  type PromptKey,
} from "./pipeline-model";

/**
 * System prompts. The text is shown only in these fields. Length is capped at the server's limit, because the server cuts
 * longer text without saying so. An empty prompt blocks Save, because the server would swap in the default silently.
 */
export function PromptsPanel({
  prompts,
  problems,
  canEdit,
  onChange,
  onRestoreDefaults,
}: {
  prompts: PipelinePrompts;
  problems: DraftProblem[];
  canEdit: boolean;
  onChange: (key: PromptKey, value: string) => void;
  onRestoreDefaults: () => void;
}) {
  const base = useId();

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-fg-muted">
        Each prompt saves to this brand. No model call reads them yet. No prompt version is stored or returned for these prompts, so none is shown.
      </p>

      {PROMPT_KEYS.map((key) => {
        const value = prompts[key];
        const problem = problems.find((item) => item.key === key);
        const id = `${base}-${key}`;
        return (
          <div key={key} className="space-y-2">
            <Textarea
              id={id}
              label={PROMPT_META[key].label}
              hint={`${PROMPT_META[key].purpose} ${value.length} / ${PROMPT_MAX_LENGTH} characters.`}
              error={problem?.message}
              value={value}
              rows={6}
              maxLength={PROMPT_MAX_LENGTH}
              disabled={!canEdit}
              onChange={(event) => onChange(key, event.currentTarget.value)}
              className="font-mono"
            />
            <NotAppliedNote reason={NOT_READ_REASON.prompt} />
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">Restoring default text only fills the draft. Nothing is saved until you save the pipeline.</p>
        <div className="flex flex-col items-end gap-1">
          <Button type="button" variant="secondary" size="sm" disabled={!canEdit} aria-describedby={canEdit ? undefined : "prompts-restore-reason"} onClick={onRestoreDefaults}>
            Restore default prompt text
          </Button>
          {canEdit ? null : <DisabledReason id="prompts-restore-reason">Only members can change these settings.</DisabledReason>}
        </div>
      </div>
    </div>
  );
}
