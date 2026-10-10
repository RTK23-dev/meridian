import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Slider, Input, errorText } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useWorkspace } from "@/components/workspace";
import { updateWeights } from "@/lib/meridian/api";
import { WEIGHT_KEYS, type ScoreWeights } from "@/lib/meridian/scoring";
import { scoringWeightsSchema, type ScoringWeightsInput } from "@/lib/meridian/schemas/settings";
import { useScopedMutation } from "@/lib/query/hooks";
import { FormError } from "./form-error";
import { plainServerError } from "./form-model";
import {
  WEIGHT_LABELS, WEIGHT_MAX, WEIGHT_MIN, WEIGHT_STEP, defaultWeights, isPenalty, roundToStep,
  sameWeights, weightShares, type WeightKey,
} from "./weights-model";

function textsFrom(weights: ScoreWeights): ScoringWeightsInput {
  return Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(weights[key])])) as ScoringWeightsInput;
}

/**
 * Sliders and text boxes edit one form. The text boxes are checked with the server's own weights schema, as they are on save.
 * A text that is not a number from 0 to 5 is flagged, and the last valid value stays in the preview.
 */
export function WeightsTab({ organizationId, saved, canAdmin }: { organizationId: string; saved: ScoreWeights; canAdmin: boolean }) {
  const { reload } = useWorkspace();
  const form = useForm<ScoringWeightsInput, unknown, ScoreWeights>({
    resolver: zodResolver(scoringWeightsSchema),
    defaultValues: textsFrom(saved),
    // Errors show as the person types, as they always have.
    mode: "onChange",
  });
  const [draft, setDraft] = useState<ScoreWeights>(saved);
  const [discardRequested, setDiscardRequested] = useState(false);
  const savedKey = WEIGHT_KEYS.map((key) => saved[key]).join("|");
  // When the saved weights change (after a save, or when another admin saves), the form and the preview follow them.
  useEffect(() => {
    form.reset(textsFrom(saved));
    setDraft(saved);
    // The form object is stable; only a change in the saved weights should reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const save = useScopedMutation({
    mutationKey: ["mutation", "workspace.weights", organizationId],
    mutationFn: (weights: ScoreWeights) => updateWeights({ data: { organizationId, weights } }),
    success: "Diagnostic weights saved. They do not create opportunities.",
    onSuccess: () => reload(),
  });

  const errors = form.formState.errors;
  const hasErrors = WEIGHT_KEYS.some((key) => errors[key] !== undefined);
  const dirty = hasErrors || !sameWeights(draft, saved);
  const rawError = save.error ? errorText(save.error) : null;
  const shares = weightShares(draft);

  function setWeight(key: WeightKey, value: number) {
    const rounded = roundToStep(value);
    setDraft((current) => ({ ...current, [key]: rounded }));
    form.setValue(key, String(rounded), { shouldDirty: true, shouldValidate: true });
  }

  function setText(key: WeightKey, text: string) {
    form.setValue(key, text, { shouldDirty: true, shouldValidate: true });
    const parsed = scoringWeightsSchema.shape[key].safeParse(text);
    if (parsed.success) setDraft((current) => ({ ...current, [key]: parsed.data }));
  }

  function discardChanges() {
    form.reset(textsFrom(saved));
    setDraft(saved);
    setDiscardRequested(false);
  }

  return (
    <form
      className="space-y-6"
      noValidate
      onKeyDown={(event) => submitOnShortcut(event)}
      onSubmit={form.handleSubmit(() => { void save.mutateAsync(draft).catch(() => undefined); })}
    >
      <UnsavedChangesGuard dirty={dirty && canAdmin} />
      <p className="max-w-2xl text-sm text-fg-muted">
        These weights are not how Meridian finds an opportunity. They only scale a diagnostic score. Learning and evidence still decide the order.
      </p>
      {!canAdmin ? <p className="text-sm text-fg-muted">Only an admin can change these weights. You can read them here.</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <fieldset className="space-y-6">
          <legend className="sr-only">Diagnostic weights, from {WEIGHT_MIN} to {WEIGHT_MAX}</legend>
          {WEIGHT_KEYS.map((key) => {
            const label = WEIGHT_LABELS[key];
            const error = errors[key]?.message ?? null;
            return (
              <div key={key} className="space-y-2">
                <Slider
                  label={label}
                  value={[draft[key]]}
                  min={WEIGHT_MIN}
                  max={WEIGHT_MAX}
                  step={WEIGHT_STEP}
                  disabled={!canAdmin}
                  className="h-11"
                  onValueChange={([value]) => { if (value !== undefined) setWeight(key, value); }}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    aria-label={`${label}, typed value`}
                    inputMode="decimal"
                    autoComplete="off"
                    value={form.watch(key)}
                    disabled={!canAdmin}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${key}-error` : undefined}
                    onChange={(event) => setText(key, event.target.value)}
                    className="w-28"
                  />
                  <span className="text-xs text-fg-muted">{isPenalty(key) ? "Penalty" : "Adds to the score"}</span>
                  {error ? <span id={`${key}-error`} role="alert" className="text-sm text-danger">{error}</span> : null}
                </div>
              </div>
            );
          })}
        </fieldset>

        <aside aria-labelledby="weights-preview-title" className="h-fit space-y-4 rounded-lg border border-border bg-surface p-4">
          <div>
            <h3 id="weights-preview-title" className="text-base font-semibold text-fg">Live preview</h3>
            <p className="mt-1 text-xs text-fg-muted">Each factor’s share of the total weight. Penalties are drawn dashed.</p>
          </div>
          <ul className="space-y-3">
            {shares.map((row) => (
              <li key={row.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-fg">{row.label}</span>
                  <span className="font-semibold text-fg">{Math.round(row.share * 100)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  <div
                    aria-hidden="true"
                    className={row.penalty ? "h-full rounded-full border border-dashed border-border-strong bg-transparent" : "h-full rounded-full bg-accent"}
                    style={{ width: `${Math.round(row.share * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <UnsavedChangesBar
        dirty={dirty}
        subject="scoring weights"
        confirming={discardRequested}
        onConfirmingChange={setDiscardRequested}
        onDiscard={discardChanges}
      />
      {rawError ? <FormError message={plainServerError(rawError, "settings")} raw={rawError} /> : null}
      <div className="flex flex-wrap gap-2">
        {canAdmin ? (
          <Button type="submit" disabled={!dirty || hasErrors || save.isPending}>
            {save.isPending ? "Saving…" : "Save diagnostic weights"}
          </Button>
        ) : null}
        {canAdmin ? (
          <Button type="button" variant="secondary" onClick={() => { const defaults = defaultWeights(); setDraft(defaults); form.reset(textsFrom(defaults)); }}>
            Restore defaults
          </Button>
        ) : null}
      </div>
    </form>
  );
}
