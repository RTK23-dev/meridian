import { cn } from "@/lib/cn";
import { BRAIN_SECTION_LABELS } from "@/lib/meridian/brain";
import { CompletenessRing } from "./completeness-ring";
import type { BrainSetupStep } from "./brain-guide";

const STATE_LABEL: Record<BrainSetupStep["state"], string> = {
  done: "Done",
  current: "Up next",
  upcoming: "Waiting",
};

/**
 * The guided start of the brain. The four required fields are the steps, in the order the form shows them. Each step links
 * to its field, and the next open one is named, so a person never has to work out where to begin.
 */
export function BrainSetupPanel({ steps, requiredFilled, requiredTotal, filled, total, next }: {
  steps: BrainSetupStep[];
  requiredFilled: number;
  requiredTotal: number;
  filled: number;
  total: number;
  next: BrainSetupStep | null;
}) {
  const complete = next === null;
  return <section aria-labelledby="brain-setup-title" className="panel space-y-5">
    <div className="flex flex-wrap items-center gap-5">
      <CompletenessRing filled={requiredFilled} total={requiredTotal} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="eyebrow">Set up the brain</p>
        <h2 id="brain-setup-title" className="text-section font-semibold">
          {complete ? "The required fields are done" : `${requiredTotal - requiredFilled} of ${requiredTotal} required fields to go`}
        </h2>
        <p className="text-sm text-fg-muted">
          {filled} of {total} fields have content. Empty fields are not inferred.
        </p>
      </div>
    </div>

    <ol className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
      {steps.map((step, index) => <li key={step.key}>
        <a
          href={`#${step.anchor}`}
          aria-current={step.state === "current" ? "step" : undefined}
          className={cn(
            "flex h-full min-h-11 items-center gap-3 px-3 py-3 text-sm text-fg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            step.state === "current" ? "bg-surface-2" : "bg-surface",
          )}
        >
          <span aria-hidden="true" className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
            step.state === "done" ? "border-success bg-success-soft text-success" : "border-border-strong text-fg-muted",
          )}>{step.state === "done" ? "✓" : index + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block break-words font-semibold">{step.label}</span>
            <span className="block text-xs text-fg-muted">{BRAIN_SECTION_LABELS[step.section]}</span>
          </span>
          <span className={cn("shrink-0 text-xs font-semibold", step.state === "current" ? "text-fg" : "text-fg-muted")}>{STATE_LABEL[step.state]}</span>
        </a>
      </li>)}
    </ol>

    {next ? (
      <p className="text-sm">
        Next: <a href={`#${next.anchor}`} className="font-semibold underline underline-offset-4">write {next.label.toLowerCase()}</a>. The grey text in an empty field is an example. It is not saved.
      </p>
    ) : (
      <p className="text-sm text-fg-muted">Optional fields make briefs more specific. Add them when you have the facts.</p>
    )}
    <p className="text-sm text-fg-muted">
      Have a brand document? Add it under <a href="#brain-assets" className="underline underline-offset-4">Assets</a> and accept the suggestions you agree with.
    </p>
  </section>;
}
