import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input } from "@/components/ui";
import type { NodeEvent, OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { timestampLabel } from "@/components/ops/format";
import { OrchestratorCanvas } from "./orchestrator-canvas";
import { OrchestratorComposer } from "./orchestrator-composer";
import { OrchestratorPolicyPanel } from "./orchestrator-policy-panel";
import {
  actorNameOf,
  approvalHint,
  approvalText,
  approvalsNewestFirst,
  budgetPauseDetail,
  budgetPauseHeading,
  ceilingText,
  describePlanOutcome,
  measuredAverageText,
  parseBudget,
  pauseCategoryOf,
  type PauseCategory,
} from "./orchestrator-presentation";
import { useWorkspace } from "@/components/workspace";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import {
  approveOrchestratorBudget,
  editOrchestratorStep,
  getBrandOrchestratorModel,
  getMeasuredAverageFor,
  getOrchestratorPlan,
  getOrchestratorPolicyFor,
  listBudgetApprovalsFor,
  listOrchestratorPlans,
  planOrchestratorDraft,
  runOrchestratorPlan,
} from "@/lib/meridian/orchestrator/actions";
import { hasRole } from "@/lib/meridian/access";

type PlanSummary = Awaited<ReturnType<typeof listOrchestratorPlans>>["plans"][number];
type PlanDetail = Awaited<ReturnType<typeof getOrchestratorPlan>>;
type Approval = Awaited<ReturnType<typeof listBudgetApprovalsFor>>["approvals"][number];
/** A plan as it is open: its detail and its approvals. The approvals are null when they could not be read, and the reason is kept. */
type OpenPlan = PlanDetail & { approvals: Approval[] | null; approvalsError: string | null };

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
  const { user, isPending } = useCurrentUserState();
  const canAdmin = hasRole(workspace.data?.active?.role ?? "viewer", "admin");
  const brands = (workspace.data?.brands ?? []).map((brand) => ({ id: brand.id, name: brand.name }));
  const members = workspace.data?.members ?? [];
  const [chosenBrand, setChosenBrand] = useState("");
  const brandId = chosenBrand || brands[0]?.id || "";

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpenPlan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The model every new plan uses: the one stored in the Content Factory panel. Null means none is stored yet, or the read failed.
  const [storedModel, setStoredModel] = useState<string | null>(null);
  const [storedModelError, setStoredModelError] = useState<string | null>(null);

  // The workspace's measured average (D15) and its policy, which holds the measure ceiling. The policy panel reads the same key.
  const readable = !isPending && !!user && brandId !== "";
  const measured = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-measured", brandId]),
    queryFn: () => getMeasuredAverageFor({ data: { brandId } }),
    enabled: readable,
  });
  const policy = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-policy", brandId]),
    queryFn: () => getOrchestratorPolicyFor({ data: { brandId } }),
    enabled: readable,
  });

  async function refresh(id = brandId) {
    if (!id) return;
    const listed = await listOrchestratorPlans({ data: { brandId: id } });
    setPlans(listed.plans);
  }

  async function open(planId: string) {
    setSelectedId(planId);
    const found = await getOrchestratorPlan({ data: { brandId, planId } });
    // The approvals are read with the plan. A read that fails is said so; it is never shown as a plan with no approvals.
    const read = await listBudgetApprovalsFor({ data: { brandId, planId } }).then(
      (listed): { approvals: Approval[] | null; approvalsError: string | null } => ({ approvals: listed.approvals, approvalsError: null }),
      (error: unknown): { approvals: Approval[] | null; approvalsError: string | null } => ({
        approvals: null,
        approvalsError: error instanceof Error ? error.message : "The approvals could not be read.",
      }),
    );
    setDetail({ ...found, ...read });
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

  /** Runs a plan. `measure` asks for measure mode for unpriced video (D15): the server accepts it from an admin only. */
  const run = (planId: string, measure: boolean) =>
    act(async () => {
      const outcome = await runOrchestratorPlan({ data: { brandId, planId, measure } });
      if (outcome.status === "not_connected" || outcome.status === "failed") setMessage(catalogState(outcome.status, outcome.reason));
      else if (outcome.status === "not_runnable") setMessage(outcome.reasons.join("; "));
      else if ("spentUsd" in outcome) setMessage(`The run ${outcome.status}. Spend so far: ${(outcome.spentUsd ?? 0).toFixed(4)}.`);
      else setMessage(`The run ${outcome.status}.`);
      await refresh();
      await open(planId);
      // A measured run adds its clips to the workspace's average, so the average is read again.
      await measured.refetch();
    });

  const measuredText = measured.data
    ? measuredAverageText(measured.data)
    : measured.isError
      ? "The measured average could not be read."
      : "Reading the measured average.";

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
        {brandId === "" ? null : (
          <div className="flex flex-col gap-1 text-sm">
            <p>{measuredText}</p>
            <p className="text-xs text-fg-muted">Shown for reference. It never sets a hold.</p>
          </div>
        )}

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
                  <BudgetPause
                    key={detail.plan.id}
                    brandId={brandId}
                    planId={detail.plan.id}
                    budgetUsd={detail.plan.budgetUsd}
                    reason={pauseReasonOf(detail.events)}
                    canAdmin={canAdmin}
                    onApproved={async (text) => {
                      setMessage(text);
                      await refresh();
                      await open(detail.plan.id);
                    }}
                  />
                ) : null}
                <ApprovalList approvals={detail.approvals} error={detail.approvalsError} members={members} />
                {detail.plan.status === "draft" || detail.plan.status === "refused" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => plan(detail.plan.id)} disabled={busy || !canAdmin} aria-describedby={canAdmin ? undefined : "plans-role"}>
                      Plan with {detail.plan.orchestratorModel}
                    </Button>
                  </div>
                ) : null}
                {detail.plan.status === "ready" || detail.plan.status === "paused" || detail.plan.status === "incomplete" || detail.plan.status === "complete" ? (
                  <RunPlanControl
                    key={detail.plan.id}
                    canAdmin={canAdmin}
                    busy={busy}
                    ceilingUsd={policy.data?.policy.measureCeilingUsdPerSecond ?? null}
                    onRun={(measure) => void run(detail.plan.id, measure)}
                  />
                ) : null}
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
 * A plan paused at a budget line (D12): the total line, or a category's (copy, creative or voice). Every viewer sees the alert, its heading names
 * the line, and the run's reason. Only a workspace admin sees the approval control: an approval raises that line, spends nothing, and the run is
 * started again by hand (D11).
 */
