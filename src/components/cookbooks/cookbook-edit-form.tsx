// The cookbook editor's form (round 3, K20b3b part 2c, K20d): the control defaults, the instruction texts, and the step names and settings of one cookbook. Save computes the
// changed values, applies the edit rules, and runs the save plan through the server: a built-in is copied first, and the server checks the
// whole cookbook again. Nothing is reported as saved unless the server accepted it.

import { useState } from "react";
import { Button, toast } from "@/components/ui";
import { forkCookbookAction, saveCookbookAction } from "@/lib/meridian/cookbooks/actions";
import type { Control, ControlValue, Scalar } from "@/lib/meridian/cookbooks/controls";
import type { Cookbook } from "@/lib/meridian/cookbooks/schema";
import { applyEdits, COPY_PREFIX, editsFromDraft, fieldProblemsOf, planSave, runSavePlan, type CookbookDraft } from "./edit-model";

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

  // Each refused field is marked next to it (K20e). While any is marked, Save sends nothing.
  const problems = fieldProblemsOf(cookbook, { values, texts, steps });

  const save = async () => {
    if (Object.keys(problems).length > 0) {
      setError("Fix the fields marked in red before saving.");
      return;
    }
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
      const plan = planSave({ source, original: cookbook, edited: applied.cookbook, newCopyId: `${COPY_PREFIX}${Date.now().toString(36)}` });
      const outcome = await runSavePlan(brandId, plan, {
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
        <legend className="text-sm font-semibold text-fg-primary">Settings</legend>
        {cookbook.controls.map((control) => (
          <div key={control.id} className="space-y-1">
            <ControlField
              control={control}
              value={values[control.id] ?? control.default}
              onChange={(value) => setValues((current) => ({ ...current, [control.id]: value }))}
            />
            <FieldProblem problem={problems[`control:${control.id}`]} />
          </div>
        ))}
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-fg-primary">Instructions</legend>
        {cookbook.instructions.map((instruction, index) => (
          <div key={index} className="space-y-1">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-secondary">Instruction for {instruction.role}</span>
              <textarea
                className="rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary"
                rows={3}
                maxLength={4000}
                value={texts[index] ?? ""}
                onChange={(event) => setTexts((current) => current.map((item, position) => (position === index ? event.target.value : item)))}
              />
            </label>
            <FieldProblem problem={problems[`instruction:${index}`]} />
          </div>
        ))}
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-fg-primary">Steps</legend>
        {cookbook.steps.map((step, index) => (
          <div key={step.id} className="space-y-3 rounded-sharp border border-hairline p-3">
            <div className="space-y-1">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-fg-secondary">Step name</span>
                <input
                  type="text"
                  maxLength={80}
                  className="rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary"
                  value={steps[index]?.label ?? step.label}
                  onChange={(event) => setSteps((current) => current.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))}
                />
              </label>
              <FieldProblem problem={problems[`step-label:${index}`]} />
            </div>
            {Object.entries(step.params).map(([key, original]) => (
              <div key={key} className="space-y-1">
                <StepSettingField
                  name={key}
                  value={steps[index]?.params[key] ?? original}
                  onChange={(value) =>
                    setSteps((current) => current.map((item, position) => (position === index ? { ...item, params: { ...item.params, [key]: value } } : item)))
                  }
                />
                <FieldProblem problem={problems[`step-param:${index}:${key}`]} />
              </div>
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

/** The reason a field is refused, shown under the field in the error colour. Nothing is shown for a field that is allowed. */
function FieldProblem({ problem }: { problem: string | undefined }) {
  if (problem === undefined) return null;
  return <p className="text-sm text-danger">{problem}</p>;
}

/** One setting of a step, shown by its kind: a checkbox, a number box or a text box. The name is the setting's key, with spaces for underscores. */
function StepSettingField({ name, value, onChange }: { name: string; value: Scalar; onChange: (value: Scalar) => void }) {
  const label = name.replace(/_/g, " ");
  if (typeof value === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-fg-primary">
        <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
    );
  }
  if (typeof value === "number") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-secondary">{label}</span>
        <input type="number" step="any" className="w-32 rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary" value={value} onChange={(event) => onChange(Number(event.target.value))} />
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-fg-secondary">{label}</span>
      <input type="text" maxLength={2000} className="rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ControlField({ control, value, onChange }: { control: Control; value: ControlValue; onChange: (value: ControlValue) => void }) {
  if (control.kind === "toggle") {
    return (
      <label className="flex items-center gap-2 text-sm text-fg-primary">
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
          className="w-32 rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary"
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
        <select className="w-48 rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary" value={String(value)} onChange={(event) => onChange(event.target.value)}>
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
      <input type="text" className="rounded-sharp border border-hairline bg-raised px-3 py-2 text-fg-primary" value={String(value)} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
