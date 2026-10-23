import { useEffect, useState } from "react";
import { Button, Input } from "@/components/ui";
import type { NodeEvent, OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { OrchestratorCanvas } from "./orchestrator-canvas";
import { OrchestratorComposer } from "./orchestrator-composer";
import { OrchestratorPolicyPanel } from "./orchestrator-policy-panel";
import { describePlanOutcome, parseBudget } from "./orchestrator-presentation";
import { useWorkspace } from "@/components/workspace";
import {
  approveOrchestratorBudget,
  editOrchestratorStep,
  getBrandOrchestratorModel,
  getOrchestratorPlan,
  listOrchestratorPlans,
  planOrchestratorDraft,
  runOrchestratorPlan,
} from "@/lib/meridian/orchestrator/actions";
import { hasRole } from "@/lib/meridian/access";

type PlanSummary = Awaited<ReturnType<typeof listOrchestratorPlans>>["plans"][number];
type PlanDetail = Awaited<ReturnType<typeof getOrchestratorPlan>>;

const STATUS_WORDS: Record<string, string> = {
  draft: "Draft, not planned yet",
  planning: "Planning",
  refused: "Refused",
  ready: "Ready",
  running: "Running",
  paused: "Paused at budget",
  incomplete: "Incomplete",
  complete: "Complete",
};

/** The steps of a stored plan as the canvas draws them. The summary carries every field a plan step has, so this is the same plan. */
function canvasPlanOf(detail: PlanDetail): OrchestratorPlan {
  return {
    version: "orchestrator-plan@1",
    orchestrator: { provider: "openrouter", id: detail.plan.orchestratorModel },
    budgetUsd: detail.plan.budgetUsd,
    nodes: detail.plan.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      title: step.title,
      why: step.why,
      dependsOn: step.dependsOn,
      model: step.model === null ? null : { provider: "openrouter" as const, id: step.model },
      params: step.params,
      estimateUsd: step.estimateUsd,
    })),
  };
}

/** The parameter a paid step's price is set by, and the field the edit action takes for it. */
const EDITABLE_PARAM: Record<string, { name: string; field: "seconds" | "characters" | "maxTokens"; label: string }> = {
  video: { name: "seconds", field: "seconds", label: "Seconds" },
  avatar: { name: "seconds", field: "seconds", label: "Seconds" },
  voice: { name: "characters", field: "characters", label: "Characters" },
  analysis: { name: "max_tokens", field: "maxTokens", label: "Output tokens" },
  script: { name: "max_tokens", field: "maxTokens", label: "Output tokens" },
};

/**
 * A catalog that cannot be read is said plainly, and never shown as a plan that was made. NOT CONNECTED is only for a catalog with no
 * connected key; a read that failed is a read error, with its reason.
 */
function catalogState(status: "not_connected" | "failed", reason: string): string {
  return status === "not_connected" ? `NOT CONNECTED. ${reason}` : `The catalog could not be read: ${reason}`;
}

/**
 * The orchestrator's starting screen and its plans for one brand: the composer first, then the drafts, the plans the chosen model wrote,
 * and their runs. Every action goes through a server function that checks the caller's role. Without a connected OpenRouter key, planning
 * and running say NOT CONNECTED and call nothing.
 */
