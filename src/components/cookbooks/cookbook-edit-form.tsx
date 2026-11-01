// The cookbook editor's form (round 3, K20b3b part 2c, K20d): the control defaults, the instruction texts, and the step names and settings of one cookbook. Save computes the
// changed values, applies the edit rules, and runs the save plan through the server: a built-in is copied first, and the server checks the
// whole cookbook again. Nothing is reported as saved unless the server accepted it.

import { useState } from "react";
import { Button, toast } from "@/components/ui";
import { forkCookbookAction, saveCookbookAction } from "@/lib/meridian/cookbooks/actions";
import type { Control, ControlValue, Scalar } from "@/lib/meridian/cookbooks/controls";
import type { Cookbook } from "@/lib/meridian/cookbooks/schema";
import { applyEdits, COPY_PREFIX, editsFromDraft, planSave, runSavePlan, type CookbookDraft } from "./edit-model";

export function CookbookEditForm({
  brandId,
  source,
  cookbook,
  onDone,
}: {
  brandId: string;
  source: "builtin" | "workspace";
  cookbook: Cookbook;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, ControlValue>>(() => Object.fromEntries(cookbook.controls.map((control) => [control.id, control.default])));
  const [texts, setTexts] = useState<string[]>(() => cookbook.instructions.map((instruction) => instruction.text));
  const [steps, setSteps] = useState<CookbookDraft["steps"]>(() => cookbook.steps.map((step) => ({ label: step.label, params: { ...step.params } })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const edits = editsFromDraft(cookbook, { values, texts, steps });
    if (edits.length === 0) {
      onDone();
      return;
    }
    const applied = applyEdits(cookbook, edits);
    if (!applied.ok) {
      setError(applied.reason);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const steps = planSave({ source, original: cookbook, edited: applied.cookbook, newCopyId: `${COPY_PREFIX}${Date.now().toString(36)}` });
      const outcome = await runSavePlan(brandId, steps, {
        fork: async (input) => {
          const made = await forkCookbookAction({ data: input });
          return made.ok ? { ok: true } : { ok: false, reason: made.reason };
        },
        save: async (input) => {
          const saved = await saveCookbookAction({ data: input });
          return saved.ok ? { ok: true } : { ok: false, reason: saved.reason };
        },
      });
      if (outcome.ok) {
        toast.success(source === "builtin" ? "Saved as your copy." : "Saved a new version.");
        onDone();
      } else {
        setError(outcome.reason);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cookbook was not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-5"
      aria-label={`Edit ${cookbook.label}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-fg">Settings</legend>
        {cookbook.controls.map((control) => (
          <ControlField
            key={control.id}
            control={control}
            value={values[control.id] ?? control.default}
            onChange={(value) => setValues((current) => ({ ...current, [control.id]: value }))}
          />
        ))}
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-fg">Instructions</legend>
        {cookbook.instructions.map((instruction, index) => (
          <label key={index} className="flex flex-col gap-1 text-sm">
            <span className="text-fg-secondary">Instruction for {instruction.role}</span>
            <textarea
              className="rounded-md border border-border bg-surface px-3 py-2 text-fg"
              rows={3}
              maxLength={4000}
              value={texts[index] ?? ""}
              onChange={(event) => setTexts((current) => current.map((item, position) => (position === index ? event.target.value : item)))}
            />
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-fg">Steps</legend>
        {cookbook.steps.map((step, index) => (
          <div key={step.id} className="space-y-3 rounded-md border border-border p-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-secondary">Step name</span>
              <input
                type="text"
                maxLength={80}
                className="rounded-md border border-border bg-surface px-3 py-2 text-fg"
                value={steps[index]?.label ?? step.label}
                onChange={(event) => setSteps((current) => current.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))}
              />
            </label>
            {Object.entries(step.params).map(([key, original]) => (
              <StepSettingField
                key={key}
                name={key}
                value={steps[index]?.params[key] ?? original}
                onChange={(value) =>
                  setSteps((current) => current.map((item, position) => (position === index ? { ...item, params: { ...item.params, [key]: value } } : item)))
                }
              />
            ))}
          </div>
        ))}
      </fieldset>
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={busy}>
          {source === "builtin" ? "Save as my copy" : "Save a new version"}
        </Button>
        <Button type="button" variant="quiet" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One setting of a step, shown by its kind: a checkbox, a number box or a text box. The name is the setting's key, with spaces for underscores. */
function StepSettingField({ name, value, onChange }: { name: string; value: Scalar; onChange: (value: Scalar) => void }) {
  const label = name.replace(/_/g, " ");
  if (typeof value === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
    );
  }
  if (typeof value === "number") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-secondary">{label}</span>
        <input type="number" step="any" className="w-32 rounded-md border border-border bg-surface px-3 py-2 text-fg" value={value} onChange={(event) => onChange(Number(event.target.value))} />
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-fg-secondary">{label}</span>
      <input type="text" maxLength={2000} className="rounded-md border border-border bg-surface px-3 py-2 text-fg" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ControlField({ control, value, onChange }: { control: Control; value: ControlValue; onChange: (value: ControlValue) => void }) {
  if (control.kind === "toggle") {
    return (
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        {control.label}
      </label>
    );
  }
  if (control.kind === "slider") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-secondary">{control.label}</span>
        <input
          type="number"
          min={control.min}
          max={control.max}
          step={control.step}
          className="w-32 rounded-md border border-border bg-surface px-3 py-2 text-fg"
          value={typeof value === "number" ? value : control.default}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    );
  }
  if (control.kind === "select") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-secondary">{control.label}</span>
        <select className="w-48 rounded-md border border-border bg-surface px-3 py-2 text-fg" value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {control.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-fg-secondary">{control.label}</span>
      <input type="text" className="rounded-md border border-border bg-surface px-3 py-2 text-fg" value={String(value)} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
