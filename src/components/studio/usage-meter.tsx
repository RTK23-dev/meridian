import { useId } from "react";
import { Progress } from "@/components/ui";
import { meterSummary } from "./usage-model.ts";

/**
 * A limit and the usage against it. The count is passed only when the server reported it. When it is missing the meter
 * says "unknown", states the limit, and draws no bar.
 */
export function UsageMeter({ label, used, limit, unit }: { label: string; used: number | null; limit: number; unit: string }) {
  const id = useId();
  const summary = meterSummary(used, limit, unit);
  if (!summary.known) {
    return (
      <div className="space-y-1 text-sm">
        <p id={id} className="font-semibold">{label}</p>
        <p className="text-fg-muted">{summary.line}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={id} className="font-semibold">{label}</span>
        <span>{summary.summary}</span>
      </div>
      <Progress value={summary.percent} aria-labelledby={id} aria-valuetext={summary.summary} />
      {summary.atLimit ? <p className="text-danger">At the limit. New runs are refused until usage drops below it.</p> : null}
    </div>
  );
}
