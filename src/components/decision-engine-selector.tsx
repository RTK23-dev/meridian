import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

const engineSchema = z.object({ engineId: z.string().min(1, "Choose a decision engine.") });
import { Button, DisabledReason, ErrorState, Field, SelectInput } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { saveDecisionEngine } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useDecisionEnginesQuery, useScopedMutation } from "@/lib/query/hooks";

type EngineStatus = {
  id: "jev" | "openai-decisions";
  label: string;
  isActive: boolean;
  health: { status: string; message?: string };
  adapterVersion: string;
  capabilities: {
    questionKinds: string[];
    inputModalities: string[];
    maxImages: number;
    reportsUsage: boolean;
  };
};

type Status = {
  active: { engineId: "jev" | "openai-decisions"; source: "workspace" | "deployment" | "default"; invalidDeploymentValue?: string };
  engines: EngineStatus[];
};

interface DecisionEngineSelectorProps {
  organizationId: string;
  canAdmin: boolean;
}

/**
 * Selects the one decision engine that receives this workspace's decisions. The choice is saved on the server only when
 * the chosen engine is configured, and the active engine is shown with the reason it is active.
 */
export function DecisionEngineSelector({ organizationId, canAdmin }: DecisionEngineSelectorProps) {
  const engines = useDecisionEnginesQuery(organizationId);
  const status = (engines.data as Status | undefined) ?? null;
  // The selection follows the stored engine until the person picks another one.
  const form = useForm<{ engineId: string }>({
    resolver: zodResolver(engineSchema),
    defaultValues: { engineId: status?.active.engineId ?? "" },
    mode: "onChange",
  });
  const choice = form.watch("engineId");
  const storedEngineId = status?.active.engineId ?? "";
  useEffect(() => {
    if (!form.formState.isDirty) form.reset({ engineId: storedEngineId });
  }, [storedEngineId, form]);
  const [message, setMessage] = useState<string | null>(null);
  const save = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.save", organizationId],
    mutationFn: async (engineId: string) => {
      const result = (await saveDecisionEngine({ data: { organizationId, engineId } })) as
        | { ok: true; engineId: string }
        | { ok: false; reason: string; activeEngineId?: string };
      // A refused choice is an error the user must see, so it is thrown and shown rather than returned as a result.
      if (!result.ok) throw new Error(`${result.reason} The active engine is unchanged.`);
      return result;
    },
    invalidate: () => [qk.decisionEngines(organizationId)],
    onSuccess: (result) => {
      setMessage(`Decision engine set to ${result.engineId}. Only this engine now receives decisions for this workspace.`);
      form.reset({ engineId: result.engineId });
    },
  });
  const saving = save.isPending;
  const error = save.error ? plainError(save.error) : null;

  if (engines.isError && !status) {
    return <ErrorState message="The decision engine status could not be loaded." onRetry={() => void engines.refetch()} />;
  }
  if (!status) {
    return <p className="text-muted text-sm">Loading decision engine status...</p>;
  }

  async function handleSave() {
    setMessage(null);
    const valid = await form.trigger();
    if (!valid) return;
    await save.mutateAsync(form.getValues("engineId")).catch(() => undefined);
  }

  const activeLabel = status.engines.find((engine) => engine.isActive)?.label ?? status.active.engineId;
  const sourceText =
    status.active.source === "workspace"
      ? "chosen for this workspace"
      : status.active.source === "deployment"
        ? "set by the deployment (DECISION_ENGINE)"
        : "the default";

  return (
    <div className="space-y-4 rounded border border-line bg-panel p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-brass">Decision engine</p>
        <h3 className="font-semibold text-lg">Active: {activeLabel}</h3>
        <p className="text-sm text-muted">
          Only the active engine receives decisions. Meridian never calls the other engine for the same decision, and never
          switches silently when the active engine fails. The active engine is {sourceText}.
        </p>
        {status.active.invalidDeploymentValue ? (
          <p className="text-xs text-warning mt-1">
            DECISION_ENGINE is set to &quot;{status.active.invalidDeploymentValue}&quot;, which is not an engine. The default is in use.
          </p>
        ) : null}
      </div>

      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {message ? <p className="text-sm text-success" role="status">{message}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {status.engines.map((engine) => (
          <div key={engine.id} className="rounded border border-line p-3 text-sm space-y-1">
            <div className="flex items-center justify-between gap-2">
              <strong>{engine.label}</strong>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  engine.health.status === "READY"
                    ? "bg-success/20 text-success border border-success/30"
                    : "bg-muted/20 text-muted border border-line"
                }`}
              >
                {engine.health.status}
              </span>
            </div>
            {engine.isActive ? <p className="text-xs font-semibold text-brass">ACTIVE</p> : null}
            <p className="text-xs text-muted">{engine.health.message}</p>
            <p className="text-xs text-muted">
              Questions: {engine.capabilities.questionKinds.join(", ")} · Inputs: {engine.capabilities.inputModalities.join(", ")}
              {engine.capabilities.maxImages > 0 ? ` (up to ${engine.capabilities.maxImages} images)` : " (no images)"}
            </p>
            <p className="text-xs text-muted font-mono">Adapter {engine.adapterVersion}</p>
          </div>
        ))}
      </div>

      {canAdmin ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem]">
            <Field label="Engine for this workspace" error={form.formState.errors.engineId?.message}>
              <SelectInput {...form.register("engineId")} disabled={saving}>
                {status.engines.map((engine) => (
                  <option key={engine.id} value={engine.id} disabled={engine.health.status !== "READY" && engine.id !== status.active.engineId}>
                    {engine.label}
                    {engine.health.status !== "READY" ? " (not configured)" : ""}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <Button type="button" onClick={handleSave} disabled={saving || choice === status.active.engineId} aria-describedby={choice === status.active.engineId ? "engine-save-reason" : undefined}>
            {saving ? "Saving..." : "Save engine"}
          </Button>
          {choice === status.active.engineId && !saving ? <DisabledReason id="engine-save-reason">This engine is already active. Choose a different engine to save.</DisabledReason> : null}
        </div>
      ) : (
        <p className="text-xs text-muted">Only workspace admins can change the decision engine.</p>
      )}
    </div>
  );
}