function BudgetPause(props: {
  brandId: string;
  planId: string;
  budgetUsd: number;
  reason: string | null;
  canAdmin: boolean;
  onApproved: (message: string) => Promise<void>;
}) {
  const { brandId, planId, budgetUsd, reason, canAdmin, onApproved } = props;
  // The category comes from the pause event's reason: the event has no category field of its own.
  const category = pauseCategoryOf(reason);
  const line = category === null ? "budget" : `${category} budget`;
  return (
    <section role="alert" aria-labelledby={`pause-${planId}`} className="flex flex-col gap-2 rounded-lg border border-warning p-3 text-sm">
      <h3 id={`pause-${planId}`} className="font-semibold">
        {budgetPauseHeading(category)}
      </h3>
      <p>{budgetPauseDetail(reason)}</p>
      {canAdmin ? (
        <BudgetApproval key={category ?? "total"} brandId={brandId} planId={planId} budgetUsd={budgetUsd} category={category} onApproved={onApproved} />
      ) : (
        <p className="text-fg-muted">Only a workspace admin can approve a higher {line}.</p>
      )}
    </section>
  );
}

/**
 * The approval control of a paused plan. The total line approves the plan's budget, and its amount must be above that budget. A category's line
 * approves that category's budget: the category goes next to the amount, and the server checks the amount against that line. A refusal is shown.
 */
