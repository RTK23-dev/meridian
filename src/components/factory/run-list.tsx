import { Button, DisabledReason } from "@/components/ui";
import { FACTORY_GRAPH, LEARN_WAITING } from "@/lib/meridian/factory/pipeline";
import { APPROVAL_LABELS, pendingApproval, runStatusLabel } from "@/lib/meridian/factory/approval";
import type { RunSettings } from "@/lib/meridian/factory/run-settings";
import { FORMAT_LABELS, INTENT_DESCRIPTIONS } from "@/lib/meridian/factory/run-builder-model";
import { ATTESTATION_WORDING, LICENCE_KINDS, LICENCE_LABELS, type LicenceKind } from "@/lib/meridian/factory/rights-wording";

/** The licences attested for one creative of a variant. Each is the attestation id, or null where that licence is not attested. */
export type RunCreativeLicence = { creativeId: string; music: string | null; footage: string | null };

/** A creative a variant produced, with its receipts and measured rows already in words. */
export type RunCreativeLine = { label: string; receiptLines: string[]; measurementLines: string[]; licence?: RunCreativeLicence };

/** One pick of a run: its concept, its grade as a prediction, its status, its measured outcome, and its variants. */
export type RunPickLine = {
  concept: string;
  /** "Organic", "Paid", or '' when the run learned from no surface. */
  surface: string;
  prediction: string;
  predictionNote: string;
  plan: string;
  /** The measured rows of the creatives this pick produced. Empty until one is measured. */
  measuredLines: string[];
  variants: Array<{ heading: string; gate: string; rightsLine: string | null; creatives: RunCreativeLine[] }>;
};

/** One run as the Factory screen shows it. Receipt and metric lines are rendered by the page, so this module keeps no board types. */
export type RunListItem = {
  id: string;
  status: string;
  stage: string;
  niche: string;
  error: string;
  settings: RunSettings;
  runSources: Array<{ source: string; state: string; reason: string; items: number }>;
  picks: RunPickLine[];
  receiptLines: string[];
  measurementLines: string[];
};

export type RunListActions = {
  canEdit: boolean;
  killSwitchOn: boolean;
  busy: { approve: boolean; startAgain: boolean; checkLearning: boolean; attest: boolean; revoke: boolean };
  onApprove: (runId: string, stage: string) => void;
  onStartAgain: (runId: string) => void;
  onCheckLearning: (runId: string) => void;
  onAttest: (creativeId: string, kind: LicenceKind) => void;
  onRevoke: (attestationId: string) => void;
};

/**
 * The licence controls of one creative. An attested licence can be revoked. A licence that is not attested shows the wording it is
 * attested under, and an attest control. A viewer sees both controls disabled, with the reason.
 */
function LicenceControls({ licence, actions }: { licence: RunCreativeLicence; actions: RunListActions }) {
  return (
    <div className="space-y-1 pt-1">
      {LICENCE_KINDS.map((kind) => {
        const attestationId = licence[kind];
        const label = LICENCE_LABELS[kind];
        const reasonId = `licence-reason-${licence.creativeId}-${kind}`;
        if (attestationId) {
          return (
            <div key={kind} className="space-y-0.5">
              <p>{label} licence attested.</p>
              {actions.canEdit ? (
                <Button size="sm" variant="secondary" disabled={actions.busy.revoke} loading={actions.busy.revoke} onClick={() => actions.onRevoke(attestationId)}>
                  Revoke {label.toLowerCase()} licence
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="secondary" disabled aria-describedby={reasonId}>Revoke {label.toLowerCase()} licence</Button>
                  <DisabledReason id={reasonId}>Only a member can revoke a licence.</DisabledReason>
                </>
              )}
            </div>
          );
        }
        return (
          <div key={kind} className="space-y-0.5">
            <p>{label} licence not attested. Attesting it says: <span className="text-muted">{ATTESTATION_WORDING[kind]}</span></p>
            {actions.canEdit ? (
              <Button size="sm" disabled={actions.busy.attest} loading={actions.busy.attest} onClick={() => actions.onAttest(licence.creativeId, kind)}>
                Attest {label.toLowerCase()} licence
              </Button>
            ) : (
              <>
                <Button size="sm" disabled aria-describedby={reasonId}>Attest {label.toLowerCase()} licence</Button>
                <DisabledReason id={reasonId}>Only a member can attest a licence.</DisabledReason>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

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
                <section className="space-y-2">
                  <h3 className="font-semibold">Grades and variants</h3>
                  <p className="text-xs text-muted">
                    Each pick shows the grade it was made under as a prediction. Its measured rows come from the creatives its variants produced.
                  </p>
                  {run.picks.length === 0 ? <p className="text-muted">This run has no picked concept yet.</p> : (
                    <ul className="space-y-3">
                      {run.picks.map((pick, pickIndex) => (
                        <li key={pickIndex} className="space-y-1 rounded-md border border-line p-2">
                          <p className="font-medium">{pick.concept}{pick.surface ? ` · ${pick.surface}` : ""}</p>
                          <p>{pick.prediction}</p>
                          <p className="text-muted">{pick.predictionNote}</p>
                          <p className="text-muted">{pick.plan}</p>
                          <div className="space-y-0.5">
                            <p className="font-medium">Measured</p>
                            {pick.measuredLines.length === 0 ? <p className="text-muted">Not measured yet, or not reported.</p> : (
                              <ul className="space-y-0.5">{pick.measuredLines.map((line, index) => <li key={index}>{line}</li>)}</ul>
                            )}
                          </div>
                          {pick.variants.length === 0 ? <p className="text-muted">No variant has been made for this pick.</p> : (
                            <ul className="space-y-2">
                              {pick.variants.map((variant, variantIndex) => (
                                <li key={variantIndex} className="space-y-0.5 border-l border-line pl-2">
                                  <p>{variant.heading} <span className="text-muted">· {variant.gate}</span></p>
                                  {variant.rightsLine ? <p className="text-muted">Rights: {variant.rightsLine}</p> : null}
                                  {variant.creatives.length === 0 ? <p className="text-muted">Not produced yet.</p> : variant.creatives.map((creative, creativeIndex) => (
                                    <div key={creativeIndex} className="space-y-0.5">
                                      <p className="text-muted">{creative.label}</p>
                                      {creative.receiptLines.length === 0 ? <p className="text-muted">No receipt yet.</p> : (
                                        <ul className="space-y-0.5">{creative.receiptLines.map((line, index) => <li key={index}>{line}</li>)}</ul>
                                      )}
                                      {creative.measurementLines.length === 0 ? null : (
                                        <ul className="space-y-0.5">{creative.measurementLines.map((line, index) => <li key={index}>{line}</li>)}</ul>
                                      )}
                                      {creative.licence ? <LicenceControls licence={creative.licence} actions={actions} /> : null}
                                    </div>
                                  ))}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
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
