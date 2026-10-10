import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, CircleDashed } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { onboardingSummary, type OnboardingStep } from "@/lib/onboarding";

const storageKey = (workspaceId: string) => `meridian-onboarding-dismissed:${workspaceId}`;

const STATE_TEXT = { done: "Done", todo: "To do", unknown: "Unknown" } as const;

/**
 * Setup progress from saved records only. A step whose data did not load says "Unknown" rather than "To do". Each step links to
 * its fix. Dismissal is remembered per workspace; without storage it lasts for this view.
 */
export function SetupChecklist({ workspaceId, steps }: { workspaceId: string; steps: OnboardingStep[] }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(storageKey(workspaceId)) === "true"); }
    catch { setDismissed(false); }
  }, [workspaceId]);
  if (dismissed) return null;
  const summary = onboardingSummary(steps);
  const complete = summary.done === summary.total;
  return (
    <Card aria-labelledby="setup-title" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="setup-title" className="text-section font-semibold">Workspace setup</h2>
          <p className="mt-1 text-sm text-fg-muted">
            {summary.done} of {summary.total} steps have a saved record.
            {summary.unknown > 0 ? ` ${summary.unknown} could not be checked. Their data did not load.` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="quiet"
          size="md"
          className="max-sm:-ml-4"
          onClick={() => {
            try { localStorage.setItem(storageKey(workspaceId), "true"); }
            catch { /* Keep the dismissal for this view when storage is unavailable. */ }
            setDismissed(true);
          }}
        >
          Dismiss checklist
        </Button>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((step) => (
          <li key={step.label}>
            <Link
              to={step.to as never}
              params={step.brandId ? { brandId: step.brandId } as never : undefined}
              className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-accent"
            >
              {step.state === "done"
                ? <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
                : step.state === "unknown"
                  ? <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-warning" />
                  : <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />}
              <span className={step.done ? "text-fg-muted" : "font-medium text-fg"}>{step.label}</span>
              <span className={`ml-auto text-xs font-medium ${step.state === "done" ? "text-success" : step.state === "unknown" ? "text-warning" : "text-fg-muted"}`}>{STATE_TEXT[step.state]}</span>
            </Link>
          </li>
        ))}
      </ol>
      {complete ? <p className="text-sm text-success">Each setup step has a matching stored record.</p> : null}
    </Card>
  );
}
