import { useState } from "react";
import { Button, Slider, TextInput, errorText } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { updateWeights } from "@/lib/meridian/api";
import { WEIGHT_KEYS, type ScoreWeights } from "@/lib/meridian/scoring";
import { useScopedMutation } from "@/lib/query/hooks";
import { FormError } from "./form-error";
import { plainServerError } from "./form-model";
import {
  WEIGHT_LABELS, WEIGHT_MAX, WEIGHT_MIN, WEIGHT_STEP, defaultWeights, isPenalty, parseWeightText, roundToStep,
  sameWeights, weightShares, type WeightKey,
} from "./weights-model";

function textsFrom(weights: ScoreWeights): Record<WeightKey, string> {
  return Object.fromEntries(WEIGHT_KEYS.map((key) => [key, String(weights[key])])) as Record<WeightKey, string>;
}

/** Sliders and text boxes edit one draft. Text that is not a number from 0 to 5 is flagged, and the last valid value stays in the preview. */
export function WeightsTab({ organizationId, saved, canAdmin }: { organizationId: string; saved: ScoreWeights; canAdmin: boolean }) {
  const { reload } = useWorkspace();
  const [draft, setDraft] = useState<ScoreWeights>(saved);
  const [texts, setTexts] = useState<Record<WeightKey, string>>(() => textsFrom(saved));
  const savedKey = WEIGHT_KEYS.map((key) => saved[key]).join("|");
  const [lastSavedKey, setLastSavedKey] = useState(savedKey);
  // When the saved weights change (after a save, or when another admin saves), the draft follows them.
  if (savedKey !== lastSavedKey) {
    setLastSavedKey(savedKey);
    setDraft(saved);
    setTexts(textsFrom(saved));
  }

  const save = useScopedMutation({
    mutationKey: ["mutation", "workspace.weights", organizationId],
    mutationFn: (weights: ScoreWeights) => updateWeights({ data: { organizationId, weights } }),
    success: "Diagnostic weights saved. They do not create opportunities.",
    onSuccess: () => reload(),
  });

  const errors = Object.fromEntries(WEIGHT_KEYS.map((key) => {
    const parsed = parseWeightText(texts[key]);
    return [key, parsed.ok ? null : parsed.reason];
  })) as Record<WeightKey, string | null>;
  const hasErrors = WEIGHT_KEYS.some((key) => errors[key] !== null);
  const dirty = hasErrors || !sameWeights(draft, saved);
  const rawError = save.error ? errorText(save.error) : null;
  const shares = weightShares(draft);

  function setWeight(key: WeightKey, value: number) {
    const rounded = roundToStep(value);
    setDraft((current) => ({ ...current, [key]: rounded }));
    setTexts((current) => ({ ...current, [key]: String(rounded) }));
  }

  function setText(key: WeightKey, text: string) {
    setTexts((current) => ({ ...current, [key]: text }));
    const parsed = parseWeightText(text);
    if (parsed.ok) setDraft((current) => ({ ...current, [key]: parsed.value }));
  }

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-fg-muted">
        These weights are not how Meridian finds an opportunity. They only scale a diagnostic score. Learning and evidence still decide the order.
      </p>
      {!canAdmin ? <p className="text-sm text-fg-muted">Only an admin can change these weights. You can read them here.</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <fieldset className="space-y-6">
          <legend className="sr-only">Diagnostic weights, from {WEIGHT_MIN} to {WEIGHT_MAX}</legend>
          {WEIGHT_KEYS.map((key) => {
            const label = WEIGHT_LABELS[key];
            const error = errors[key];
            return (
              <div key={key} className="space-y-2">
                <Slider
                  label={label}
                  value={[draft[key]]}
                  min={WEIGHT_MIN}
                  max={WEIGHT_MAX}
                  step={WEIGHT_STEP}
                  disabled={!canAdmin}
                  onValueChange={([value]) => { if (value !== undefined) setWeight(key, value); }}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <TextInput
                    aria-label={`${label}, typed value`}
                    inputMode="decimal"
                    autoComplete="off"
                    value={texts[key]}
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

      {rawError ? <FormError message={plainServerError(rawError, "settings")} raw={rawError} /> : null}
      <div className="flex flex-wrap gap-2">
        {canAdmin ? (
          <Button type="button" disabled={!dirty || hasErrors || save.isPending} onClick={() => { void save.mutateAsync(draft).catch(() => undefined); }}>
            {save.isPending ? "Saving…" : "Save diagnostic weights"}
          </Button>
        ) : null}
        {dirty ? <Button type="button" variant="quiet" onClick={() => { setDraft(saved); setTexts(textsFrom(saved)); }}>Reset to saved</Button> : null}
        {canAdmin ? (
          <Button type="button" variant="secondary" onClick={() => { const defaults = defaultWeights(); setDraft(defaults); setTexts(textsFrom(defaults)); }}>
            Restore defaults
          </Button>
        ) : null}
      </div>
    </div>
  );
}
