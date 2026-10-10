import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleCheck } from "lucide-react";
import { Button, Card } from "@/components/ui";
import type { OnboardingStep } from "@/lib/onboarding";

const storageKey = (workspaceId: string) => `meridian-onboarding-dismissed:${workspaceId}`;

/** Setup progress from saved records only. Dismissal is remembered per workspace; without storage it lasts for this view. */
export function SetupChecklist({ workspaceId, steps }: { workspaceId: string; steps: OnboardingStep[] }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(storageKey(workspaceId)) === "true"); }
    catch { setDismissed(false); }
  }, [workspaceId]);
  if (dismissed) return null;
  const complete = steps.every((step) => step.done);
  return (
    <Card aria-labelledby="setup-title" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="setup-title" className="text-section font-semibold">Workspace setup</h2>
          <p className="mt-1 text-sm text-fg-muted">{steps.filter((step) => step.done).length} of {steps.length} steps have a saved record.</p>
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
              <CircleCheck aria-hidden="true" className={`size-4 shrink-0 ${step.done ? "text-success" : "text-fg-muted"}`} />
              <span className={step.done ? "text-fg-muted" : "font-medium text-fg"}>{step.label}</span>
              {step.done
                ? <span className="ml-auto text-xs font-medium text-success">Done</span>
                : <ArrowRight aria-hidden="true" className="ml-auto size-4 text-fg-muted" />}
            </Link>
          </li>
        ))}
      </ol>
      {complete ? <p className="text-sm text-success">Each setup step has a matching stored record.</p> : null}
    </Card>
  );
}
