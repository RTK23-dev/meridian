import { Button, DisabledReason } from "@/components/ui";
import { FACTORY_GRAPH, LEARN_WAITING } from "@/lib/meridian/factory/pipeline";
import { APPROVAL_LABELS, pendingApproval, runStatusLabel } from "@/lib/meridian/factory/approval";
import type { RunSettings } from "@/lib/meridian/factory/run-settings";
import { FORMAT_LABELS, INTENT_DESCRIPTIONS } from "@/lib/meridian/factory/run-builder-model";

/** One run as the Factory screen shows it. Receipt and metric lines are rendered by the page, so this module keeps no board types. */
export type RunListItem = {
  id: string;
  status: string;
  stage: string;
  niche: string;
  error: string;
  settings: RunSettings;
  runSources: Array<{ source: string; state: string; reason: string; items: number }>;
  receiptLines: string[];
  measurementLines: string[];
};

export type RunListActions = {
  canEdit: boolean;
  killSwitchOn: boolean;
  busy: { approve: boolean; startAgain: boolean; checkLearning: boolean };
  onApprove: (runId: string, stage: string) => void;
  onStartAgain: (runId: string) => void;
  onCheckLearning: (runId: string) => void;
};

const AUTOMATION_WORDS: Record<RunSettings["automation"], string> = { manual: "Manual", semi: "Semi", full: "Full" };
const INTENT_WORDS: Record<RunSettings["intent"], string> = { organic: "Organic", ad: "Paid ads", both: "Organic and paid" };

function stageLabelOf(type: string): string {
  return FACTORY_GRAPH.find((spec) => spec.type === type)?.label ?? type;
}

/** The run's settings in one line, in the words the builder uses. */
function settingsLine(settings: RunSettings): string {
  const platforms = settings.platforms.length > 0 ? settings.platforms.join(", ") : "every organic platform";
  return [
    `${AUTOMATION_WORDS[settings.automation]} automation`,
    INTENT_WORDS[settings.intent],
    `formats ${settings.formats.map((format) => FORMAT_LABELS[format]).join(", ")}`,
    `platforms ${platforms}`,
  ].join(" · ");
}

/** Each stage of the graph, marked done, current or not reached. A finished run has every stage done. */
function stageStates(run: RunListItem): Array<{ label: string; state: string }> {
  const current = FACTORY_GRAPH.findIndex((spec) => spec.type === run.stage);
  return FACTORY_GRAPH.map((spec, index) => {
    if (run.status === "succeeded" || (current >= 0 && index < current)) return { label: spec.label, state: "Done" };
    if (index === current) {
      const waiting = pendingApproval(run);
      return { label: spec.label, state: waiting ? "Waiting for you" : run.status === "paused" ? "Stopped here" : "Current" };
    }
    return { label: spec.label, state: "Not reached" };
  });
}

function sourceLine(source: RunListItem["runSources"][number]): string {
  if (source.state === "ok") return `${source.source}: ran, ${source.items} stored`;
  if (source.state === "failed") return `${source.source}: failed. ${source.reason}`;
  return `${source.source}: not connected. ${source.reason}`;
}

/**
 * The runs of the brand, each with its settings, its stage progress, each source's state, its receipts and its measurements, and the
 * controls that act on it. A control is shown only where the run is in the state it acts on; where a person cannot act, the reason is
 * said in words, and where the kill switch stops a restart, the disabled button says so.
 */
export function RunList({ runs, actions }: { runs: RunListItem[]; actions: RunListActions }) {
  if (runs.length === 0) return <p className="text-sm text-muted">No factory runs are stored.</p>;
  return (
    <ul className="space-y-3">
      {runs.map((run) => {
        const waiting = pendingApproval(run);
        return (
          <li key={run.id} className="space-y-3 rounded-md border border-line p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-semibold">{run.niche || "unspecified niche"}</span>
              <span className={waiting ? "font-semibold text-fg" : "text-muted"}>
                {runStatusLabel(run.status)} · {stageLabelOf(run.stage)}
              </span>
            </div>
            <p className="text-muted">{settingsLine(run.settings)}</p>
            <p className="text-xs text-muted">Intent: {INTENT_WORDS[run.settings.intent]}. {INTENT_DESCRIPTIONS[run.settings.intent]}</p>
            {run.error ? <p className="text-muted">{run.error}</p> : null}

            <details>
              <summary className="cursor-pointer font-medium">Run details</summary>
              <div className="mt-3 space-y-3">
                <section className="space-y-1">
                  <h3 className="font-semibold">Stages</h3>
                  <ol className="space-y-0.5">
                    {stageStates(run).map((item) => (
                      <li key={item.label} className="flex justify-between gap-3">
                        <span>{item.label}</span>
                        <span className="text-muted">{item.state}</span>
                      </li>
                    ))}
                  </ol>
                </section>
                <section className="space-y-1">
                  <h3 className="font-semibold">Sources</h3>
                  {run.runSources.length === 0 ? <p className="text-muted">This run has not gathered yet, so no source state is stored.</p> : (
                    <ul className="space-y-0.5">{run.runSources.map((source) => <li key={source.source}>{sourceLine(source)}</li>)}</ul>
                  )}
                </section>
                <section className="space-y-1">
                  <h3 className="font-semibold">Receipts and metrics</h3>
                  {run.receiptLines.length === 0 ? <p className="text-muted">No creative of this run has a receipt yet.</p> : (
                    <ul className="space-y-0.5">{run.receiptLines.map((line, index) => <li key={index}>{line}</li>)}</ul>
                  )}
                  {run.measurementLines.length === 0 ? <p className="text-muted">Not measured yet.</p> : (
                    <ul className="space-y-0.5">{run.measurementLines.map((line, index) => <li key={index}>{line}</li>)}</ul>
                  )}
                </section>
                <p className="text-xs text-muted">Grades and variants are listed for the brand, not per run, on this screen.</p>
              </div>
            </details>

            <div className="flex flex-wrap items-center gap-3">
              {waiting ? (
                actions.canEdit ? (
                  <Button size="sm" variant="secondary" disabled={actions.busy.approve} loading={actions.busy.approve} onClick={() => actions.onApprove(run.id, waiting)}>
                    {APPROVAL_LABELS[waiting]}
                  </Button>
                ) : <p className="text-muted">Only a member can approve this step.</p>
              ) : null}

              {run.status === "paused" ? (
                !actions.canEdit ? <p className="text-muted">Only a member can start a paused run again.</p>
                : actions.killSwitchOn ? (
                  <>
                    <Button size="sm" variant="secondary" disabled aria-describedby={`start-again-reason-${run.id}`}>Start again</Button>
                    <DisabledReason id={`start-again-reason-${run.id}`}>The kill switch is on. Clear it in Live tests before this run starts again.</DisabledReason>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" disabled={actions.busy.startAgain} loading={actions.busy.startAgain} onClick={() => actions.onStartAgain(run.id)}>
                    Start again from {stageLabelOf(run.stage)}
                  </Button>
                )
              ) : null}

              {run.status === "running" && run.stage === "factory.learn" ? (
                actions.canEdit ? (
                  <Button size="sm" variant="secondary" disabled={actions.busy.checkLearning} loading={actions.busy.checkLearning} onClick={() => actions.onCheckLearning(run.id)}>
                    Check learning again
                  </Button>
                ) : <p className="text-muted">Only a member can check learning again.</p>
              ) : null}
            </div>
            {run.error === LEARN_WAITING ? <p className="text-xs text-muted">Learning reads the measurement pull, which runs every six hours after a launch.</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
