import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Input, SelectInput, Textarea } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { createOrchestratorDraft, planOrchestratorDraft } from "@/lib/meridian/orchestrator/actions";
import { cn } from "@/lib/cn";
import { KindIcon } from "./orchestrator-canvas-parts";
import {
  ACCENT,
  COMPOSER_LIMITS,
  EXAMPLE_GOALS,
  KIND_STYLE,
  NODE_KIND_ORDER,
  describePlanOutcome,
  listWords,
  missingFields,
  parseBudget,
  type Notice,
} from "./orchestrator-presentation";

type Brand = { id: string; name: string };

/**
 * The starting screen of the orchestrator: a brief, from which the chosen model writes a plan. "Plan the run" saves the brief as a draft
 * and asks the orchestrating model for the plan. It runs no step. Every refusal and every missing connection is said in words, and a
 * disabled button names what is missing. The orchestrating model is read from the stored setting and is never typed here.
 */
export function OrchestratorComposer({
  brands,
  brandId,
  onBrandChange,
  storedModel,
  storedModelError,
  showPreview,
  onChanged,
}: {
  brands: Brand[];
  brandId: string;
  onBrandChange: (id: string) => void;
  storedModel: string | null;
  /** Why the stored model could not be read. It is said instead of "no model is stored", which would be untrue. */
  storedModelError: string | null;
  /** The step kinds a plan can draw, shown as the composer's preview while there are no plans yet. */
  showPreview: boolean;
  /** Called once a draft is saved, with its id, so the plans list reloads and opens it. */
  onChanged: (planId: string) => Promise<void>;
}) {
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("");
  const [userInputs, setUserInputs] = useState("");
  const [brandSummary, setBrandSummary] = useState("");
  const [budget, setBudget] = useState("2");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const { data: workspace } = useWorkspace();
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");

  const missing = missingFields({ brandId, title, goal, format, budget, storedModel });
  const budgetValue = parseBudget(budget);
  const budgetInvalid = budget.trim() !== "" && budgetValue === null;
  const brand = brands.find((candidate) => candidate.id === brandId);

  async function planTheRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin || missing.length > 0 || budgetValue === null) return;
    setBusy(true);
    setNotice(null);
    let planId: string | null = null;
    try {
      const created = await createOrchestratorDraft({
        data: {
          brandId,
          title: title.trim(),
          goal: goal.trim(),
          format: format.trim(),
          userInputs: userInputs.trim(),
          brandSummary: brandSummary.trim(),
          budgetUsd: budgetValue,
        },
      });
      planId = created.plan.id;
      setGoal("");
      setTitle("");
      setFormat("");
      setUserInputs("");
      const outcome = await planOrchestratorDraft({ data: { brandId, planId } });
      setNotice(describePlanOutcome(outcome));
    } catch (error) {
      setNotice({ tone: "danger", text: error instanceof Error ? error.message : "The run could not be planned." });
    } finally {
      setBusy(false);
      if (planId !== null) await onChanged(planId);
    }
  }

  return (
    <form
      aria-labelledby="composer-heading"
      noValidate
      onSubmit={(event) => void planTheRun(event)}
      className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-4 sm:p-6"
    >
      <header className="flex flex-col gap-2">
        <p className="eyebrow">Orchestrator</p>
        <h2 id="composer-heading" className="text-xl font-semibold tracking-tight">
          {showPreview ? "Plan a run" : "New run"}
        </h2>
        <p className="max-w-2xl text-sm text-fg-muted">
          Describe the video and the material you have. The orchestrating model reads the brief and draws the steps. You see the plan and its
          price before anything runs.
        </p>
        {showPreview ? <KindPreview /> : null}
      </header>

      <div className="grid gap-5">
        {brands.length > 1 ? (
          <Field id="composer-brand-select" label="Brand">
            <SelectInput id="composer-brand-select" value={brandId} onChange={(event) => onBrandChange(event.target.value)} className="sm:max-w-sm">
              {brands.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        ) : (
          <section aria-labelledby="composer-brand-heading" className="flex flex-col gap-1.5">
            <h3 id="composer-brand-heading" className="text-sm font-semibold">
              Brand
            </h3>
            {brands.length === 0 ? (
              <p className="text-sm text-fg-muted">No brand yet. Create a brand first. Its plans are kept for the brand's workspace.</p>
            ) : (
              <p className="text-sm">{brands[0]?.name}</p>
            )}
          </section>
        )}

        <div className="flex flex-col gap-3">
          <Textarea
            id="composer-goal"
            label="Goal"
            required
            rows={4}
            maxLength={COMPOSER_LIMITS.goal}
            placeholder="For example: a 30-second video that shows the product in use, with captions."
            hint={`What the video should do. ${goal.length} of ${COMPOSER_LIMITS.goal} characters.`}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-fg-muted">Start from an example</p>
            <ul className="flex flex-wrap gap-2" aria-label="Example goals">
              {EXAMPLE_GOALS.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => setGoal(example)}
                    className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-3 text-left text-xs text-fg hover:bg-surface-2 sm:min-h-8"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <Input
          id="composer-title"
          label="Title"
          required
          maxLength={COMPOSER_LIMITS.title}
          hint="The name this run has in your plan list."
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />

        <div className="grid gap-5 md:grid-cols-2">
          <Textarea
            id="composer-format"
            label="Format to rebuild or make"
            required
            rows={3}
            maxLength={COMPOSER_LIMITS.format}
            placeholder="For example: 9:16, 20 seconds, three cuts, captions on screen."
            value={format}
            onChange={(event) => setFormat(event.target.value)}
          />
          <Textarea
            id="composer-inputs"
            label="Your inputs"
            rows={3}
            maxLength={COMPOSER_LIMITS.userInputs}
            placeholder="Copy, offers or notes the video must use. Optional."
            value={userInputs}
            onChange={(event) => setUserInputs(event.target.value)}
          />
        </div>

        <Textarea
          id="composer-brand-summary"
          label="About the brand"
          rows={2}
          maxLength={COMPOSER_LIMITS.brandSummary}
          hint={brand ? `Written for ${brand.name}. Optional.` : "Optional."}
          value={brandSummary}
          onChange={(event) => setBrandSummary(event.target.value)}
        />

        <div className="grid gap-5 md:grid-cols-2">
          <Input
            id="composer-budget"
            label="Budget (USD)"
            type="number"
            inputMode="decimal"
            min={0.01}
            max={1000}
            step="0.01"
            className="sm:max-w-40"
            hint="From $0.01 to $1,000. If the planning call would cost more than this, no call is made."
            error={budgetInvalid ? "Enter a budget from $0.01 to $1,000." : undefined}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />

          <section aria-labelledby="composer-model-heading" className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-4">
            <h3 id="composer-model-heading" className="text-sm font-semibold">
              Orchestrating model
            </h3>
            {brandId === "" ? (
              <p className="text-sm text-fg-muted">Create a brand first. Each brand's plans use the orchestrating model stored for it.</p>
            ) : storedModelError !== null ? (
              <p className="text-sm text-danger">The stored model could not be read: {storedModelError}</p>
            ) : storedModel === null ? (
              <p className="text-sm text-warning">No model is stored for this workspace yet.</p>
            ) : (
              <p className="flex flex-col gap-1 text-sm">
                <span className="text-fg-muted">Stored for this workspace:</span>
                <code className="min-w-0 break-all font-mono text-xs text-fg" title={storedModel}>
                  {storedModel}
                </code>
              </p>
            )}
            <p className="text-xs text-fg-muted">
              {storedModel === null ? "Choose one in the " : "Change it in the "}
              <Link to="/content-factory" className="font-medium text-fg underline underline-offset-4 hover:no-underline">
                Content Factory panel
              </Link>
              . It is checked against the live catalog when the plan is written.
            </p>
          </section>
        </div>

        <section aria-labelledby="composer-later-heading" className="flex flex-col gap-2">
          <h3 id="composer-later-heading" className="text-sm font-semibold">
            Not connected yet
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            <li className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <span className="font-medium">Reference files</span>
              <span className="text-fg-muted">Not connected yet. The plan cannot read files you attach here.</span>
            </li>
            <li className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <span className="font-medium">Brand records</span>
              <span className="text-fg-muted">Not connected yet. The summary above is the only brand input for now.</span>
            </li>
          </ul>
        </section>
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm">
          {notice ? (
            <p role={notice.tone === "danger" ? "alert" : "status"} className={cn("mb-2", noticeTone(notice.tone))}>
              {notice.text}
            </p>
          ) : null}
          {!canAdmin ? (
            <p id="composer-role" className="text-fg-muted">
              Only a workspace admin can plan a run.
            </p>
          ) : missing.length > 0 ? (
            <p id="composer-missing" className="text-fg-muted">
              Still needed: {listWords(missing)}.
            </p>
          ) : (
            <p className="text-fg-muted">Saves the draft, then asks the orchestrating model to write the plan. No step runs.</p>
          )}
        </div>
        <Button
          type="submit"
          size="lg"
          loading={busy}
          disabled={busy || !canAdmin || missing.length > 0}
          aria-describedby={!canAdmin ? "composer-role" : missing.length > 0 ? "composer-missing" : undefined}
          className="w-full sm:w-auto"
        >
          {busy ? "Planning the run" : "Plan the run"}
        </Button>
      </div>
    </form>
  );
}

function noticeTone(tone: Notice["tone"]): string {
  if (tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  return "text-danger";
}

/** A labelled control. The label sits above its control and never wraps it, so the control's own text is never part of its name. */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

/** The step kinds a plan can draw. Shown on the empty screen so a first-time reader knows what the orchestrator will build from. */
function KindPreview() {
  return (
    <ul aria-label="Step kinds a plan can draw" className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      {NODE_KIND_ORDER.map((kind) => {
        const style = KIND_STYLE[kind];
        return (
          <li key={kind} className="flex items-start gap-2.5 rounded-lg border border-border p-2.5">
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", ACCENT[style.accent].soft, ACCENT[style.accent].text)}>
              <KindIcon kind={kind} className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{style.label}</span>
              <span className="text-xs text-fg-muted">{style.summary}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
