import { useState } from "react";
import { Button, DisabledReason, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { saveOpenRouterDecisionModel, testOpenRouterDecisionConnection } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useScopedMutation } from "@/lib/query/hooks";

export type OpenRouterModelStatus = {
  model: string;
  source: "workspace" | "deployment" | "default";
  reason?: string;
};

const SOURCE_TEXT: Record<OpenRouterModelStatus["source"], string> = {
  workspace: "chosen for this workspace",
  deployment: "set by the deployment (OPENROUTER_DECISIONS_MODEL)",
  default: "the pinned default",
};

type TestResult = { ok: boolean; status: "PASSED" | "FAILED" | "NOT_RUN"; message: string };

/**
 * The OpenRouter decision model and its connection test, shared by Setup and Settings. Saving a model changes no active engine,
 * and a saved model is not a passed test. The test sends one real request to OpenRouter and may incur model usage. It changes no
 * product data and no active engine, and only admins can run it.
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
    invalidate: () => [qk.decisionEngines(organizationId)],
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
  const unchanged = draft.trim() === model.model;

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="font-semibold">OpenRouter decision model</p>
        <p className="text-sm text-muted">
          The model is {SOURCE_TEXT[model.source]}. Only pinned, verified decision models are accepted, for example typesafe/jev-1.14.
        </p>
        {model.reason ? <p className="mt-1 text-sm text-warning">{model.reason}</p> : null}
      </div>
      {saveError ? <PlainErrorMessage message={saveError.message} raw={saveError.raw} /> : null}
      {saved ? <p className="text-sm text-success" role="status">{saved}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Input
            label="Decision model ID"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!canAdmin || save.isPending}
            hint="A provider and model, such as typesafe/jev-1.14. Aliases with ~ are refused."
            autoComplete="off"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => { setSaved(null); void save.mutateAsync(draft.trim()).catch(() => undefined); }}
          disabled={!canAdmin || save.isPending || unchanged || draft.trim() === ""}
          aria-describedby={canAdmin && unchanged ? "openrouter-model-unchanged" : undefined}
        >
          {save.isPending ? "Saving..." : "Save model"}
        </Button>
        {canAdmin && unchanged && !save.isPending ? <DisabledReason id="openrouter-model-unchanged">This model is already saved.</DisabledReason> : null}
      </div>
      <div className="space-y-2">
        <p className="text-sm text-muted">
          Testing the connection sends one real request to OpenRouter and may incur model usage. It changes no product data and no active engine.
        </p>
        {testError ? <PlainErrorMessage message={testError.message} raw={testError.raw} /> : null}
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
