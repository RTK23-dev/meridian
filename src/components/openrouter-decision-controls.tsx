import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button, DisabledReason, Field, SelectInput } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { saveOpenRouterDecisionModel, testOpenRouterDecisionConnection } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useOpenRouterDecisionModelsQuery, useScopedMutation } from "@/lib/query/hooks";

export type OpenRouterModelStatus = {
  model: string;
  source: "workspace" | "deployment" | "default";
  reason?: string;
};

type EligibleModel = {
  id: string;
  name: string;
  canonicalSlug: string | null;
  takes: string[];
  catalogueInputModalities: string[];
  questionKinds: string[];
  contextLength: number;
  promptUsdPerMillionTokens: number;
  callCeilingUsd: number;
};

type CatalogListing =
  | { ok: true; endpoint: string; readAt: string; eligible: EligibleModel[]; notOffered: Array<{ id: string; reason: string }> }
  | { ok: false; reason: string; endpoint: string; readAt: string; eligible: []; notOffered: [] };

const SOURCE_TEXT: Record<OpenRouterModelStatus["source"], string> = {
  workspace: "chosen for this workspace",
  deployment: "set by the deployment (OPENROUTER_DECISIONS_MODEL)",
  default: "the pinned default",
};

type TestResult = { ok: boolean; status: "PASSED" | "FAILED" | "NOT_RUN"; message: string };

/**
 * The OpenRouter decision model and its connection test, shared by Setup and Settings. The model is chosen from the live catalogue's
 * decision models that have a verified profile, so a model cannot be saved by typing its ID. Saving a model changes no active engine,
 * and a saved model is not a passed test. The connection test sends one real request to OpenRouter and may incur model usage. It
 * changes no product data and no active engine, and only admins can run it.
 */
