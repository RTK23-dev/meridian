import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Badge, Button, Checkbox, errorText } from "@/components/ui";
import { budgetBlocker } from "@/components/setup/engine-progress";
import { InfoButton } from "@/components/settings/info-button";
import { ModelPicker, type PickerOption, type PickerTone } from "@/components/settings/model-picker";
import { UncertainHoldsPanel } from "@/components/uncertain-holds-panel";
import { qk } from "@/lib/query/keys";
import {
  useDecisionEnginesQuery,
  useGenerationCatalogueQuery,
  useGenerationModelsQuery,
  useMediaModelsQuery,
  useOpenRouterDecisionModelsQuery,
  useScopedMutation,
  useUncertainHoldsQuery,
} from "@/lib/query/hooks";
import {
  applyModelPreset,
  saveGenerationModelChoice,
  saveGenerationModelChoices,
  saveMediaModelChoice,
  saveOpenRouterDecisionModel,
  testOpenRouterDecisionConnection,
} from "@/lib/meridian/settings/server-actions";
import { MODEL_PRESET_IDS, MODEL_PRESETS, type ModelPresetId } from "@/lib/meridian/settings/model-presets";
import { DECISION_FAMILIES, latestDecisionModel } from "@/lib/meridian/decisions/decision-catalog";
import {
  bulkSummary,
  fallbackText,
  groupByProvider,
  groupTasks,
  modelsFor,
  priceLine,
  setupCounts,
  sharedModels,
  shortName,
  taskState,
  type BulkResult,
  type CatalogueModel,
  type TaskChoice,
} from "./models-model";

type TaskChoices = { connected: boolean; connectionReason: string | null; tasks: TaskChoice[] };
type CatalogueListing = { ok: true; readAt: string; reason: null; models: CatalogueModel[] } | { ok: false; reason: string; readAt: null; models: [] };
type AppliedRow = { task: string; label: string; modelId: string | null; reason: string; saved: boolean };
type ApplyResult = { ok: true; label: string; applied: AppliedRow[] } | { ok: false; reason: string; applied: AppliedRow[] };
type SaveResult = { ok: true; status: "saved" | "cleared"; modelId: string | null } | { ok: false; reason: string };
type BulkAnswer = { ok: true; modelId: string | null; results: BulkResult[] } | { ok: false; reason: string; results: [] };

const PLATTER = "rounded-sharp border border-hairline bg-raised";
const PICKER_WIDTH = "w-[9.5rem] sm:w-52";