function BudgetApproval(props: {
  brandId: string;
  planId: string;
  budgetUsd: number;
  category: PauseCategory | null;
  onApproved: (message: string) => Promise<void>;
}) {
  const { brandId, planId, budgetUsd, category, onApproved } = props;
  const line = category === null ? "budget" : `${category} budget`;
  // The total line starts at the plan's budget. A category's line is not on this screen, so its amount starts blank and the server checks it.
  const [amount, setAmount] = useState(category === null ? budgetUsd.toFixed(2) : "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const value = parseBudget(amount);
  const canApprove = value !== null && (category !== null || value > budgetUsd);

  async function approve() {
    if (value === null || !canApprove) return;
    setSaving(true);
    setProblem(null);
    try {
      // The category goes next to the amount when the pause names one. A total-line approval sends no category, as before.
      const request = category === null ? { brandId, planId, budgetUsd: value } : { brandId, planId, budgetUsd: value, category };
      const outcome = await approveOrchestratorBudget({ data: request });
      if (outcome.status === "refused") setProblem(outcome.reasons.join("; "));
      else await onApproved(`The ${line} is now $${outcome.budgetUsd.toFixed(2)}, up from $${outcome.previousUsd.toFixed(2)}. Run the plan to continue. Approving spent nothing.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : `The ${line} could not be approved.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          id={`approval-amount-${planId}`}
          label={`Approved ${line} (USD)`}
          type="number"
          inputMode="decimal"
          min={0.01}
          max={1000}
          step="0.01"
          className="sm:max-w-40"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={amount.trim() !== "" && value === null ? "Enter a budget from $0.01 to $1,000." : undefined}
        />
        <Button size="sm" onClick={() => void approve()} disabled={saving || !canApprove}>
          Approve this {line}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">{approvalHint({ category, budgetUsd, amount: value })}</p>
      {problem ? (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** Who approved a plan's budget, when, and the budgets: newest first. A read that failed is said so, and an empty list says there are none. */
function ApprovalList(props: { approvals: Approval[] | null; error: string | null; members: ReadonlyArray<{ userId: string; name: string; email: string }> }) {
  const { approvals, error, members } = props;
  return (
    <section aria-labelledby="approvals-heading" className="flex flex-col gap-2 text-sm">
      <h3 id="approvals-heading" className="font-medium">
        Budget approvals
      </h3>
      {error !== null ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : approvals === null ? null : approvals.length === 0 ? (
        <p className="text-fg-muted">No budget has been approved for this plan.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {approvalsNewestFirst(approvals).map((row) => (
            <li key={row.id}>
              <span>{approvalText({ actor: actorNameOf(row.actorId, members), previousUsd: row.previousUsd, approvedUsd: row.approvedUsd })}</span>{" "}
              <time dateTime={row.createdAt} className="text-fg-muted">
                {timestampLabel(row.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The run button of a plan. An admin also sees the choice to measure unpriced video (D15). The choice is off unless it is checked, it says the
 * ceiling is the workspace's, and it is cleared once the run is started, so each measured run is a choice made for that run.
 */
function RunPlanControl(props: { canAdmin: boolean; busy: boolean; ceilingUsd: number | null; onRun: (measure: boolean) => void }) {
  const { canAdmin, busy, ceilingUsd, onRun } = props;
  const [measure, setMeasure] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {canAdmin ? (
        <div className="flex flex-col gap-1 text-sm">
          <label className="inline-flex min-h-11 items-center gap-2 sm:min-h-8">
            <input type="checkbox" className="size-4" checked={measure} disabled={busy} onChange={(event) => setMeasure(event.target.checked)} />
            Measure unpriced video
          </label>
          <p className="text-xs text-fg-muted">
            A video or avatar step with no engine price may run in this run. Its hold is the workspace's ceiling
            {ceilingUsd === null ? ", set in the model policy below" : `, ${ceilingText(ceilingUsd)} of its length, set in the model policy below`}. The
            provider's reported bill replaces the hold when it reports one.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onRun(measure);
            setMeasure(false);
          }}
          disabled={busy || !canAdmin}
          aria-describedby={canAdmin ? undefined : "plans-role"}
        >
          Run the plan
        </Button>
      </div>
    </div>
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
