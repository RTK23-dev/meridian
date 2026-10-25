import { useMemo, useState } from "react";
import { Button, DisabledReason, Field, Input, SelectInput } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { saveGenerationModelChoice } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useGenerationCatalogueQuery, useGenerationModelsQuery, useScopedMutation } from "@/lib/query/hooks";

type CatalogueModel = {
  id: string;
  name: string;
  takes: string[];
  promptUsdPerMillionTokens: number;
  completionUsdPerMillionTokens: number;
  suitsTasks: string[];
};

type CatalogueListing = { ok: true; readAt: string; reason: null; models: CatalogueModel[] } | { ok: false; reason: string; readAt: null; models: [] };

type TaskChoice = {
  task: string;
  label: string;
  description: string;
  needsImage: boolean;
  saved: { modelId: string; updatedAt: string; updatedBy: string } | null;
  deploymentDefault: string | null;
};

type TaskChoices = { connected: boolean; connectionReason: string | null; tasks: TaskChoice[] };

type SaveResult = { ok: true; status: "saved" | "cleared"; modelId: string | null } | { ok: false; reason: string };

/**
 * The model each ordinary text-generation task uses in this workspace, chosen from the live OpenRouter catalogue. A choice is checked
 * against the catalogue when it is saved and again before each paid call, so a model that has left the catalogue is refused. Decision
 * models are not offered here: they have their own setting, above.
 */
export function GenerationModelSettings({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const choices = useGenerationModelsQuery(organizationId);
  const catalogue = useGenerationCatalogueQuery(organizationId);
  const state = (choices.data as TaskChoices | undefined) ?? null;
  const listing = (catalogue.data as CatalogueListing | undefined) ?? null;

  if (choices.isPending) return <p className="text-sm text-muted">Reading this workspace's model choices...</p>;
  if (!state) return <p className="text-sm text-warning" role="status">The model choices could not be read. Reload the page to try again.</p>;

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-sm">
        <p role="status" className={state.connected ? "text-success" : "text-warning"}>
          {state.connected
            ? "OpenRouter is connected for this workspace."
            : `OpenRouter is not connected for this workspace. ${state.connectionReason ?? ""} Nothing is sent for these tasks until it is.`}
        </p>
        <p className="text-muted">
          The model is read live from OpenRouter's public catalogue. Only text models whose prices OpenRouter states are offered. The cost of a
          call is shown from OpenRouter's own report after the call runs; it is not estimated here.
        </p>
        {!canAdmin ? <p className="text-muted">Only a workspace admin can choose or clear a model.</p> : null}
      </div>
      {catalogue.isPending && state.connected ? <p className="text-sm text-muted">Reading the OpenRouter model catalogue...</p> : null}
      {listing && !listing.ok && state.connected ? (
        <p className="text-sm text-warning" role="status">
          {listing.reason} No model can be chosen until the catalogue can be read.
        </p>
      ) : null}
      {state.tasks.map((task) => (
        <GenerationTaskRow
          key={task.task}
          organizationId={organizationId}
          canAdmin={canAdmin}
          task={task}
          models={listing?.ok ? listing.models : []}
        />
      ))}
    </div>
  );
}

/** The hint under the model list: why it is empty, or how many models the search leaves. */
function modelsHint(listed: number, shown: number): string {
  if (listed === 0) return "No text model is listed, because the catalogue has not been read.";
  if (shown === 0) return "No text model matches this search.";
  return `${shown} shown`;
}

/** What the task uses right now, in words: the workspace's choice, the deployment default, or nothing. */
function describeCurrent(task: TaskChoice): string {
  if (task.saved) {
    return `Chosen for this workspace: ${task.saved.modelId}, saved ${new Date(task.saved.updatedAt).toLocaleDateString("en-GB")}.`;
  }
  if (task.deploymentDefault) {
    return `Not chosen. This task uses the deployment's default, ${task.deploymentDefault}, until a model is chosen here.`;
  }
  if (task.needsImage) {
    return "Not chosen. Image understanding has no default, so a model that takes images must be chosen here. Factory keyframes are not labelled until then.";
  }
  return "Not chosen. Nothing is sent for this task until a model is chosen here.";
}

