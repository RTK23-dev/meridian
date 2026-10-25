import { useState } from "react";
import { Button, DisabledReason, Field, SelectInput } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { saveJevBackend } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useScopedMutation } from "@/lib/query/hooks";

export type JevBackendId = "typesafe_direct" | "openrouter";

export type JevBackendStatusView = {
  backend: JevBackendId | null;
  source: "workspace" | "default";
  reason?: string;
};

export type JevBackendOptionView = {
  backend: JevBackendId;
  label: string;
  health: { status: string; message?: string };
};

/**
 * Which service answers JEV's decisions for this workspace. JEV's questions, evidence rules and answer checks stay the same
 * whichever service answers. Only the chosen service is called, and nothing falls back to the other one. A switch is saved only
 * when the new service reports READY, and the server checks that again.
 */
export function JevBackendControls({
  organizationId,
  canAdmin,
  status,
  options,
}: {
  organizationId: string;
  canAdmin: boolean;
  status: JevBackendStatusView;
  options: JevBackendOptionView[];
}) {
  const stored = status.backend;
  const [draft, setDraft] = useState<JevBackendId | "">(stored ?? "");
  const [saved, setSaved] = useState<string | null>(null);
  const save = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.jev-backend", organizationId],
    mutationFn: async (backend: JevBackendId) => {
      const result = (await saveJevBackend({ data: { organizationId, backend } })) as
        | { ok: true; backend: JevBackendId }
        | { ok: false; reason: string };
      // A refused switch is thrown, so the reason is shown and the stored backend is unchanged.
      if (!result.ok) throw new Error(result.reason);
      return result;
    },
    invalidate: () => [qk.decisionEngines(organizationId)],
    onSuccess: (result) => {
      setSaved(`JEV decisions for this workspace now use ${labelOf(result.backend)}. Only that service is called.`);
      setDraft(result.backend);
    },
  });
  const saveError = save.error ? plainError(save.error) : null;
  const choiceHealth = options.find((option) => option.backend === draft)?.health.status;
  const choiceReady = choiceHealth === "READY";
  const same = draft !== "" && draft === stored;

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="font-semibold">JEV backend</p>
        <p className="text-sm text-muted">
          JEV&apos;s questions, evidence rules and answer checks stay the same. This setting chooses which service answers them. Meridian
          calls only that service and never falls back to the other one. OpenRouter uses the OpenRouter decision model and connection
          test below.
        </p>
        <p className="mt-1 text-sm">
          {status.backend
            ? `Using ${labelOf(status.backend)} ${status.source === "workspace" ? "for this workspace." : "(the default)."}`
            : "The saved JEV backend cannot be read, so JEV makes no request until a backend is chosen here."}
        </p>
        {status.reason ? <p className="mt-1 text-sm text-warning">{status.reason}</p> : null}
      </div>

      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {options.map((option) => (
          <li key={option.backend} className="border-t border-line pt-2 text-sm space-y-1">
            <div className="flex items-center justify-between gap-2">
              <strong>{option.label}</strong>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  option.health.status === "READY"
                    ? "bg-success/20 text-success border border-success/30"
                    : "bg-muted/20 text-muted border border-line"
                }`}
              >
                {option.health.status}
              </span>
            </div>
            <p className="text-xs text-muted">{option.health.message}</p>
          </li>
        ))}
      </ul>

      {saveError ? <PlainErrorMessage message={saveError.message} raw={saveError.raw} /> : null}
      {saved ? <p className="text-sm text-success" role="status">{saved}</p> : null}

      {canAdmin ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-72">
            <Field label="Backend for JEV decisions">
              <SelectInput
                value={draft}
                onChange={(event) => { setSaved(null); setDraft(event.target.value as JevBackendId | ""); }}
                disabled={save.isPending}
              >
                {draft === "" ? <option value="">Choose a backend</option> : null}
                {options.map((option) => (
                  <option key={option.backend} value={option.backend}>
                    {option.label}
                    {option.health.status !== "READY" ? " (not ready)" : ""}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => { if (draft !== "") void save.mutateAsync(draft).catch(() => undefined); }}
            disabled={save.isPending || draft === "" || same || !choiceReady}
            aria-describedby={draft !== "" && (same || !choiceReady) ? "jev-backend-reason" : undefined}
          >
            {save.isPending ? "Saving..." : "Save JEV backend"}
          </Button>
          {draft !== "" && same && !save.isPending ? <DisabledReason id="jev-backend-reason">This backend is already in use.</DisabledReason> : null}
          {draft !== "" && !same && !choiceReady && !save.isPending ? (
            <DisabledReason id="jev-backend-reason">This backend is not ready. Its key or connection test is needed first, then come back.</DisabledReason>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted">Only a workspace admin can change the JEV backend.</p>
      )}
    </div>
  );
}

function labelOf(backend: JevBackendId): string {
  return backend === "openrouter" ? "OpenRouter Decisions" : "TypeSafe System One";
}
