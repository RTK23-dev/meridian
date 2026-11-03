import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { loadCatalog, type CatalogEntry } from "@/engine/orchestrator/catalog";
import { orchestratorPlanSchema, type NodeEvent, type OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { catalogSnapshotRaw } from "@/engine/orchestrator/fixtures/catalog-snapshot.ts";
import { exampleEvents } from "@/engine/orchestrator/fixtures/example-events.ts";
import { examplePlanRaw } from "@/engine/orchestrator/fixtures/example-plan.ts";
import { editNode, staleSet, type NodeChange } from "@/engine/orchestrator/stale";
import { KIND_CATALOG, PRICING_LIMITS, validatePlan } from "@/engine/orchestrator/validate";
import { OrchestratorCanvas } from "./orchestrator-canvas";
import { OrchestratorPlans } from "./orchestrator-plans";

const STEP_MS = 380;

/** A labelled control. The label sits beside the control, not around it, so option text never becomes part of the label's name. */
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

const basePlan: OrchestratorPlan = orchestratorPlanSchema.parse(examplePlanRaw);
const catalog = loadCatalog(catalogSnapshotRaw).byId;
const events: NodeEvent[] = exampleEvents;

/** The live candidates of one kind, by id. The recording is the catalog this page was built against (see the note on the page). */
function candidatesOf(kind: CatalogEntry["kind"]): CatalogEntry[] {
  return [...catalog.values()].filter((entry) => entry.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The orchestrator's canvas, replaying a recorded example run, with an editor for one step. The run was made from the example plan with
 * stand-in handlers: no model or provider is called. The editor re-prices the plan from the recorded catalog, shows the steps an edit would
 * run again, and shows the reasons when the edit would not run. Nothing here reports a live result.
 */
export function OrchestratorScreen() {
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = events.length;
  const finished = shown >= total;

  const paidSteps = basePlan.nodes.filter((node) => KIND_CATALOG[node.kind] !== undefined);
  const [stepId, setStepId] = useState(paidSteps[0]?.id ?? basePlan.nodes[0]?.id ?? "");
  const [params, setParams] = useState<Record<string, number>>({});
  const [modelId, setModelId] = useState<string | null>(null);
  // The details of one step open as an overlay on the right of the plan, which stays in place underneath.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsHeading = useRef<HTMLHeadingElement>(null);

  const node = basePlan.nodes.find((candidate) => candidate.id === stepId);
  const kind = node ? KIND_CATALOG[node.kind] : undefined;
  const dirty = Object.keys(params).length > 0 || modelId !== null;

  const edited = useMemo(() => {
    if (!node) return basePlan;
    const change: NodeChange = {
      params: { ...node.params, ...params },
      model: modelId === null ? node.model : { provider: "openrouter", id: modelId },
    };
    return editNode(basePlan, stepId, change);
  }, [node, params, modelId, stepId]);

  const checked = useMemo(() => validatePlan(edited, catalog), [edited]);
  const stale = useMemo(() => (dirty ? staleSet(edited, [stepId]) : new Set<string>()), [dirty, edited, stepId]);
  const candidates = useMemo(() => (kind ? candidatesOf(kind) : []), [kind]);

  useEffect(() => {
    if (!playing) return;
    if (shown >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setShown((count) => count + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, shown, total]);

  const restart = () => {
    setShown(0);
    setPlaying(true);
  };

  const chooseStep = (id: string) => {
    setStepId(id);
    setParams({});
    setModelId(null);
  };

  // Choosing a step on the plan opens its details. The heading takes focus, so a keyboard reader lands in the overlay.
  const selectStep = (id: string) => {
    chooseStep(id);
    setDetailsOpen(true);
  };
  useEffect(() => {
    if (detailsOpen) detailsHeading.current?.focus();
  }, [detailsOpen]);

  const numberParam = (name: string, value: string, max: number) => {
    const parsed = Number(value);
    if (value === "" || !Number.isFinite(parsed)) return;
    setParams((current) => ({ ...current, [name]: Math.min(Math.max(parsed, 1), max) }));
  };

  const currentNumber = (name: string) => (node ? (params[name] ?? (typeof node.params[name] === "number" ? (node.params[name] as number) : "")) : "");

  const rerunTitles = basePlan.nodes.filter((candidate) => stale.has(candidate.id)).map((candidate) => candidate.title);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">Orchestrator plan (recorded example)</h1>
        <p className="text-sm text-fg-muted">
          A recorded run of the example plan. No model or provider was called. Costs are the engine's prices from the recorded catalog,
          not charges. Change one step below to see what it would cost and which steps would run again.
        </p>
      </header>

      <OrchestratorPlans />

      <h2 className="text-lg font-semibold">Example run</h2>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="md" onClick={finished ? restart : () => setPlaying(true)} disabled={playing}>
          {finished ? "Replay the run" : shown === 0 ? "Start the replay" : "Continue"}
        </Button>
        <Button size="md" variant="secondary" onClick={restart}>
          Restart
        </Button>
        <span className="text-xs text-fg-muted" aria-live="polite">
          {shown} of {total} events drawn
        </span>
      </div>

      <div className="relative flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-fg-muted">Choose a step on the plan to see its details. The plan keeps its place.</p>
          <Button size="md" variant="secondary" onClick={() => setDetailsOpen(true)} aria-expanded={detailsOpen}>
            Change a step
          </Button>
        </div>

        <OrchestratorCanvas
          plan={checked.ok ? checked.plan : edited}
          events={events}
          shown={shown}
          stale={dirty ? stale : undefined}
          showAll={dirty}
          selectedId={detailsOpen ? stepId : null}
          onSelect={selectStep}
        />

        {detailsOpen ? (
        <aside
          aria-labelledby="edit-heading"
          onKeyDown={(event) => { if (event.key === "Escape") setDetailsOpen(false); }}
          className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[30rem] flex-col gap-3 overflow-y-auto border-l border-border-strong bg-overlay p-4 sm:p-6"
        >
        <div className="flex items-center justify-between gap-3">
          <h2 id="edit-heading" ref={detailsHeading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
            Change one step
          </h2>
          <Button size="sm" variant="secondary" onClick={() => setDetailsOpen(false)}>
            Close
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field id="step-select" label="Step">
            <select id="step-select" className="rounded-sharp border border-hairline bg-raised px-2 py-1" value={stepId} onChange={(event) => chooseStep(event.target.value)}>
              {paidSteps.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </select>
          </Field>

          {kind === "video" && node ? (
            <Field id="seconds-input" label="Seconds"><input
                id="seconds-input"
                type="number"
                min={1}
                max={PRICING_LIMITS.maxSeconds}
                className="w-24 rounded-sharp border border-hairline bg-raised px-2 py-1"
                value={currentNumber("seconds")}
                onChange={(event) => numberParam("seconds", event.target.value, PRICING_LIMITS.maxSeconds)}
              /></Field>
          ) : null}

          {kind === "speech" && node ? (
            <Field id="characters-input" label="Characters"><input
                id="characters-input"
                type="number"
                min={1}
                max={PRICING_LIMITS.maxCharacters}
                className="w-28 rounded-sharp border border-hairline bg-raised px-2 py-1"
                value={currentNumber("characters")}
                onChange={(event) => numberParam("characters", event.target.value, PRICING_LIMITS.maxCharacters)}
              /></Field>
          ) : null}

          {kind === "text" && node ? (
            <Field id="max-tokens-input" label="Output tokens"><input
                id="max-tokens-input"
                type="number"
                min={1}
                max={PRICING_LIMITS.maxOutputTokens}
                className="w-28 rounded-sharp border border-hairline bg-raised px-2 py-1"
                value={currentNumber("max_tokens")}
                onChange={(event) => numberParam("max_tokens", event.target.value, PRICING_LIMITS.maxOutputTokens)}
              /></Field>
          ) : null}

          {kind !== undefined ? (
            <Field id="model-select" label={`Model (${kind}, from the catalog)`}>
              <select
                id="model-select"
                className="max-w-xs rounded-sharp border border-hairline bg-raised px-2 py-1"
                value={modelId ?? node?.model?.id ?? ""}
                onChange={(event) => setModelId(event.target.value)}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-sm text-fg-muted">This step makes no model call, so it has no model or price to change.</p>
          )}

          <Button size="md" variant="secondary" onClick={() => { setParams({}); setModelId(null); }} disabled={!dirty}>
            Reset
          </Button>
        </div>

        {dirty ? (
          checked.ok ? (
            <div className="flex flex-col gap-1 text-sm">
              <p>
                Estimated cost <strong>${checked.plan.nodes.reduce((sum, candidate) => sum + (candidate.estimateUsd ?? 0), 0).toFixed(4)}</strong> of the
                ${basePlan.budgetUsd.toFixed(2)} budget.
              </p>
              <p className="text-fg-muted">
                Runs again: {rerunTitles.length > 0 ? rerunTitles.join("; ") : "nothing"}.
              </p>
            </div>
          ) : (
            <div role="alert" className="flex flex-col gap-1 text-sm">
              <p className="font-medium">This edit would not run:</p>
              <ul className="list-disc pl-5">
                {checked.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <p className="text-sm text-fg-muted">Change a step to see its new cost and which steps would run again.</p>
        )}
        </aside>
        ) : null}
      </div>
    </div>
  );
}
