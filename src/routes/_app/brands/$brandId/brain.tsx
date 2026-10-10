import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FieldErrors, UseFormRegister } from "react-hook-form";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, Field, ScreenSkeleton, SelectInput, TextArea,
} from "@/components/ui";
import { PlainErrorMessage, PlainErrorState } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { useWorkspace } from "@/components/workspace";
import { BrainMiniNav, type MiniNavItem } from "@/components/brain/brain-mini-nav";
import { BRAIN_SECTIONS, sectionAnchor, sectionProgress, type BrainSectionId } from "@/components/brain/brain-sections";
import { CompletenessRing } from "@/components/brain/completeness-ring";
import { LogoUploader } from "@/components/brain/logo-uploader";
import { SourceMaterial } from "@/components/brain/source-material";
import { AutosaveIndicator } from "@/components/brain/autosave-status";
import { brainChanged } from "@/components/brain/brain-autosave";
import { useBrainAutosave } from "@/components/brain/use-brain-autosave";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { hasRole } from "@/lib/meridian/access";
import { saveBrain } from "@/lib/meridian/api";
import {
  AUTOMATION_LEVELS,
  BRAIN_FIELDS,
  brainCompleteness,
  emptyBrain,
  provenanceLabel,
  type BrainKey,
  type BrainValues,
  type ProvenanceMap,
} from "@/lib/meridian/brain";
import { brainValuesSchema, type BrainFieldsInput } from "@/lib/meridian/schemas/brain";
import { useBrandQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk, userScopedQueryKey } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/brands/$brandId/brain")({ staticData: { pageTitle: "Brand brain" }, component: BrainPage });

function BrainPage() {
  const { brandId } = Route.useParams();
  return (
    <BrainEditor brandId={brandId} />
  );
}

type FormShared = {
  register: UseFormRegister<BrainFieldsInput>;
  errors: FieldErrors<BrainFieldsInput>;
  values: BrainFieldsInput;
  provenance: ProvenanceMap;
  canEdit: boolean;
};