function Dot({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 rounded-full ${className}`} />;
}

/** The picker's options for text tasks: the catalogue grouped by provider, each with its price. */
function textOptions(models: CatalogueModel[]): PickerOption[] {
  return groupByProvider(models).flatMap((group) => group.models.map((model) => ({ id: model.id, title: shortName(model), detail: priceLine(model), group: group.label })));
}

/**
 * Models: a quick preset, then the tasks in small groups. Each task is one row with its model; ticking several rows sets them together.
 * The Studio's image and video models and the decision model have their own small groups. Every choice is saved through the server,
 * which checks it against the live OpenRouter catalogue again; details sit behind each row's info button.
 */
export function ModelsTab({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const choices = useGenerationModelsQuery(organizationId);
  const catalogue = useGenerationCatalogueQuery(organizationId);
  const state = (choices.data as TaskChoices | undefined) ?? null;
  const listing = (catalogue.data as CatalogueListing | undefined) ?? null;
  const models = useMemo(() => (listing?.ok ? listing.models : []), [listing]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkRefused, setBulkRefused] = useState<{ line: string; refused: BulkResult[] } | null>(null);

  // The Decisions row in Connections links here (#decision-model). The groups above it load first and would push it down, so the scroll
  // waits until they have settled, and happens once.
  const decisionCard = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  const settled = !choices.isPending && !catalogue.isPending;
  useEffect(() => {
    if (!settled || scrolled.current || window.location.hash !== "#decision-model") return;
    scrolled.current = true;
    requestAnimationFrame(() => decisionCard.current?.scrollIntoView({ block: "start" }));
  }, [settled]);

  const toggle = (tasks: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const task of tasks) {
        if (on) next.add(task);
        else next.delete(task);
      }
      return next;
    });

  const bulk = useScopedMutation({
    mutationKey: ["mutation", "models.bulk", organizationId],
    mutationFn: async (input: { tasks: string[]; modelId: string | null; modelText: string }) => {
      const answer = (await saveGenerationModelChoices({ data: { organizationId, tasks: input.tasks, modelId: input.modelId } })) as BulkAnswer;
      if (!answer.ok) throw new Error(answer.reason);
      return { ...bulkSummary(answer.results, input.modelText), results: answer.results };
    },
    invalidate: () => [qk.generationModels(organizationId)],
    success: (_input, result) => (result.refused.length === 0 ? result.line : ""),
    onSuccess: (result) => {
      setBulkRefused(result.refused.length > 0 ? { line: result.line, refused: result.refused } : null);
      // The tasks that saved leave the selection; a refused one stays ticked, so it can be set to something else.
      setSelected(new Set(result.refused.map((item) => item.task)));
    },
  });

  if (choices.isPending) return <p className="text-sm text-fg-muted">Reading this workspace's models...</p>;
  if (!state) return <p className="text-sm text-warning" role="status">The model choices could not be read. Reload the page to try again.</p>;

  const counts = setupCounts(state.tasks);
  const groups = groupTasks(state.tasks);
  const selectedTasks = state.tasks.filter((task) => selected.has(task.task)).map((task) => task.task);
  const shared = sharedModels(models, selectedTasks);
  const catalogueReason = listing && !listing.ok ? listing.reason : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" role="status">
        <span className="flex items-center gap-2 text-fg-primary">
          <Dot className={state.connected ? "bg-success" : "bg-danger"} />
          {state.connected ? "OpenRouter connected" : "OpenRouter not connected"}
        </span>
        {!state.connected ? (
          <Link to="/settings" search={{ tab: "connections" }} className="font-semibold underline underline-offset-2">Add the key in Connections</Link>
        ) : null}
        <span className="text-fg-muted">
          {counts.chosen} of {counts.of} tasks chosen{counts.unset > 0 ? ` · ${counts.unset} send nothing yet` : ""}
        </span>
        {catalogueReason && state.connected ? <span className="text-warning">Catalogue unavailable: {catalogueReason}</span> : null}
        {!canAdmin ? <span className="text-fg-muted">Only an admin can change models.</span> : null}
      </div>

      <QuickSetup organizationId={organizationId} canAdmin={canAdmin} />

      <section aria-labelledby="task-models-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="task-models-title" className="text-section font-semibold text-fg-primary">Models per task</h2>
          {canAdmin ? (
            <p className="text-sm text-fg-muted">Tick tasks to set several at once.</p>
          ) : null}
        </div>
        {bulkRefused ? (
          <div role="alert" className="space-y-1 rounded-sharp border border-hairline p-3 text-sm">
            <p className="font-semibold text-fg-primary">{bulkRefused.line}</p>
            <ul className="space-y-1 text-fg-muted">
              {bulkRefused.refused.map((item) => <li key={item.task}><span className="text-fg-primary">{item.label}:</span> {item.reason}</li>)}
            </ul>
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((group) => {
            const ids = group.tasks.map((task) => task.task);
            const ticked = ids.filter((id) => selected.has(id)).length;
            return (
              <section key={group.id} aria-labelledby={`model-group-${group.id}`} className={PLATTER}>
                <header className="flex items-center gap-3 border-b border-hairline px-3 py-2">
                  {canAdmin ? (
                    <Checkbox
                      aria-label={`Select every ${group.label} task`}
                      checked={ticked === 0 ? false : ticked === ids.length ? true : "indeterminate"}
                      onCheckedChange={(value) => toggle(ids, value === true)}
                    />
                  ) : null}
                  <h3 id={`model-group-${group.id}`} className="eyebrow">{group.label}</h3>
                </header>
                <ul className="divide-y divide-hairline">
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.task}
                      organizationId={organizationId}
                      canAdmin={canAdmin}
                      task={task}
                      models={models}
                      catalogueReason={catalogueReason}
                      selected={selected.has(task.task)}
                      onSelect={(on) => toggle([task.task], on)}
                      busy={bulk.isPending && selected.has(task.task)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <StudioPlatter organizationId={organizationId} canAdmin={canAdmin} />
          <DecisionPlatter ref={decisionCard} organizationId={organizationId} canAdmin={canAdmin} />
          {canAdmin ? <HoldsPlatter organizationId={organizationId} /> : null}
        </div>

        {canAdmin && selectedTasks.length > 0 ? (
          <div role="region" aria-label="Selected tasks" className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-sharp border border-border-strong bg-overlay p-2">
            <span className="px-1 text-sm font-semibold text-fg-primary" aria-live="polite">{selectedTasks.length} selected</span>
            <ModelPicker
              label={`Model for the ${selectedTasks.length} selected tasks`}
              valueText={shared.length > 0 ? "Set one model" : "No shared model"}
              tone={shared.length > 0 ? "chosen" : "muted"}
              options={textOptions(shared)}
              emptyText={catalogueReason ?? (models.length === 0 ? "The catalogue has not been read." : "No model suits every selected task.")}
              clear={{ label: "Clear: back to Auto or default", detail: "Each task goes back to what it uses without a choice." }}
              onPick={(id) => void bulk.mutateAsync({ tasks: selectedTasks, modelId: id, modelText: shortName(models.find((model) => model.id === id), id) }).catch(() => undefined)}
              onClear={() => void bulk.mutateAsync({ tasks: selectedTasks, modelId: null, modelText: "No model" }).catch(() => undefined)}
              busy={bulk.isPending}
              className="w-auto min-w-40"
            />
            <Button type="button" variant="quiet" size="sm" className="ml-auto" onClick={() => { setSelected(new Set()); setBulkRefused(null); }}>
              Done
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function QuickSetup({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const [result, setResult] = useState<ApplyResult | null>(null);
  const apply = useScopedMutation({
    mutationKey: ["mutation", "models.preset", organizationId],
    mutationFn: (preset: ModelPresetId) => applyModelPreset({ data: { organizationId, preset } }) as Promise<ApplyResult>,
    invalidate: () => [qk.generationModels(organizationId)],
    onSuccess: (answer) => setResult(answer as ApplyResult),
  });
  const set = result?.ok ? result.applied.filter((row) => row.saved && row.modelId).length : 0;
  const auto = result?.ok ? result.applied.filter((row) => row.saved && !row.modelId).length : 0;
  const refused = result ? result.applied.filter((row) => !row.saved) : [];

  return (
    <section aria-labelledby="presets-title" className="space-y-2">
      <h2 id="presets-title" className="eyebrow">Quick setup</h2>
      <ul className="grid gap-2 sm:grid-cols-3">
        {MODEL_PRESET_IDS.map((id) => (
          <li key={id} className={`flex items-center gap-2 p-3 ${PLATTER}`}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-fg-primary">{MODEL_PRESETS[id].label}</p>
              <p className="text-xs text-fg-muted">{MODEL_PRESETS[id].tagline}</p>
            </div>
            <InfoButton label={MODEL_PRESETS[id].label}>
              <p>{MODEL_PRESETS[id].description}</p>
              <p className="text-fg-muted">Sets every text task from the models OpenRouter lists right now. The Studio and decision models stay as they are.</p>
            </InfoButton>
            <Button type="button" variant="secondary" size="sm" disabled={!canAdmin || apply.isPending} onClick={() => void apply.mutateAsync(id).catch(() => undefined)}>
              {apply.isPending && apply.variables === id ? "Applying..." : "Apply"}
            </Button>
          </li>
        ))}
      </ul>
      {result ? (
        <div role="status" className="text-sm">
          {result.ok ? (
            <p className="text-fg-primary">
              {result.label} applied: {set} set{auto > 0 ? `, ${auto} on Auto` : ""}{refused.length > 0 ? `, ${refused.length} not saved` : ""}.
            </p>
          ) : (
            <p className="text-warning">{result.reason}</p>
          )}
          {refused.length > 0 ? (
            <ul className="mt-1 space-y-1 text-fg-muted">
              {refused.map((row) => <li key={row.task}><span className="text-fg-primary">{row.label}:</span> {row.reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TaskRow({
  organizationId,
  canAdmin,
  task,
  models,
  catalogueReason,
  selected,
  onSelect,
  busy,
}: {
  organizationId: string;
  canAdmin: boolean;
  task: TaskChoice;
  models: CatalogueModel[];
  catalogueReason: string | null;
  selected: boolean;
  onSelect: (on: boolean) => void;
  busy: boolean;
}) {
  const eligible = useMemo(() => modelsFor(models, task.task), [models, task.task]);
  const options = useMemo(() => textOptions(eligible), [eligible]);
  const current = task.saved ? (models.find((model) => model.id === task.saved!.modelId) ?? null) : null;
  const state = taskState(task);
  const save = useScopedMutation({
    mutationKey: ["mutation", "generation-model.save", organizationId, task.task],
    // A refusal is the server's own sentence, shown on the row; the stored choice is unchanged.
    mutationFn: async (input: { modelId: string | null; text: string }) =>
      (await saveGenerationModelChoice({ data: { organizationId, task: task.task, modelId: input.modelId } })) as SaveResult,
    invalidate: () => [qk.generationModels(organizationId)],
    success: (input, result) => (result.ok ? `${task.label}: ${input.text}.` : ""),
  });
  const refusal = save.data && !save.data.ok ? save.data.reason : null;

  const valueText =
    state === "chosen" ? shortName(current, task.saved!.modelId)
      : state === "auto" ? "Auto"
        : state === "default" ? "Default"
          : canAdmin ? "Choose a model" : "Not set";
  // A saved model that the catalogue no longer lists (once the catalogue has been read) is refused before each call, so it is shown as a warning.
  const tone: PickerTone = state === "unset" || (state === "chosen" && !current && models.length > 0) ? "warning" : state === "chosen" ? "chosen" : "muted";
  const id = `task-${task.task}`;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      {canAdmin ? <Checkbox aria-labelledby={`${id}-label`} checked={selected} onCheckedChange={(value) => onSelect(value === true)} /> : null}
      <span id={`${id}-label`} className="min-w-0 flex-1 text-sm text-fg-primary">{task.label}</span>
      <ModelPicker
        label={`Model for ${task.label}`}
        valueId={task.saved?.modelId ?? null}
        valueText={valueText}
        tone={tone}
        options={options}
        emptyText={catalogueReason ?? (models.length === 0 ? "The catalogue has not been read." : "No model matches.")}
        clear={task.saved ? { label: task.auto ? "Auto" : task.deploymentDefault ? "Default" : "No model", detail: fallbackText(task) } : null}
        onPick={(modelId) => void save.mutateAsync({ modelId, text: shortName(models.find((model) => model.id === modelId), modelId) }).catch(() => undefined)}
        onClear={() => void save.mutateAsync({ modelId: null, text: task.auto ? "back to Auto" : task.deploymentDefault ? "back to the default" : "no model" }).catch(() => undefined)}
        disabled={!canAdmin}
        busy={save.isPending || busy}
        className={PICKER_WIDTH}
      />
      <InfoButton label={task.label}>
        <p>{task.description}</p>
        {task.saved ? (
          <p className="text-fg-muted">
            Chosen {new Date(task.saved.updatedAt).toLocaleDateString("en-GB")}: <span className="font-mono text-xs [overflow-wrap:anywhere]">{task.saved.modelId}</span>
            {current ? `, ${priceLine(current)} tokens.` : models.length > 0 ? ". The live catalogue does not list it now, so each call is refused until another model is chosen." : "."}
          </p>
        ) : null}
        <p className="text-fg-muted">{fallbackText(task)}</p>
      </InfoButton>
      {refusal ? <p role="alert" className="basis-full text-sm text-danger">Not saved: {refusal}</p> : null}
    </li>
  );
}

type Seat = {
  task: string;
  label: string;
  description: string;
  kind: "image" | "video";
  saved: { modelId: string; updatedAt: string } | null;
  unavailable: string | null;
  models: Array<{ id: string; name: string; imageUsd: number | null; usdPerSecond: number | null }>;
};

function StudioPlatter({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const listing = useMediaModelsQuery(organizationId);
  const seats = ((listing.data as { seats: Seat[] } | undefined) ?? null)?.seats ?? null;
  const unavailable = seats?.find((seat) => seat.unavailable)?.unavailable ?? null;
  return (
    <section aria-labelledby="model-group-studio" className={PLATTER}>
      <header className="flex items-center gap-3 border-b border-hairline px-3 py-2">
        <h3 id="model-group-studio" className="eyebrow">Studio</h3>
      </header>
      {listing.isPending ? <p className="px-3 py-2 text-sm text-fg-muted">Reading the catalogue...</p> : null}
      {!listing.isPending && !seats ? <p className="px-3 py-2 text-sm text-warning">The Studio models could not be read.</p> : null}
      {unavailable ? <p className="px-3 pt-2 text-sm text-warning" role="status">{unavailable}</p> : null}
      {seats ? (
        <ul className="divide-y divide-hairline">
          {seats.map((seat) => <SeatRow key={seat.task} seat={seat} organizationId={organizationId} canAdmin={canAdmin} />)}
        </ul>
      ) : null}
    </section>
  );
}

function SeatRow({ seat, organizationId, canAdmin }: { seat: Seat; organizationId: string; canAdmin: boolean }) {
  const save = useScopedMutation({
    mutationKey: ["mutation", "models.studio", organizationId, seat.task],
    mutationFn: (modelId: string | null) => saveMediaModelChoice({ data: { organizationId, task: seat.task, modelId } }),
    invalidate: () => [qk.mediaModels(organizationId), qk.generationModels(organizationId), qk.providerSettings(organizationId)],
    success: (modelId, result) => {
      if (!result.ok) return "";
      return modelId === null ? `${seat.label}: the Studio's own providers.` : `${seat.label}: ${shortName(seat.models.find((model) => model.id === modelId), modelId)}.`;
    },
  });
  const refusal = save.data && !save.data.ok ? save.data.reason : null;
  const options: PickerOption[] = useMemo(
    () =>
      groupByProvider(seat.models).flatMap((group) =>
        group.models.map((model) => ({
          id: model.id,
          title: shortName(model),
          detail: seat.kind === "video" && model.usdPerSecond !== null ? `$${model.usdPerSecond.toFixed(3)} per second` : model.id,
          group: group.label,
        })),
      ),
    [seat],
  );
  const current = seat.saved ? (seat.models.find((model) => model.id === seat.saved!.modelId) ?? null) : null;
  const label = seat.kind === "image" ? "Images" : "Video";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="min-w-0 flex-1 text-sm text-fg-primary">{label}</span>
      <ModelPicker
        label={seat.label}
        valueId={seat.saved?.modelId ?? null}
        valueText={seat.saved ? shortName(current, seat.saved.modelId) : "Studio default"}
        tone={!seat.saved ? "muted" : current || seat.unavailable ? "chosen" : "warning"}
        options={options}
        emptyText={seat.unavailable ?? "No model matches."}
        clear={seat.saved ? { label: "Studio default", detail: "The Studio's own providers apply." } : null}
        onPick={(modelId) => void save.mutateAsync(modelId).catch(() => undefined)}
        onClear={() => void save.mutateAsync(null).catch(() => undefined)}
        disabled={!canAdmin}
        busy={save.isPending}
        className={PICKER_WIDTH}
      />
      <InfoButton label={seat.label}>
        <p>{seat.description}</p>
        {seat.saved ? (
          <p className="text-fg-muted">
            Chosen: <span className="font-mono text-xs [overflow-wrap:anywhere]">{seat.saved.modelId}</span>.
            {!current && !seat.unavailable ? " The live catalogue does not offer it for this seat now, so choose another model." : ""}
          </p>
        ) : null}
      </InfoButton>
      {refusal ? <p role="alert" className="basis-full text-sm text-danger">Not saved: {refusal}</p> : null}
    </li>
  );
}

