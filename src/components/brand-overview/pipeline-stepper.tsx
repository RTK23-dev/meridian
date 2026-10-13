import { Link } from "@tanstack/react-router";
import { Circle, CircleCheck, CircleDot, Lock, type LucideIcon } from "lucide-react";
import { doneCount, stageProgressPercent, type PipelineStage, type StageState } from "./pipeline";

const STATE: Record<StageState, { label: string; icon: LucideIcon; tone: string }> = {
  done: { label: "Done", icon: CircleCheck, tone: "text-success" },
  in_progress: { label: "In progress", icon: CircleDot, tone: "text-info" },
  blocked: { label: "Blocked", icon: Lock, tone: "text-warning" },
  not_started: { label: "Not started", icon: Circle, tone: "text-fg-muted" },
};

/** Ten stages from market to learning. Each one links to its screen and names its state in words and in an icon. */
export function PipelineStepper({ brandId, stages }: { brandId: string; stages: PipelineStage[] }) {
  const done = doneCount(stages);
  const percent = stageProgressPercent(stages);
  return (
    <section aria-labelledby="pipeline-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="pipeline-title" className="text-section font-semibold text-fg">Advertising pipeline</h2>
        <p className="text-sm text-fg-muted">{done} of {stages.length} stages done</p>
      </div>
      {/* One thin track above the stages, so progress reads at a glance. The width eases in when a stage changes state. */}
      <div
        role="progressbar"
        aria-label="Pipeline progress"
        aria-valuemin={0}
        aria-valuemax={stages.length}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${stages.length} stages done`}
        className="h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div className="h-full rounded-full bg-fg transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stages.map((stage, index) => {
          const presentation = STATE[stage.state];
          const Icon = presentation.icon;
          // No entrance animation here. The stages arrive with the brand data, and a fade that runs during the UI baseline's
          // accessibility scan lowers the text contrast it measures. The progress track above is the only motion.
          return (
            <li key={stage.key}>
              <Link
                to={stage.to}
                params={{ brandId }}
                className="flex h-full min-h-11 flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xs text-fg-muted">{index + 1}</span>
                  <Icon aria-hidden="true" className={`size-4 shrink-0 ${presentation.tone}`} />
                </span>
                <span className="font-semibold text-fg">{stage.label}</span>
                <span className="text-xs text-fg-muted">
                  {stage.count !== null ? `${stage.count}${stage.unit ? ` ${stage.unit}` : ""}` : "Status only"}
                </span>
                <span className={`mt-auto text-xs font-semibold ${presentation.tone}`}>
                  <span className="sr-only">Status: </span>{presentation.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-fg-muted">Counts are stored records. A stage with a count of 0 has no stored record yet.</p>
    </section>
  );
}
