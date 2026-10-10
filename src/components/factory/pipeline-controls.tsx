import { Fragment, useId, type ReactNode } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { AlertCircle, Check, CheckCircle2, Clock3, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Slider } from "@/components/ui";
import { TechnicalDetails } from "@/components/plain-error";
import type { EngineState } from "./pipeline-model";

export type ChoiceOption<T extends string | number> = { value: T; label: string; disabled?: boolean };

/**
 * A single-choice group of chips. Native radio inputs carry the keyboard and screen-reader behaviour. The selected chip
 * also shows a check mark, so the state is not conveyed by colour alone.
 */
export function ChoiceGroup<T extends string | number>({
  legend,
  hint,
  options,
  value,
  onChange,
  disabled = false,
  note,
}: {
  legend: string;
  hint?: string;
  options: readonly ChoiceOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
  note?: ReactNode;
}) {
  const name = useId();
  const hintId = `${name}-hint`;
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2" aria-describedby={hint ? hintId : undefined}>
      <legend className="text-sm font-semibold text-fg">{legend}</legend>
      {hint ? <p id={hintId} className="text-sm text-fg-muted">{hint}</p> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((option, index) => {
          const id = `${name}-${index}`;
          const checked = option.value === value;
          return (
            <Fragment key={String(option.value)}>
              <input
                id={id}
                type="radio"
                name={name}
                value={String(option.value)}
                checked={checked}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-surface-2 peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:font-semibold peer-checked:ring-1 peer-checked:ring-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-55 sm:min-h-9"
              >
                {checked ? <Check aria-hidden="true" className="size-4 text-accent" /> : null}
                {option.label}
              </label>
            </Fragment>
          );
        })}
      </div>
      {note}
    </fieldset>
  );
}

/** A slider in whole units with the value in its label, so the number is read aloud and shown. */
export function SettingSlider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  format,
  hint,
  note,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (value: number) => string;
  hint?: string;
  note?: ReactNode;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Slider
        id={id}
        label={`${label}: ${format(value)}`}
        hint={hint}
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next);
        }}
        className="h-11"
      />
      {note}
    </div>
  );
}

/**
 * An on/off setting. The on or off state is written out as text, and the switch's touch area is 44 px square.
 */
export function SettingSwitch({
  id,
  label,
  hint,
  checked,
  disabled = false,
  onCheckedChange,
  onText,
  offText,
  note,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  onText: string;
  offText: string;
  note?: ReactNode;
}) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <span id={labelId} className="block text-sm font-semibold text-fg">{label}</span>
          <p id={hintId} className="text-sm text-fg-muted">{hint}</p>
        </div>
        <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
          <SwitchPrimitive.Root
            id={id}
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            className="relative h-6 w-11 rounded-full bg-border-strong outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-55"
          >
            <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[22px]" />
          </SwitchPrimitive.Root>
        </label>
      </div>
      <p className="text-sm font-medium text-fg">{checked ? onText : offText}</p>
      {note}
    </div>
  );
}

/** States that the setting is saved but no run uses it, or that it is preview only. The reason is always visible. */
export function NotAppliedNote({ reason, preview = false }: { reason: string; preview?: boolean }) {
  return (
    <p className="flex items-start gap-2 text-sm text-fg-muted">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-semibold text-fg">{preview ? "Preview only, not saved." : "Not applied."}</span> {reason}
      </span>
    </p>
  );
}

const ENGINE_TONE: Record<EngineState, string> = {
  configured: "border-success/40 bg-success-soft text-success",
  not_connected: "border-danger/40 bg-danger-soft text-danger",
  not_verified: "border-warning/40 bg-warning-soft text-warning",
  checking: "border-border bg-surface-2 text-fg-muted",
};

const ENGINE_ICON: Record<EngineState, typeof Info> = {
  configured: CheckCircle2,
  not_connected: AlertCircle,
  not_verified: Info,
  checking: Clock3,
};

export function EngineStateBadge({ state, label }: { state: EngineState; label: string }) {
  const Icon = ENGINE_ICON[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", ENGINE_TONE[state])}>
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}

/** `detail` is the raw text for a failure. It is shown under Details, never above the message. */
export type Feedback = { tone: "success" | "info" | "error"; message: string; detail?: string };

const FEEDBACK_TONE: Record<Feedback["tone"], string> = {
  success: "border-success/40 bg-success-soft text-success",
  info: "border-border-strong bg-surface-2 text-fg",
  error: "border-danger/40 bg-danger-soft text-danger",
};

export function FeedbackLine({ feedback, onDismiss }: { feedback: Feedback | null; onDismiss: () => void }) {
  if (!feedback) return null;
  const Icon = feedback.tone === "error" ? AlertCircle : feedback.tone === "success" ? CheckCircle2 : Info;
  return (
    <div
      role={feedback.tone === "error" ? "alert" : "status"}
      className={cn("flex items-start justify-between gap-3 rounded-md border p-3 text-sm", FEEDBACK_TONE[feedback.tone])}
    >
      <span className="flex items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{feedback.message}{feedback.detail ? <TechnicalDetails>{feedback.detail}</TechnicalDetails> : null}</span>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
