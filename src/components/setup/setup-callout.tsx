import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui";
import { currentStep, guideSummary, type GuideStep } from "@/lib/setup/guide";

/**
 * The overview's pointer to the guided setup. It names the step to do now and why, and it disappears once every required step is
 * done, so a finished workspace is not nagged.
 */
export function SetupCallout({ steps }: { steps: GuideStep[] }) {
  const summary = guideSummary(steps);
  if (summary.requiredDone === summary.requiredTotal) return null;
  const next = currentStep(steps);
  return (
    <section aria-labelledby="setup-callout" className="surface-rise flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="eyebrow">Setup</p>
        <h2 id="setup-callout" className="text-section font-semibold text-fg">{summary.headline}</h2>
        {next ? <p className="text-sm text-fg-muted">{next.detail}</p> : null}
      </div>
      <Button asChild className="shrink-0"><Link to="/setup">Continue setup<ArrowRight aria-hidden="true" className="ml-2 size-4" /></Link></Button>
    </section>
  );
}