export function OrchestratorPlans() {
  const workspace = useWorkspace();
  const canAdmin = hasRole(workspace.data?.active?.role ?? "viewer", "admin");
  const brands = (workspace.data?.brands ?? []).map((brand) => ({ id: brand.id, name: brand.name }));
  const [chosenBrand, setChosenBrand] = useState("");
  const brandId = chosenBrand || brands[0]?.id || "";

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The model every new plan uses: the one stored in the Content Factory panel. Null means none is stored yet, or the read failed.
  const [storedModel, setStoredModel] = useState<string | null>(null);
  const [storedModelError, setStoredModelError] = useState<string | null>(null);

  async function refresh(id = brandId) {
    if (!id) return;
    const listed = await listOrchestratorPlans({ data: { brandId: id } });
    setPlans(listed.plans);
  }

  async function open(planId: string) {
    setSelectedId(planId);
    const found = await getOrchestratorPlan({ data: { brandId, planId } });
    setDetail(found);
  }

  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
    refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The plans could not be read."));
    getBrandOrchestratorModel({ data: { brandId } })
      .then((stored) => {
        setStoredModel(stored.orchestratorModel);
        setStoredModelError(null);
      })
      .catch((error: unknown) => {
        // A failed read is not "no model stored": the composer says the read failed.
        setStoredModel(null);
        setStoredModelError(error instanceof Error ? error.message : "The stored model could not be read.");
      });
    // A brand change reads that brand's plans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await run();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  /** A saved draft: the list reloads and the draft opens. The composer shows what planning said. */
  const draftSaved = async (planId: string) => {
    try {
      await refresh();
      await open(planId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The plan could not be read.");
    }
  };

  const plan = (planId: string) =>
    act(async () => {
      const outcome = await planOrchestratorDraft({ data: { brandId, planId } });
      setMessage(describePlanOutcome(outcome).text);
      await refresh();
      await open(planId);
    });

  const run = (planId: string) =>
    act(async () => {
      const outcome = await runOrchestratorPlan({ data: { brandId, planId } });
      if (outcome.status === "not_connected" || outcome.status === "failed") setMessage(catalogState(outcome.status, outcome.reason));
      else if (outcome.status === "not_runnable") setMessage(outcome.reasons.join("; "));
      else if ("spentUsd" in outcome) setMessage(`The run ${outcome.status}. Spend so far: ${(outcome.spentUsd ?? 0).toFixed(4)}.`);
      else setMessage(`The run ${outcome.status}.`);
      await refresh();
      await open(planId);
    });

  return (
    <div className="flex flex-col gap-5">
      <OrchestratorComposer
        brands={brands}
        brandId={brandId}
        onBrandChange={setChosenBrand}
        storedModel={storedModel}
        storedModelError={storedModelError}
        showPreview={plans.length === 0}
        onChanged={draftSaved}
      />

      <section aria-labelledby="plans-heading" className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 sm:p-6">
        <h2 id="plans-heading" className="text-lg font-semibold">
          Your plans
        </h2>
        {canAdmin ? null : <p id="plans-role" className="text-sm text-fg-muted">Only a workspace admin can plan, run or change a plan.</p>}

        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}

        {brands.length === 0 ? (
          <p className="text-sm text-fg-muted">Create a brand first. Its plans are kept for the brand's workspace.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              {plans.length === 0 ? <p className="text-sm text-fg-muted">No plans yet. Plan a run above and it appears here.</p> : null}
              <ul className="flex flex-col gap-2">
                {plans.map((summary) => (
                  <li key={summary.id}>
                    <button
                      type="button"
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedId === summary.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"}`}
                      onClick={() => act(() => open(summary.id))}
                      aria-current={selectedId === summary.id ? "true" : undefined}
                    >
                      <span className="font-medium">{summary.title}</span>
                      <span className="block text-xs text-fg-muted">
                        {STATUS_WORDS[summary.status] ?? summary.status} · budget ${summary.budgetUsd.toFixed(2)}
                        {summary.estimateUsd === null ? "" : ` · estimate $${summary.estimateUsd.toFixed(4)}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {detail ? (
              <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4">
                <p className="text-sm font-medium">{detail.plan.title}</p>
                <p className="text-xs text-fg-muted">
                  {STATUS_WORDS[detail.plan.status] ?? detail.plan.status} · orchestrated by <span className="font-mono">{detail.plan.orchestratorModel}</span>
                </p>
                {detail.plan.reasons.length > 0 ? (
                  <ul role="alert" className="list-disc pl-5 text-sm">
                    {detail.plan.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
                {detail.plan.steps.length > 0 ? (
                  <ol className="flex flex-col gap-1 text-sm">
                    {detail.plan.steps.map((step) => (
                      <li key={step.id}>
                        <span className="font-medium">{step.title}</span>
                        <span className="text-fg-muted"> · {step.model ?? "no model call"}</span>
                        {step.estimateUsd === null ? null : <span className="text-fg-muted tabular-nums"> · ${step.estimateUsd.toFixed(4)}</span>}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {detail.plan.steps.length > 0 ? (
                  <OrchestratorCanvas plan={canvasPlanOf(detail)} events={detail.events as NodeEvent[]} shown={detail.events.length} showAll />
                ) : null}
                {detail.plan.steps.some((step) => EDITABLE_PARAM[step.kind] !== undefined || step.model !== null) && detail.plan.status !== "running" ? (
                  <div className="flex flex-col gap-2 text-sm">
                    <p className="font-medium">Change a step</p>
                    {detail.plan.steps
                      .filter((step) => step.model !== null)
                      .map((step) => (
                        <StepEdit
                          key={step.id}
                          brandId={brandId}
                          planId={detail.plan.id}
                          step={step}
                          canAdmin={canAdmin}
                          onSaved={async () => {
                            await refresh();
                            await open(detail.plan.id);
                          }}
                          onMessage={setMessage}
                        />
                      ))}
                  </div>
                ) : null}
                {detail.events.length > 0 ? <p className="text-xs text-fg-muted">The last run recorded {detail.events.length} events.</p> : null}
                {detail.plan.status === "paused" ? (
                  <BudgetApproval
                    brandId={brandId}
                    planId={detail.plan.id}
                    budgetUsd={detail.plan.budgetUsd}
                    pauseReason={pauseReasonOf(detail.events)}
                    canAdmin={canAdmin}
                    onApproved={async (message) => {
                      setMessage(message);
                      await refresh();
                      await open(detail.plan.id);
                    }}
                  />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {detail.plan.status === "draft" || detail.plan.status === "refused" ? (
                    <Button size="sm" onClick={() => plan(detail.plan.id)} disabled={busy || !canAdmin} aria-describedby={canAdmin ? undefined : "plans-role"}>
                      Plan with {detail.plan.orchestratorModel}
                    </Button>
                  ) : null}
                  {detail.plan.status === "ready" || detail.plan.status === "paused" || detail.plan.status === "incomplete" || detail.plan.status === "complete" ? (
                    <Button size="sm" variant="secondary" onClick={() => run(detail.plan.id)} disabled={busy || !canAdmin} aria-describedby={canAdmin ? undefined : "plans-role"}>
                      Run the plan
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
      {brandId !== "" ? <OrchestratorPolicyPanel brandId={brandId} /> : null}
    </div>
  );
}

/** The reason the latest pause gives, in the run's own words. */
function pauseReasonOf(events: Array<{ state: string; reason: string | null }>): string | null {
  return events.filter((event) => event.state === "paused").at(-1)?.reason ?? null;
}

/**
 * A paused plan waits for an approval of its budget. An admin approves a higher amount, and the run is then started again by hand: the
 * approval spends nothing. The server checks the same rule: the approved amount must be above the budget the plan has now.
 */
function BudgetApproval(props: {
  brandId: string;
  planId: string;
  budgetUsd: number;
  pauseReason: string | null;
  canAdmin: boolean;
  onApproved: (message: string) => Promise<void>;
}) {
  const { brandId, planId, budgetUsd, pauseReason, canAdmin, onApproved } = props;
  const [amount, setAmount] = useState(budgetUsd.toFixed(2));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const value = parseBudget(amount);
  const higher = value !== null && value > budgetUsd;

  async function approve() {
    if (value === null || !higher) return;
    setSaving(true);
    setProblem(null);
    try {
      const outcome = await approveOrchestratorBudget({ data: { brandId, planId, budgetUsd: value } });
      if (outcome.status === "refused") setProblem(outcome.reasons.join("; "));
      else await onApproved(`The budget is now $${outcome.budgetUsd.toFixed(2)}, up from $${outcome.previousUsd.toFixed(2)}. Run the plan to continue. Approving spent nothing.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The budget could not be approved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`approval-${planId}`} className="flex flex-col gap-2 rounded-lg border border-warning p-3 text-sm">
      <h3 id={`approval-${planId}`} className="font-semibold">
        Paused for an approval
      </h3>
      <p className="text-fg-muted">{pauseReason ?? "The next step would take the spend past the budget and its tolerance."}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input
          id={`approval-amount-${planId}`}
          label="Approved budget (USD)"
          type="number"
          inputMode="decimal"
          min={0.01}
          max={1000}
          step="0.01"
          className="sm:max-w-40"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={value === null ? "Enter a budget from $0.01 to $1,000." : undefined}
        />
        <Button size="sm" onClick={() => void approve()} disabled={saving || !canAdmin || !higher} aria-describedby={canAdmin ? undefined : "plans-role"}>
          Approve this budget
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        {higher && value !== null
          ? `Approving $${value.toFixed(2)} raises the budget from $${budgetUsd.toFixed(2)}.`
          : `The run is held to $${budgetUsd.toFixed(2)} and its tolerance. The approved budget must be above it.`}
      </p>
      {problem ? (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** One paid step's edit: its parameter and its model. The engine re-prices the plan; a refused edit changes nothing and says why. */
function StepEdit(props: {
  brandId: string;
  planId: string;
  step: { id: string; kind: string; title: string; model: string | null; params: Record<string, string | number | boolean | null> };
  onSaved: () => Promise<void>;
  onMessage: (message: string) => void;
  canAdmin: boolean;
}) {
  const { brandId, planId, step, onSaved, onMessage, canAdmin } = props;
  const editable = EDITABLE_PARAM[step.kind];
  const current = editable ? step.params[editable.name] : undefined;
  const [value, setValue] = useState(current === undefined || current === null ? "" : String(current));
  const [model, setModel] = useState(step.model ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { brandId, planId, nodeId: step.id };
      if (editable && value !== "") body[editable.field] = Number(value);
      if (model !== (step.model ?? "")) body.modelId = model;
      const outcome = await editOrchestratorStep({ data: body as never });
      if (outcome.status === "refused") onMessage(`The edit would not run: ${outcome.reasons.join("; ")}`);
      else if (outcome.status === "not_connected" || outcome.status === "failed") onMessage(catalogState(outcome.status, outcome.reason));
      else {
        onMessage("The step is saved and the plan is priced again.");
        await onSaved();
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The edit did not work.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <span className="w-48 truncate">{step.title}</span>
      {editable ? (
        <label className="flex flex-col gap-1 text-xs">
          {editable.label}
          <input className="w-24 rounded-md border border-border-strong bg-surface px-2 py-1.5" type="number" min={1} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-xs">
        Model
        <input className="w-64 rounded-md border border-border-strong bg-surface px-2 py-1.5 font-mono" value={model} onChange={(event) => setModel(event.target.value)} />
      </label>
      <Button size="sm" variant="secondary" onClick={() => void save()} disabled={saving || !canAdmin} aria-describedby={canAdmin ? undefined : "plans-role"}>
        Save step
      </Button>
    </div>
  );
}