function GenerationTaskRow({
  organizationId,
  canAdmin,
  task,
  models,
}: {
  organizationId: string;
  canAdmin: boolean;
  task: TaskChoice;
  models: CatalogueModel[];
}) {
  const [draft, setDraft] = useState(task.saved?.modelId ?? "");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const eligible = useMemo(() => models.filter((model) => model.suitsTasks.includes(task.task)), [models, task.task]);
  const search = query.trim().toLowerCase();
  const shown = search ? eligible.filter((model) => model.id.toLowerCase().includes(search) || model.name.toLowerCase().includes(search)) : eligible;
  const chosen = eligible.find((model) => model.id === draft) ?? null;
  const unchanged = draft === (task.saved?.modelId ?? "");
  const savable = canAdmin && !unchanged && chosen !== null;
  const save = useScopedMutation({
    mutationKey: ["mutation", "generation-model.save", organizationId, task.task],
    mutationFn: async (modelId: string | null) => {
      const result = (await saveGenerationModelChoice({ data: { organizationId, task: task.task, modelId } })) as SaveResult;
      // A refused model is thrown, so its reason is shown and the stored choice is unchanged.
      if (!result.ok) throw new Error(result.reason);
      return result;
    },
    invalidate: () => [qk.generationModels(organizationId), qk.generationCatalogue(organizationId)],
    onSuccess: (result) => {
      setNotice(result.status === "saved" && result.modelId ? `${task.label} now uses ${result.modelId}.` : `${task.label} no longer has a chosen model.`);
      setDraft(result.modelId ?? "");
    },
  });
  const saveError = save.error ? plainError(save.error) : null;
  const saveReason = !canAdmin || models.length === 0
    ? null
    : draft === ""
      ? "Choose a model from the list. Only text models in the live catalogue can be chosen."
      : unchanged
        ? "This model is already saved."
        : "Choose a model from the list. It must be a text model in the live catalogue that suits this task.";

  return (
    <section aria-labelledby={`generation-task-${task.task}`} className="space-y-3 border-t border-line pt-4">
      <div>
        <h3 id={`generation-task-${task.task}`} className="font-semibold">{task.label}</h3>
        <p className="text-sm text-muted">{task.description}</p>
        <p className="mt-1 text-sm">{describeCurrent(task)}</p>
      </div>
      {saveError ? <PlainErrorMessage message={saveError.message} raw={saveError.raw} /> : null}
      {notice ? <p className="text-sm text-success" role="status">{notice}</p> : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <Input
            label="Search the catalogue"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            hint="By model ID or name"
            disabled={models.length === 0}
          />
        </div>
        <div className="w-full sm:w-96">
          <Field label="Model" hint={modelsHint(models.length, shown.length)}>
            <SelectInput
              value={draft}
              onChange={(event) => {
                setNotice(null);
                setDraft(event.target.value);
              }}
              disabled={!canAdmin || save.isPending}
            >
              <option value="">No model chosen</option>
              {draft !== "" && !chosen ? <option value={draft}>{draft} (not in the live catalogue for this task)</option> : null}
              {shown.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setNotice(null);
            void save.mutateAsync(draft).catch(() => undefined);
          }}
          disabled={!savable || save.isPending}
          aria-describedby={canAdmin && !savable && !save.isPending ? `generation-${task.task}-reason` : undefined}
        >
          {save.isPending ? "Saving..." : "Save model"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setNotice(null);
            void save.mutateAsync(null).catch(() => undefined);
          }}
          disabled={!canAdmin || save.isPending || task.saved === null}
        >
          Clear model
        </Button>
        {saveReason && !savable && !save.isPending ? (
          <div className="basis-full">
            <DisabledReason id={`generation-${task.task}-reason`}>{saveReason}</DisabledReason>
          </div>
        ) : null}
      </div>

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
            <dt className="text-muted">Input price</dt>
            <dd>${chosen.promptUsdPerMillionTokens.toFixed(3)} per million tokens</dd>
          </div>
          <div>
            <dt className="text-muted">Output price</dt>
            <dd>${chosen.completionUsdPerMillionTokens.toFixed(3)} per million tokens</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
