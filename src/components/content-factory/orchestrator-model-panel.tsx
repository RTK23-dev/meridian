import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardDescription, CardHeader, CardTitle, Input, SelectInput, toast } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { getOrchestratorModelSetting, listOrchestratorTextModels, saveOrchestratorModelSetting } from "@/lib/meridian/orchestrator/actions";
import { hasRole } from "@/lib/meridian/access";
import { isOrchestratorModelId, type TextModelChoice } from "@/engine/orchestrator/settings";

type TextModelsResult = { status: "ok"; models: TextModelChoice[] } | { status: "not_connected" | "failed"; reason: string };

/** Listed options at most. The catalog has hundreds of text models; the search narrows them. */
const MAX_OPTIONS = 60;

const perMillion = (usdPerToken: number) => `$${(usdPerToken * 1_000_000).toFixed(2)}`;

/**
 * The orchestrator model of this workspace, stored here (migration 0109). Every plan that names no model uses it. When the live catalog is
 * connected, the choice is one of its text models with prices; when it is not, the id is stored as typed and the panel says so.
 */
export function OrchestratorModelPanel({ organizationId }: { organizationId: string }) {
  const { user, isPending } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");
  const enabled = !isPending && !!user && !!organizationId;
  const stored = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-model", "stored", organizationId]),
    queryFn: () => getOrchestratorModelSetting({ data: { organizationId } }),
    enabled,
  });
  const models = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-model", "text-models", organizationId]),
    queryFn: () => listOrchestratorTextModels({ data: { organizationId } }),
    enabled,
    staleTime: 5 * 60_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Orchestrator model</CardTitle>
        <CardDescription>The model that writes each plan for this workspace. It is stored here until you change it. Each plan records the model that wrote it.</CardDescription>
      </CardHeader>
      {stored.isError && !stored.data ? <PlainErrorState error={stored.error} onRetry={() => void stored.refetch()} /> : null}
      {stored.data ? (
        <ModelForm
          key={stored.data.orchestratorModel ?? ""}
          organizationId={organizationId}
          stored={stored.data.orchestratorModel}
          catalog={models.data ?? null}
          catalogError={models.isError && !models.data ? models.error : null}
          canAdmin={canAdmin}
        />
      ) : stored.isError ? null : (
        <p role="status" className="text-sm text-fg-muted">Loading the stored model.</p>
      )}
    </Card>
  );
}

/** The catalog's state in words. Loading is not a failure, and not connected names the reason the catalog gave. */
function catalogStatusLine(catalog: TextModelsResult | null, catalogError: unknown): string {
  if (catalog !== null && catalog.status !== "ok") {
    return `Live catalog: ${catalog.status === "failed" ? "failed" : "NOT CONNECTED"}. ${catalog.reason}`;
  }
  if (catalogError !== null) {
    return `Live catalog: failed. ${catalogError instanceof Error ? catalogError.message : "The catalog could not be read."}`;
  }
  return "Live catalog: reading.";
}

function ModelForm({ organizationId, stored, catalog, catalogError, canAdmin }:{ organizationId: string; stored: string | null; catalog: TextModelsResult | null; catalogError: unknown; canAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState(stored ?? "");
  const [busy, setBusy] = useState(false);
  const live = catalog?.status === "ok" ? catalog.models : null;

  const needle = query.trim().toLowerCase();
  const matches = (live ?? []).filter((model) => needle === "" || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
  const shown = matches.slice(0, MAX_OPTIONS);
  const chosenInLive = live?.find((model) => model.id === choice);
  if (chosenInLive && !shown.includes(chosenInLive)) shown.unshift(chosenInLive);

  const save = async (modelId: string | null) => {
    setBusy(true);
    try {
      const saved = await saveOrchestratorModelSetting({ data: { organizationId, orchestratorModelId: modelId } });
      await queryClient.invalidateQueries({ predicate: (item) => item.queryKey.includes("orchestrator-model") });
      toast.success(
        saved.orchestratorModel === null
          ? "The orchestrator model was cleared. Plans need one before they can be written."
          : saved.checkedAgainstCatalog
            ? "Orchestrator model saved."
            : "Orchestrator model saved. It is not checked against the live catalog yet; the plan checks it when the plan is written.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The orchestrator model was not saved.");
    } finally {
      setBusy(false);
    }
  };

  const typed = choice.trim();
  const unchanged = typed === (stored ?? "");

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (canAdmin && typed !== "") void save(typed); }}>
      <p className="text-sm">
        {stored === null ? (
          <span className="text-fg-muted">No model is stored. A plan cannot be written until one is.</span>
        ) : (
          <>Stored: <code className="font-mono text-sm">{stored}</code></>
        )}
      </p>
      {live !== null ? (
        <>
          <p className="text-sm text-fg-muted">{live.length} text models with prices, from the live catalog. Prices are per million tokens, input then output.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Find a model" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="claude, gpt, haiku" />
            <div className="space-y-1.5">
              <label htmlFor="cf-orchestrator-model" className="block text-sm font-semibold">Orchestrating model</label>
              <SelectInput id="cf-orchestrator-model" value={choice} onChange={(event) => setChoice(event.target.value)}>
                <option value="">Choose a model</option>
                {shown.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.id} · {perMillion(model.promptUsdPerToken)} / {perMillion(model.completionUsdPerToken)}
                  </option>
                ))}
              </SelectInput>
              {matches.length > MAX_OPTIONS ? <p className="text-sm text-fg-muted">Showing the first {MAX_OPTIONS} of {matches.length}. Narrow the search to see more.</p> : null}
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p role="status" className="text-sm text-fg-muted">{catalogStatusLine(catalog, catalogError)}</p>
          <Input
            label="OpenRouter model id"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            placeholder="vendor/model"
            hint="Saved as typed, without a check against the catalog. The plan checks it when the plan is written."
          />
          {typed !== "" && !isOrchestratorModelId(typed) ? <p className="text-sm text-danger">An OpenRouter id is vendor/model.</p> : null}
        </div>
      )}
      {canAdmin ? null : <p id="model-role" className="text-sm text-fg-muted">Only a workspace admin can change the orchestrator model.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="md" variant="secondary" loading={busy} disabled={busy || !canAdmin || typed === "" || unchanged || (live === null && !isOrchestratorModelId(typed))} aria-describedby={canAdmin ? undefined : "model-role"}>
          Save model
        </Button>
        {stored !== null ? (
          <Button type="button" size="md" variant="ghost" disabled={busy || !canAdmin} aria-describedby={canAdmin ? undefined : "model-role"} onClick={() => void save(null)}>Clear stored model</Button>
        ) : null}
      </div>
    </form>
  );
}
