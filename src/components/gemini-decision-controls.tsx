import { useState } from "react";
import { Button, DisabledReason, Field, SelectInput } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { saveGeminiDecisionModel } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useGeminiDecisionModelsQuery, useScopedMutation } from "@/lib/query/hooks";

/**
 * Which Gemini model answers this workspace's decisions. The list is Google's own, read live with the workspace's Gemini key, so a newer
 * Gemini shows up when Google lists it, and the newest released model is marked. Nothing here names a model. Saving sends no decision and
 * changes no active engine: choose the engine separately.
 */
export function GeminiDecisionControls({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const query = useGeminiDecisionModelsQuery(organizationId);
  const [draft, setDraft] = useState<string | null>(null);
  const save = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.gemini-model", organizationId],
    mutationFn: async (model: string) => {
      const result = (await saveGeminiDecisionModel({ data: { organizationId, model } })) as { ok: true; model: string } | { ok: false; reason: string };
      if (!result.ok) throw new Error(result.reason);
      return result;
    },
    invalidate: () => [qk.geminiDecisionModels(organizationId), qk.decisionEngines(organizationId)],
    onSuccess: () => setDraft(null),
  });
  const error = save.error ? plainError(save.error) : null;
  if (query.isPending) return <p className="text-sm text-fg-muted">Reading Google's model list.</p>;
  const data = query.data;
  if (!data) return null;
  if (!data.ok) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-semibold">Gemini model</p>
        <p className="text-sm text-fg-muted">{data.reason} Save the Gemini key above, then this list appears.</p>
      </div>
    );
  }
  const latest = data.models.find((model) => model.latest);
  const value = draft ?? data.chosen ?? "";
  const unchanged = value === (data.chosen ?? "");
  const chosenText = data.chosen ? `This workspace uses ${data.chosen}.` : "No model is chosen yet. Choose one to use Gemini for decisions.";
  return (
    <div className="space-y-2">
      <Field label="Gemini model" hint={`Read from Google at ${data.readAt}. ${latest ? `The latest is ${latest.id}.` : ""}`}>
        <SelectInput value={value} onChange={(event) => setDraft(event.target.value)} disabled={!canAdmin || save.isPending}>
          {value === "" ? <option value="">Choose a model</option> : null}
          {data.chosen && !data.models.some((model) => model.id === data.chosen) ? <option value={data.chosen}>{data.chosen} (no longer in Google's list)</option> : null}
          {data.models.map((model) => (
            <option key={model.id} value={model.id}>{model.id}{model.latest ? " (latest)" : ""}</option>
          ))}
        </SelectInput>
      </Field>
      <p className="text-xs text-fg-muted">{chosenText} Google reports no price for a call, so each decision is held at your decision cap on Billing and counted at that cap.</p>
      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {canAdmin ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" disabled={value === "" || unchanged || save.isPending} onClick={() => void save.mutateAsync(value).catch(() => undefined)}>
            {save.isPending ? "Saving..." : "Save Gemini model"}
          </Button>
          {value !== "" && unchanged && !save.isPending ? <DisabledReason id="gemini-model-saved">This model is already saved.</DisabledReason> : null}
        </div>
      ) : null}
    </div>
  );
}