type DecisionModel = { id: string; name: string; verified: boolean; promptUsdPerMillionTokens: number; created: number | null };
type DecisionListing = { ok: true; readAt: string; eligible: DecisionModel[] } | { ok: false; reason: string; eligible: [] };
type DecisionStatus = { active: { engineId: string }; openrouterModel?: { model: string; source: string; reason?: string } };
type CheckResult = { ok: boolean; status: "PASSED" | "FAILED" | "NOT_RUN"; message: string };

function DecisionPlatter({ ref, organizationId, canAdmin }: { ref: React.Ref<HTMLElement>; organizationId: string; canAdmin: boolean }) {
  const engines = useDecisionEnginesQuery(organizationId);
  const status = (engines.data as DecisionStatus | undefined) ?? null;
  const catalog = useOpenRouterDecisionModelsQuery(organizationId);
  const listing = (catalog.data as DecisionListing | undefined) ?? null;
  const eligible = listing?.ok ? listing.eligible : [];
  const latest = new Map(DECISION_FAMILIES.flatMap((family) => {
    const model = latestDecisionModel(eligible, family.id);
    return model ? [[model.id, "latest"] as const] : [];
  }));
  // Verified models first; the others are listed for what they are and cannot be picked yet (the server saves only verified ones).
  const options: PickerOption[] = groupByProvider(eligible)
    .flatMap((group) => group.models.map((model) => ({
      id: model.id,
      title: shortName(model),
      tag: latest.get(model.id) ?? null,
      detail: `$${model.promptUsdPerMillionTokens.toFixed(2)} in per M`,
      group: group.label,
      disabledReason: model.verified ? null : "Not verified by Meridian yet",
    })))
    .sort((a, b) => Number(Boolean(a.disabledReason)) - Number(Boolean(b.disabledReason)));
  const modelId = status?.openrouterModel?.model || null;
  const current = modelId ? (eligible.find((model) => model.id === modelId) ?? null) : null;
  const inUse = status?.active.engineId === "openrouter-decisions";

  const save = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.openrouter-model", organizationId],
    mutationFn: async (model: string) => (await saveOpenRouterDecisionModel({ data: { organizationId, model } })) as { ok: true; model: string } | { ok: false; reason: string },
    invalidate: () => [qk.decisionEngines(organizationId), qk.openRouterDecisionModels(organizationId)],
    success: (_model, result) => (result.ok ? `Decision model: ${shortName(eligible.find((item) => item.id === result.model), result.model)}. Check the connection before relying on it.` : ""),
  });
  const runCheck = useScopedMutation({
    mutationKey: ["mutation", "decision-engine.openrouter-test", organizationId],
    mutationFn: async () => (await testOpenRouterDecisionConnection({ data: { organizationId } })) as CheckResult,
    invalidate: () => [qk.decisionEngines(organizationId)],
  });
  const refusal = save.data && !save.data.ok ? save.data.reason : null;
  // The newest answer only: a check from before the model changed says nothing about the new one.
  const checkedAfterSave = runCheck.submittedAt > save.submittedAt;
  const check: CheckResult | null = !checkedAfterSave
    ? null
    : runCheck.data ?? (runCheck.error ? { ok: false, status: "NOT_RUN", message: errorText(runCheck.error) } : null);
  const { blocked: budgetBlocked } = budgetBlocker(check?.message ?? "");
  const capBlocked = /decision cap/i.test(check?.message ?? "") && !budgetBlocked;

  return (
    <section ref={ref} id="decision-model" aria-labelledby="decision-model-title" className={PLATTER}>
      <header className="flex items-center gap-3 border-b border-hairline px-3 py-2">
        <h3 id="decision-model-title" className="eyebrow">Decisions</h3>
        <span className="ml-auto text-xs text-fg-muted">{inUse ? "In use" : "Not in use"}</span>
      </header>
      <ul className="divide-y divide-hairline">
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <span className="min-w-0 flex-1 text-sm text-fg-primary">Decision model</span>
          <ModelPicker
            label="Decision model"
            valueId={modelId}
            valueText={modelId ? shortName(current, modelId) : canAdmin ? "Choose a model" : "Not set"}
            tone={modelId ? "chosen" : "warning"}
            options={options}
            emptyText={listing && !listing.ok ? listing.reason : catalog.isPending ? "Reading the catalogue..." : "No model matches."}
            onPick={(id) => void save.mutateAsync(id).catch(() => undefined)}
            disabled={!canAdmin}
            busy={save.isPending}
            className={PICKER_WIDTH}
          />
          <InfoButton label="the decision model">
            <p>Answers decisions and scoring when Decisions run on OpenRouter. Which engine runs them is chosen in Connections.</p>
            <p className="text-fg-muted">Only models Meridian has verified can be chosen. The newest of each family is marked latest.</p>
            {modelId ? <p className="text-fg-muted">Now: <span className="font-mono text-xs [overflow-wrap:anywhere]">{modelId}</span>.</p> : null}
          </InfoButton>
          {refusal ? <p role="alert" className="basis-full text-sm text-danger">Not saved: {refusal}</p> : null}
        </li>
        {canAdmin ? (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-0 flex-1 text-sm text-fg-muted">Connection</span>
            <Button type="button" variant="secondary" size="sm" disabled={runCheck.isPending || !modelId} onClick={() => void runCheck.mutateAsync(undefined).catch(() => undefined)}>
              {runCheck.isPending ? "Checking..." : "Check"}
            </Button>
            <InfoButton label="the connection check">
              <p>Sends one small real request to OpenRouter with this workspace's key, and may incur model usage. It changes no data and no engine.</p>
            </InfoButton>
            {check ? (
              <p role="status" className={`basis-full text-sm ${check.status === "PASSED" ? "text-success" : "text-warning"}`}>
                {check.status === "PASSED" ? "Passed. " : check.status === "FAILED" ? "Failed. " : "Not run. "}
                {check.message}
                {budgetBlocked ? <> <Link to="/billing" hash="monthly-budget" className="font-semibold underline underline-offset-2">Set the monthly budget</Link></> : null}
                {capBlocked ? <> <Link to="/billing" className="font-semibold underline underline-offset-2">Set the decision cap</Link></> : null}
              </p>
            ) : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function HoldsPlatter({ organizationId }: { organizationId: string }) {
  const holds = useUncertainHoldsQuery(organizationId);
  const count = ((holds.data as { holds?: unknown[] } | undefined)?.holds ?? []).length;
  return (
    // Its own height: opening it does not stretch the card beside it.
    <details className={`group self-start ${PLATTER}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 text-fg-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Held calls
        {holds.isSuccess ? (count > 0 ? <Badge variant="warning">{count} to check</Badge> : <span className="font-normal text-fg-muted">None</span>) : null}
      </summary>
      <div className="border-t border-hairline p-3">
        <UncertainHoldsPanel organizationId={organizationId} compact />
      </div>
    </details>
  );
}
