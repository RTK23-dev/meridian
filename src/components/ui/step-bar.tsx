import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { cn } from "./cn";

export type StepBarStep = { id: string; label: string; state: "done" | "current" | "todo"; to?: string };

/** The steps of a task. A done step is ink and links back when given, the current step is red, and a step not yet reached is muted. */
export function StepBar({ steps, className }: { steps: StepBarStep[]; className?: string }) {
  return <ol aria-label="Steps" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-small", className)}>
    {steps.map((step, index) => <li key={step.id} aria-current={step.state === "current" ? "step" : undefined} className="flex items-center gap-3">
      {index ? <span aria-hidden="true" className="h-px w-6 bg-hairline" /> : null}
      <StepItem step={step} number={index + 1} />
    </li>)}
  </ol>;
}

function StepItem({ step, number }: { step: StepBarStep; number: number }) {
  const content = <>
    {step.state === "done" ? <Check aria-hidden="true" className="size-3.5" /> : <span aria-hidden="true" className="tabular-nums">{number}</span>}
    <span>{step.label}</span>
  </>;
  if (step.state === "done") {
    const done = "inline-flex items-center gap-1.5 font-semibold text-fg";
    return step.to
      ? <Link to={step.to} className={cn(done, "rounded-sharp underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent")}>{content}</Link>
      : <span className={done}>{content}</span>;
  }
  if (step.state === "current") return <span className="inline-flex items-center gap-1.5 font-semibold text-accent-text">{content}</span>;
  return <span className="inline-flex items-center gap-1.5 text-fg-muted">{content}</span>;
}