export function OpenRouterDecisionControls({
  organizationId,
  canAdmin,
  model,
}: {
  organizationId: string;
  canAdmin: boolean;
  model: OpenRouterModelStatus;
}) {
  const [draft, setDraft] = useState(model.model);
  const [saved, setSaved] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const catalog = useOpenRouterDecisionModelsQuery(organizationId);
  const listing = (catalog.data as CatalogListing | undefined) ?? null;
  const eligible = listing?.ok ? listing.eligible : [];
  const chosen = eligible.find((entry) => entry.id === draft.trim()) ?? null;
  const save = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.openrouter-model", organizationId],
    mutationFn: async (value: string) => {
      const result = (await saveOpenRouterDecisionModel({ data: { organizationId, model: value } })) as
        | { ok: true; model: string }
        | { ok: false; reason: string };
      // A refused model is thrown, so the reason is shown and the stored model is unchanged.
      if (!result.ok) throw new Error(result.reason);
      return result;
    },
    invalidate: () => [qk.decisionEngines(organizationId), qk.openRouterDecisionModels(organizationId)],
    onSuccess: (result) => {
      setSaved(`The OpenRouter decision model is now ${result.model}. Test the connection before choosing this engine.`);
      setDraft(result.model);
    },
  });
  const runTest = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.openrouter-test", organizationId],
    mutationFn: async () => (await testOpenRouterDecisionConnection({ data: { organizationId } })) as TestResult,
    invalidate: () => [qk.decisionEngines(organizationId)],
    onSuccess: (result) => setTest(result),
  });
  const saveError = save.error ? plainError(save.error) : null;
  const testError = runTest.error ? plainError(runTest.error) : null;
  const blockerText = `${testError?.message ?? ""} ${test?.message ?? ""}`;
  const budgetBlocked = /monthly budget/i.test(blockerText);
  // The ledger refuses a call with this wording before it sends anything. Only claim it when the refusal says so.
  const nothingSent = /nothing was sent/i.test(blockerText);
  const unchanged = draft.trim() === model.model;
  const savable = chosen !== null && !unchanged;

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="font-semibold">OpenRouter decision model</p>
        <p className="text-sm text-muted">
          The model is {SOURCE_TEXT[model.source]}. Only decision models in the live OpenRouter catalogue, with a verified profile, can be chosen.
        </p>
        {model.reason ? <p className="mt-1 text-sm text-warning">{model.reason}</p> : null}
      </div>
      {saveError ? <PlainErrorMessage message={saveError.message} raw={saveError.raw} /> : null}
      {saved ? <p className="text-sm text-success" role="status">{saved}</p> : null}

      {catalog.isPending ? <p className="text-sm text-muted">Reading the OpenRouter model catalogue...</p> : null}
      {listing && !listing.ok ? (
        <p className="text-sm text-warning" role="status">
          {listing.reason} No decision model can be chosen until the catalogue can be read.
        </p>
      ) : null}

      {listing?.ok ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-96">
            <Field label="Decision model" hint={`Read from the OpenRouter catalogue at ${listing.readAt}.`}>
              <SelectInput value={draft} onChange={(event) => { setSaved(null); setDraft(event.target.value); }} disabled={!canAdmin || save.isPending}>
                {!chosen && draft.trim() !== "" ? <option value={draft}>{draft} (not in the live catalogue)</option> : null}
                {eligible.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => { setSaved(null); void save.mutateAsync(draft.trim()).catch(() => undefined); }}
            disabled={!canAdmin || save.isPending || !savable}
            aria-describedby={canAdmin && !savable ? "openrouter-model-unsaved" : undefined}
          >
            {save.isPending ? "Saving..." : "Save model"}
          </Button>
          {canAdmin && !save.isPending && unchanged ? <DisabledReason id="openrouter-model-unsaved">This model is already saved.</DisabledReason> : null}
          {canAdmin && !save.isPending && !unchanged && !chosen ? (
            <DisabledReason id="openrouter-model-unsaved">Choose a model from the list. It must be in the live catalogue with a verified profile.</DisabledReason>
          ) : null}
        </div>
      ) : null}

      {chosen ? (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Name</dt>
            <dd>{chosen.name}</dd>
          </div>
          <div>
            <dt className="text-muted">Takes</dt>
            <dd>{chosen.takes.map((modality) => (modality === "image" ? "images (PNG, JPEG)" : modality)).join(", ")}</dd>
          </div>
          <div>
            <dt className="text-muted">Answers</dt>
            <dd>{chosen.questionKinds.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-muted">Context</dt>
            <dd>{chosen.contextLength.toLocaleString("en-GB")} tokens</dd>
          </div>
          <div>
            <dt className="text-muted">Input price</dt>
            <dd>${chosen.promptUsdPerMillionTokens.toFixed(3)} per million tokens</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted">Most one call can cost</dt>
            <dd>${chosen.callCeilingUsd.toFixed(6)} for a call that fills the whole context, at the input price plus the largest output. A smaller request costs less, and a call whose own bound is above the deployment limit is refused before it is sent.</dd>
          </div>
        </dl>
      ) : null}

      {listing?.ok && listing.notOffered.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Not offered ({listing.notOffered.length})</summary>
          <ul className="mt-2 space-y-1">
            {listing.notOffered.map((item) => (
              <li key={item.id}>
                <span className="font-mono text-xs">{item.id}</span>: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm text-muted">
          Testing the connection sends one real request to OpenRouter and may incur model usage. It changes no product data and no active engine.
        </p>
        {testError ? <PlainErrorMessage message={testError.message} raw={testError.raw} /> : null}
        {budgetBlocked ? (
          <p className="text-sm" role="status">
            <Link to="/settings" hash="monthly-budget" className="font-semibold underline underline-offset-2">Set the monthly budget (USD)</Link>
            , then test again.{nothingSent ? " The budget check ran before any request, so nothing was sent to OpenRouter and nothing was spent." : ""}
          </p>
        ) : null}
        {test ? (
          <p className={`text-sm ${test.status === "PASSED" ? "text-success" : "text-warning"}`} role="status">
            {test.status === "PASSED" ? "Passed. " : test.status === "FAILED" ? "Failed. " : "Not run. "}
            {test.message}
          </p>
        ) : null}
        <Button type="button" variant="secondary" onClick={() => { setTest(null); void runTest.mutateAsync().catch(() => undefined); }} disabled={!canAdmin || runTest.isPending}>
          {runTest.isPending ? "Testing..." : "Test the connection"}
        </Button>
        {!canAdmin ? <p className="text-xs text-muted">Only a workspace admin can save the model or test the connection.</p> : null}
      </div>
    </div>
  );
}
