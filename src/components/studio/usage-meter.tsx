import { useId } from "react";
import { Progress } from "@/components/ui";

/**
 * A limit and the usage against it. Usage is passed as a number only when the server reports it. When it does not, the meter
 * states the limit and says usage is not reported, and it draws no bar, so a made-up figure is never shown.
 */
export function UsageMeter({ label, used, limit, unit }: { label: string; used: number | null; limit: number; unit: string }) {
  const id = useId();
  if (used === null) {
    return (
      <div className="space-y-1 text-sm">
        <p id={id} className="font-semibold">{label}</p>
        <p className="text-fg-muted">
          The limit is {limit} {unit}. Current usage is not reported on this screen, so no bar is drawn. The server checks the limit before any provider call.
        </p>
      </div>
    );
  }
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const summary = `${used} of ${limit} ${unit}`;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={id} className="font-semibold">{label}</span>
        <span>{summary}</span>
      </div>
      <Progress value={percent} aria-labelledby={id} aria-valuetext={summary} />
      {used >= limit ? <p className="text-danger">At the limit. New runs are refused until usage drops below it.</p> : null}
    </div>
  );
}
