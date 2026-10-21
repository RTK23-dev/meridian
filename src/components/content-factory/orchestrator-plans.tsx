import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import type { NodeEvent, OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { OrchestratorCanvas } from "./orchestrator-canvas";
import { useWorkspace } from "@/components/workspace";
import {
  createOrchestratorDraft,
  editOrchestratorStep,
  getBrandOrchestratorModel,
  getOrchestratorPlan,
  listOrchestratorPlans,
  planOrchestratorDraft,
  runOrchestratorPlan,
} from "@/lib/meridian/orchestrator/actions";

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

/** A catalog that cannot be read is said plainly. It is never shown as a plan that was made. */
function notConnected(reason: string): string {
  return `NOT CONNECTED. ${reason}`;
}

/**
 * The orchestrator's plans for one brand: the drafts, the plans the chosen model wrote, and their runs. Every action goes through a server
 * function that checks the caller's role. Without a connected OpenRouter key, planning and running say NOT CONNECTED and call nothing.
 */
export function OrchestratorPlans() {
  const workspace = useWorkspace();
  const brands = (workspace.data?.brands ?? []).map((brand) => ({ id: brand.id, name: brand.name }));
  const [chosenBrand, setChosenBrand] = useState("");
  const brandId = chosenBrand || brands[0]?.id || "";

  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState("");
  const [userInputs, setUserInputs] = useState("");
  const [brandSummary, setBrandSummary] = useState("");
  const [budget, setBudget] = useState("2");
  // The model every new plan uses: the one stored in the Content Factory panel. Null means none is stored yet.
  const [storedModel, setStoredModel] = useState<string | null>(null);

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
      .then((stored) => setStoredModel(stored.orchestratorModel))
      .catch(() => setStoredModel(null));
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

  const create = () =>
    act(async () => {
      const created = await createOrchestratorDraft({
        data: { brandId, title, goal, format, userInputs, brandSummary, budgetUsd: Number(budget) },
      });
      setMessage(`Saved the draft "${created.plan.title}". It has not been planned yet.`);
      setTitle("");
      setGoal("");
      setFormat("");
      setUserInputs("");
      await refresh();
      await open(created.plan.id);
    });

  const plan = (planId: string) =>
    act(async () => {
      const outcome = await planOrchestratorDraft({ data: { brandId, planId } });
      if (outcome.status === "not_connected" || outcome.status === "failed") setMessage(notConnected(outcome.reason));
      else if (outcome.status === "refused") setMessage(`The plan was refused: ${outcome.reasons.join("; ")}`);
      else if (outcome.status === "not_planned") setMessage(outcome.reasons.join("; "));
      else setMessage("The plan is ready. Review its steps, then run it.");
      await refresh();
      await open(planId);
    });

  const run = (planId: string) =>
    act(async () => {
      const outcome = await runOrchestratorPlan({ data: { brandId, planId } });
      if (outcome.status === "not_connected" || outcome.status === "failed") setMessage(notConnected(outcome.reason));
      else if (outcome.status === "not_runnable") setMessage(outcome.reasons.join("; "));
      else if ("spentUsd" in outcome) setMessage(`The run ${outcome.status}. Spend so far: ${(outcome.spentUsd ?? 0).toFixed(4)}.`);
      else setMessage(`The run ${outcome.status}.`);
      await refresh();
      await open(planId);
    });

  return (
    <section aria-labelledby="plans-heading" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="plans-heading" className="text-base font-semibold">
          Your plans
        </h2>
        {brands.length > 1 ? (
          <label className="flex flex-col gap-1 text-sm" htmlFor="plan-brand">
            <span>Brand</span>
            <select id="plan-brand" className="rounded border border-border bg-surface px-2 py-1" value={brandId} onChange={(event) => setChosenBrand(event.target.value)}>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

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
            {plans.length === 0 ? <p className="text-sm text-fg-muted">No plans yet. Save a draft to start one.</p> : null}
            <ul className="flex flex-col gap-2">
              {plans.map((summary) => (
                <li key={summary.id}>
                  <button
                    type="button"
                    className={`w-full rounded border px-3 py-2 text-left text-sm ${selectedId === summary.id ? "border-accent" : "border-border"}`}
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

            {detail ? (
              <div className="flex flex-col gap-2 rounded border border-border p-3">
                <p className="text-sm font-medium">{detail.plan.title}</p>
                <p className="text-xs text-fg-muted">
                  {STATUS_WORDS[detail.plan.status] ?? detail.plan.status} · orchestrated by {detail.plan.orchestratorModel}
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
                        {step.estimateUsd === null ? null : <span className="text-fg-muted"> · ${step.estimateUsd.toFixed(4)}</span>}
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
                    {detail.plan.steps.filter((step) => step.model !== null).map((step) => (
                      <StepEdit key={step.id} brandId={brandId} planId={detail.plan.id} step={step} onSaved={async () => { await refresh(); await open(detail.plan.id); }} onMessage={setMessage} />
                    ))}
                  </div>
                ) : null}
                {detail.events.length > 0 ? (
                  <p className="text-xs text-fg-muted">The last run recorded {detail.events.length} events.</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {detail.plan.status === "draft" || detail.plan.status === "refused" ? (
                    <Button size="sm" onClick={() => plan(detail.plan.id)} disabled={busy}>
                      Plan with {detail.plan.orchestratorModel}
                    </Button>
                  ) : null}
                  {detail.plan.status === "ready" || detail.plan.status === "paused" || detail.plan.status === "incomplete" || detail.plan.status === "complete" ? (
                    <Button size="sm" variant="secondary" onClick={() => run(detail.plan.id)} disabled={busy}>
                      Run the plan
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <form
            className="flex flex-col gap-2"
            aria-label="New draft"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <h3 className="text-sm font-semibold">New draft</h3>
            <label className="flex flex-col gap-1 text-sm" htmlFor="plan-title">
              Title
              <input id="plan-title" required maxLength={120} className="rounded border border-border bg-surface px-2 py-1" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm" htmlFor="plan-goal">
              What the video should do
              <input id="plan-goal" required maxLength={2000} className="rounded border border-border bg-surface px-2 py-1" value={goal} onChange={(event) => setGoal(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm" htmlFor="plan-format">
              Format to rebuild or make
              <textarea id="plan-format" required maxLength={4000} rows={3} className="rounded border border-border bg-surface px-2 py-1" value={format} onChange={(event) => setFormat(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm" htmlFor="plan-inputs">
              Your inputs
              <textarea id="plan-inputs" maxLength={4000} rows={2} className="rounded border border-border bg-surface px-2 py-1" value={userInputs} onChange={(event) => setUserInputs(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm" htmlFor="plan-brand-summary">
              About the brand
              <textarea id="plan-brand-summary" maxLength={2000} rows={2} className="rounded border border-border bg-surface px-2 py-1" value={brandSummary} onChange={(event) => setBrandSummary(event.target.value)} />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm" htmlFor="plan-budget">
                Budget (USD)
                <input id="plan-budget" type="number" min={0.01} max={1000} step="0.01" className="w-28 rounded border border-border bg-surface px-2 py-1" value={budget} onChange={(event) => setBudget(event.target.value)} />
              </label>
            </div>
            <p className="text-sm" id="plan-model-stored">
              {storedModel === null ? (
                <span className="text-fg-muted">
                  No orchestrating model is stored for this workspace. Choose one in the <a className="underline" href="/content-factory">Content Factory</a> panel first.
                </span>
              ) : (
                <>Orchestrating model: <code className="font-mono text-sm">{storedModel}</code>, stored in the Content Factory panel. It is checked against the live catalog when the plan is written.</>
              )}
            </p>
            <Button type="submit" size="md" disabled={busy || !title || !goal || !format || storedModel === null}>
              Save draft
            </Button>
          </form>
        </div>
      )}
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
}) {
  const { brandId, planId, step, onSaved, onMessage } = props;
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
      else if (outcome.status === "not_connected" || outcome.status === "failed") onMessage(notConnected(outcome.reason));
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
          <input className="w-24 rounded border border-border bg-surface px-2 py-1" type="number" min={1} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-xs">
        Model
        <input className="w-64 rounded border border-border bg-surface px-2 py-1" value={model} onChange={(event) => setModel(event.target.value)} />
      </label>
      <Button size="sm" variant="secondary" onClick={() => void save()} disabled={saving}>
        Save step
      </Button>
    </div>
  );
}