function BrainEditor({ brandId }: { brandId: string }) {
  const query = useBrandQuery(brandId);
  const detail = query.data ?? null;
  const canEdit = detail ? hasRole(detail.identity.role, "member") : false;
  const queryClient = useQueryClient();
  const { user } = useCurrentUserState();
  const [discardRequested, setDiscardRequested] = useState(false);
  const [formReady, setFormReady] = useState(false);
  const { register, handleSubmit, reset, trigger, getValues, watch, formState: { errors, isSubmitting } } = useForm<BrainFieldsInput>({
    resolver: zodResolver(brainValuesSchema),
    defaultValues: emptyBrain(),
    mode: "onBlur",
  });
  const brain = watch();
  const { reload } = useWorkspace();
  const serverSaved = detail?.brain ?? null;
  const autosave = useBrainAutosave({
    canEdit,
    serverSaved,
    watchKey: JSON.stringify(brain),
    readForm: () => getValues(),
    // Autosave writes through the same call as the Save button. Only the refresh differs: it does not show a toast.
    persist: async (values) => {
      await saveBrain({ data: { brandId, ...values } });
      await queryClient.invalidateQueries({ queryKey: userScopedQueryKey(user?.id ?? null, qk.brand(brandId)) });
      void reload();
    },
    onRejected: () => { void trigger(); },
  });
  const saved = autosave.saved;
  // Compared the way Save reads the fields, so a stray space is not a change. Before the saved brain loads, nothing is dirty.
  const dirty = formReady && saved !== null && brainChanged(brain, saved);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  const saveBrainMutation = useScopedMutation({
    mutationKey: ["mutation", "brain.save", brandId],
    mutationFn: (values: BrainValues) => saveBrain({ data: { brandId, ...values } }),
    invalidate: () => [qk.brand(brandId)],
    success: "Brain saved.",
    // Brain completeness is part of the workspace list and the brand switcher, so the workspace reloads.
    onSuccess: () => reload(),
  });
  const pending = saveBrainMutation.isPending;
  const saveError = saveBrainMutation.error ? plainError(saveBrainMutation.error) : null;

  // A fresh server copy replaces the form, unless the person has edits in progress. Those are kept.
  useEffect(() => {
    if (!detail || dirtyRef.current) return;
    reset(detail.brain);
    setFormReady(true);
  }, [detail, reset]);

  if (query.isError && !detail) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!detail) return <ScreenSkeleton label="Loading brand brain" shape="form" />;
  const completeness = brainCompleteness(brain);
  // Ctrl or Cmd + Enter saves only from a brain text field, not from the paste box. Leaving a brain field saves it at once.
  const shared: FormShared = { register, errors, values: brain, provenance: detail.provenance, canEdit };
  const navItems: MiniNavItem[] = BRAIN_SECTIONS.map((section) => ({ id: section.id, label: section.label, ...sectionProgress(section.keys, brain) }));
  const sectionFor = (id: BrainSectionId) => BRAIN_SECTIONS.find((section) => section.id === id);
  const progressFor = (id: BrainSectionId) => navItems.find((item) => item.id === id);

  async function submit(values: BrainValues) {
    // The manual save waits behind any autosave in progress, so the two never overlap.
    const ok = await autosave.saveManual(values, async () => { await saveBrainMutation.mutateAsync(values); }).then(() => true, () => false);
    if (ok) {
      // Text typed while the save was running stays in the form. Only the saved baseline moves.
      reset(values, { keepValues: true });
      setDiscardRequested(false);
    }
  }

  function discardChanges() {
    if (saved) reset(saved);
    setDiscardRequested(false);
  }

  return (
    <div className="space-y-8">
      <UnsavedChangesGuard dirty={dirty} />
      <form
        onSubmit={handleSubmit(submit)}
        className="space-y-8"
        onKeyDown={(event) => submitOnShortcut(event, "[data-brain-field]")}
        onBlur={(event) => {
          if ((event.target as HTMLElement).closest("[data-brain-field]")) autosave.flush();
        }}
      >
        <div className="space-y-2">
          <Link to="/brands/$brandId" params={{ brandId }} className="text-sm text-fg-muted underline-offset-4 hover:underline">
            {detail.identity.name}
          </Link>
          <h1 className="font-display text-4xl">Brand brain</h1>
          <p className="max-w-2xl text-fg-muted">
            This is the record later decisions must use. Saving never silently replaces a field you did not change.
            Page suggestions, when a model is configured, stay pending until you accept them.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-5 rounded-lg border border-border bg-surface p-5">
          <CompletenessRing filled={completeness.filled} total={completeness.total} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold">Brand profile completeness</p>
            <p className="text-sm text-fg-muted">
              {completeness.filled} of {completeness.total} fields currently have content. Save to store changes; empty fields are not inferred.
            </p>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <BrainMiniNav items={navItems} />

          <div className="min-w-0 space-y-10">
            <SectionFrame id="identity" label="Identity" progress={progressFor("identity")}>
              <dl className="grid gap-3 rounded-lg border border-border bg-surface p-4 text-sm sm:grid-cols-2">
                {[
                  ["Brand name", detail.identity.name],
                  ["Category", detail.identity.category],
                  ["Industry", detail.identity.industry],
                  ["Website", detail.identity.website],
                  ["Country or market", detail.identity.country],
                  ["Sells", detail.identity.sells],
                ].map(([term, value]) => (
                  <div key={term} className="min-w-0">
                    <dt className="text-fg-muted">{term}</dt>
                    <dd className="break-words font-semibold">{value || "Not set"}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-fg-muted">
                These facts are edited on the <Link to="/brands/$brandId" params={{ brandId }} className="underline underline-offset-4">brand overview</Link>.
              </p>
              <FieldList keys={sectionFor("identity")?.keys ?? []} shared={shared} />
            </SectionFrame>

            <SectionFrame id="positioning" label="Positioning" progress={progressFor("positioning")}>
              <FieldList keys={sectionFor("positioning")?.keys ?? []} shared={shared} />
            </SectionFrame>

            <SectionFrame id="audience" label="Audience" progress={progressFor("audience")}>
              <FieldList keys={sectionFor("audience")?.keys ?? []} shared={shared} />
            </SectionFrame>

            <SectionFrame id="voice" label="Voice" progress={progressFor("voice")}>
              <FieldList keys={sectionFor("voice")?.keys ?? []} shared={shared} />
            </SectionFrame>

            <SectionFrame id="rules" label="Rules" progress={progressFor("rules")}>
              <p className="text-sm text-fg-muted">Prohibited claims are needed by the claim check, so keep them current.</p>
              <FieldList keys={sectionFor("rules")?.keys ?? []} shared={shared} />
              <Field
                label="Automation preference"
                hint="Stored only. Nothing is published or approved because this preference is set."
              >
                <SelectInput {...register("automationLevel")} disabled={!canEdit}>
                  {AUTOMATION_LEVELS.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </SelectInput>
              </Field>
              {errors.automationLevel?.message ? <p role="alert" className="text-sm text-danger">{errors.automationLevel.message}</p> : null}
            </SectionFrame>

            <SectionFrame id="assets" label="Assets" progress={progressFor("assets")}>
              <FieldList keys={sectionFor("assets")?.keys ?? []} shared={shared} />
              <LogoUploader brandId={brandId} canEdit={canEdit} />
              <SourceMaterial brandId={brandId} canEdit={canEdit} saved={detail.brain} formDirty={dirty} />
            </SectionFrame>
          </div>
        </div>

        <div className="sticky bottom-0 z-10 space-y-3 rounded-lg border border-border bg-surface p-4 shadow-md">
          {saveError ? <PlainErrorMessage message={saveError.message} raw={saveError.raw} /> : null}
          <UnsavedChangesBar
            dirty={dirty}
            subject="brain"
            confirming={discardRequested}
            onConfirmingChange={setDiscardRequested}
            onDiscard={discardChanges}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <AutosaveIndicator status={autosave.status} canEdit={canEdit} />
            {canEdit ? (
              <Button type="submit" disabled={pending || isSubmitting || autosave.status.kind === "saving"}>{pending || isSubmitting ? "Saving…" : "Save brain"}</Button>
            ) : null}
          </div>
          {!canEdit ? <p className="text-sm text-fg-muted">You can read this brain. Changing it needs a member role.</p> : null}
        </div>
      </form>

      <Card>
        <h2 className="font-display text-xl">Versions</h2>
        {detail.versions.length === 0 ? <p className="mt-3 text-sm text-fg-muted">No versions stored yet.</p> : (
          <ul className="mt-3 space-y-2 text-sm">
            {detail.versions.map((version) => (
              <li key={version.version} className="flex flex-wrap justify-between gap-3">
                <span>Version {version.version} · {version.note}</span>
                <span className="text-fg-muted">{version.createdAt.slice(0, 16).replace("T", " ")}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SectionFrame({ id, label, progress, children }: { id: BrainSectionId; label: string; progress: MiniNavItem | undefined; children: ReactNode }) {
  const anchor = sectionAnchor(id);
  return <section id={anchor} aria-labelledby={`${anchor}-title`} className="scroll-mt-6 space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id={`${anchor}-title`} className="font-display text-2xl">{label}</h2>
      {progress ? <p className="text-sm tabular-nums text-fg-muted">{progress.filled} of {progress.total} filled</p> : null}
    </div>
    {children}
  </section>;
}

function FieldList({ keys, shared }: { keys: readonly BrainKey[]; shared: FormShared }) {
  if (keys.length === 0) return null;
  return <div className="grid gap-4">
    {keys.map((key) => <BrainTextField key={key} fieldKey={key} shared={shared} />)}
  </div>;
}

function BrainTextField({ fieldKey, shared }: { fieldKey: BrainKey; shared: FormShared }) {
  const meta = BRAIN_FIELDS.find((field) => field.key === fieldKey);
  const value = shared.values[fieldKey] ?? "";
  const source = shared.provenance[fieldKey];
  return <Field
    label={meta?.label ?? fieldKey}
    hint={value.trim() && source ? provenanceLabel(source) : "Empty. Not inferred."}
    error={shared.errors[fieldKey]?.message}
  >
    <TextArea {...shared.register(fieldKey)} data-brain-field="" disabled={!shared.canEdit} maxLength={4000} />
  </Field>;
}
