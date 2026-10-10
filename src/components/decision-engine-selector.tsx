import { useEffect, useState } from "react";
import { Button, Field, Notice, SelectInput } from "@/components/ui";
import { getDecisionEngines, saveDecisionEngine } from "@/lib/meridian/settings/server-actions";

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
  const [status, setStatus] = useState<Status | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    try {
      const data = (await getDecisionEngines({ data: { organizationId } })) as Status;
      setStatus(data);
      setChoice(data.active.engineId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the decision engine status.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = (await saveDecisionEngine({ data: { organizationId, engineId: choice } })) as
        | { ok: true; engineId: string }
        | { ok: false; reason: string; activeEngineId?: string };
      if (result.ok) {
        setMessage(`Decision engine set to ${result.engineId}. Only this engine now receives decisions for this workspace.`);
        await load();
      } else {
        setError(`${result.reason} The active engine is unchanged.`);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving the decision engine failed.");
    } finally {
      setSaving(false);
    }
  }

  if (!status) {
    return <p className="text-muted text-sm">Loading decision engine status...</p>;
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

      {error ? <Notice>{error}</Notice> : null}
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
            <Field label="Engine for this workspace">
              <SelectInput value={choice} onChange={(e) => setChoice(e.target.value)} disabled={saving}>
                {status.engines.map((engine) => (
                  <option key={engine.id} value={engine.id} disabled={engine.health.status !== "READY" && engine.id !== status.active.engineId}>
                    {engine.label}
                    {engine.health.status !== "READY" ? " (not configured)" : ""}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <Button type="button" onClick={handleSave} disabled={saving || choice === status.active.engineId}>
            {saving ? "Saving..." : "Save engine"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">Only workspace admins can change the decision engine.</p>
      )}
    </div>
  );
}
