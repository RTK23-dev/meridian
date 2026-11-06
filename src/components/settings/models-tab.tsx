import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { GenerationModelSettings } from "@/components/generation-model-settings";
import { OpenRouterDecisionControls, type OpenRouterModelStatus } from "@/components/openrouter-decision-controls";
import { qk } from "@/lib/query/keys";
import { useDecisionEnginesQuery, useGenerationCatalogueQuery, useGenerationModelsQuery, useScopedMutation } from "@/lib/query/hooks";
import { applyModelPreset } from "@/lib/meridian/settings/server-actions";
import { MODEL_PRESET_IDS, MODEL_PRESETS, type ModelPresetId } from "@/lib/meridian/settings/model-presets";

type AppliedRow = { task: string; label: string; modelId: string | null; reason: string; saved: boolean };
type ApplyResult = { ok: true; label: string; applied: AppliedRow[] } | { ok: false; reason: string; applied: AppliedRow[] };

/**
 * Models: a preset sets every writing task at once from the live OpenRouter catalogue; each task can then be changed on its own below.
 * Every model runs through the OpenRouter key. The decision model (for OpenRouter Decisions) is chosen here too.
 */
export function ModelsTab({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [result, setResult] = useState<ApplyResult | null>(null);
  const engines = useDecisionEnginesQuery(organizationId);
  const decisionModel = (engines.data as { openrouterModel?: OpenRouterModelStatus } | undefined)?.openrouterModel ?? null;
  // The Decisions row in Connections links here (#decision-model). The lists above it load first and would push it down, so the scroll
  // waits until they have settled (the same cached queries the list reads), and happens once.
  const decisionSection = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  const choices = useGenerationModelsQuery(organizationId);
  const catalogue = useGenerationCatalogueQuery(organizationId);
  const settled = decisionModel !== null && !choices.isPending && !catalogue.isPending;
  useEffect(() => {
    if (!settled || scrolled.current || window.location.hash !== "#decision-model") return;
    scrolled.current = true;
    requestAnimationFrame(() => decisionSection.current?.scrollIntoView({ block: "start" }));
  }, [settled]);
  const apply = useScopedMutation({
    mutationKey: ["mutation", "models.preset", organizationId],
    mutationFn: (preset: ModelPresetId) => applyModelPreset({ data: { organizationId, preset } }) as Promise<ApplyResult>,
    invalidate: () => [qk.generationModels(organizationId)],
    onSuccess: (answer) => setResult(answer as ApplyResult),
  });

  return (
    <div className="space-y-8">
      <section aria-labelledby="presets-title" className="space-y-3">
        <div className="space-y-1">
          <h2 id="presets-title" className="text-section font-semibold text-fg-primary">Start from a preset</h2>
          <p className="text-sm text-fg-muted">Sets every writing task in one click, from the models OpenRouter lists right now. Change any task below afterwards.</p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-3">
          {MODEL_PRESET_IDS.map((id) => (
            <li key={id} className="flex flex-col gap-3 rounded-sharp border border-hairline bg-raised p-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-fg-primary">{MODEL_PRESETS[id].label}</h3>
                <p className="text-sm text-fg-muted">{MODEL_PRESETS[id].description}</p>
              </div>
              <Button type="button" variant="secondary" size="sm" className="mt-auto self-start" disabled={!canAdmin || apply.isPending} onClick={() => void apply.mutateAsync(id).catch(() => undefined)}>
                {apply.isPending && apply.variables === id ? "Applying..." : "Use this preset"}
              </Button>
            </li>
          ))}
        </ul>
        {!canAdmin ? <p className="text-sm text-fg-muted">Only a workspace admin can change models.</p> : null}
        {result ? (
          <div role="status" className="rounded-sharp border border-hairline p-3 text-sm">
            {result.ok ? (
              <>
                <p className="font-semibold text-fg-primary">{result.label} applied.</p>
                <ul className="mt-2 space-y-1 text-fg-muted">
                  {result.applied.map((row) => (
                    <li key={row.task}>
                      <span className="text-fg-primary">{row.label}:</span> {row.modelId ?? "Auto"}
                      {row.saved ? "" : ` (not saved: ${row.reason})`}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-warning">{result.reason}</p>
            )}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="task-models-title" className="space-y-3">
        <div className="space-y-1">
          <h2 id="task-models-title" className="text-section font-semibold text-fg-primary">Model for each task</h2>
          <p className="text-sm text-fg-muted">Each choice is checked against the live OpenRouter catalogue before it is saved.</p>
        </div>
        <GenerationModelSettings organizationId={organizationId} canAdmin={canAdmin} />
      </section>

      <section ref={decisionSection} id="decision-model" aria-labelledby="decision-model-title" className="space-y-3">
        <div className="space-y-1">
          <h2 id="decision-model-title" className="text-section font-semibold text-fg-primary">Decision model</h2>
          <p className="text-sm text-fg-muted">Used only when decisions and scoring run on OpenRouter (chosen in Connections).</p>
        </div>
        {decisionModel ? (
          <OpenRouterDecisionControls organizationId={organizationId} canAdmin={canAdmin} model={decisionModel} />
        ) : engines.isError ? (
          <p className="text-sm text-warning">The decision model could not be read.</p>
        ) : (
          <p className="text-sm text-fg-muted">Loading the decision model...</p>
        )}
      </section>
    </div>
  );
}
