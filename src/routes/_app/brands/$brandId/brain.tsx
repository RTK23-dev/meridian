import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { BrandNav } from "@/components/brand-nav";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, TextArea } from "@/components/ui";
import { errorText } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { saveBrain } from "@/lib/meridian/api";
import { storeMaterial, uploadLogo } from "@/lib/meridian/machine";
import {
  AUTOMATION_LEVELS,
  BRAIN_FIELDS,
  emptyBrain,
  provenanceLabel,
  type BrainValues,
} from "@/lib/meridian/brain";
import { useAssetsQuery, useBrandQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { brainValuesSchema, type BrainFieldsInput } from "@/lib/meridian/schemas/brain";

export const Route = createFileRoute("/_app/brands/$brandId/brain")({ component: BrainPage });

function BrainPage() {
  const { brandId } = Route.useParams();
  return (
    <BrainEditor brandId={brandId} />
  );
}

function BrainEditor({ brandId }: { brandId: string }) {
  const query = useBrandQuery(brandId);
  const detail = query.data ?? null;
  const [discardRequested, setDiscardRequested] = useState(false);
  const { register, handleSubmit, reset, watch, formState: { errors, isDirty, isSubmitting } } = useForm<BrainFieldsInput>({
    resolver: zodResolver(brainValuesSchema),
    defaultValues: emptyBrain(),
    mode: "onBlur",
  });
  const brain = watch();
  const { reload } = useWorkspace();
  const saveBrainMutation = useScopedMutation({
    mutationKey: ["mutation", "brain.save", brandId],
    mutationFn: (values: BrainValues) => saveBrain({ data: { brandId, ...values } }),
    invalidate: () => [qk.brand(brandId)],
    success: "Brain saved.",
    // Brain completeness is part of the workspace list and the brand switcher, so the workspace reloads.
    onSuccess: () => reload(),
  });
  const pending = saveBrainMutation.isPending;
  const saveError = saveBrainMutation.error ? errorText(saveBrainMutation.error) : null;

  useEffect(() => {
    if (detail && !isDirty) reset(detail.brain);
  }, [detail, isDirty, reset]);

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);

  if (query.isError && !detail) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!detail) return <ScreenSkeleton label="Loading brand brain" shape="form" />;
  const canEdit = hasRole(detail.identity.role, "member");
  const groups = [...new Set(BRAIN_FIELDS.map((field) => field.group))];
  const filledFields = BRAIN_FIELDS.filter((field) => brain[field.key].trim()).length;
  const completeness = Math.round((filledFields / BRAIN_FIELDS.length) * 100);

  async function submit(values: BrainValues) {
    const saved = await saveBrainMutation.mutateAsync(values).then(() => true, () => false);
    if (saved) {
      reset(values);
      setDiscardRequested(false);
    }
  }

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <form onSubmit={handleSubmit(submit)} className="space-y-8" onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}>
      <div className="space-y-2">
        <Link to="/brands/$brandId" params={{ brandId }} className="text-sm text-muted">
          {detail.identity.name}
        </Link>
        <h1 className="font-display text-4xl">Brand brain</h1>
        <p className="max-w-2xl text-muted">
          This is the record later decisions must use. Saving never silently replaces a field you did not change.
          Page suggestions, when a model is configured, stay pending until you accept them.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-5 rounded-lg border border-line bg-panel p-4">
        <div role="img" aria-label={`Brand brain ${completeness}% complete`} className="grid size-16 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(var(--color-accent) ${completeness}%, var(--color-line) 0)` }}>
          <span className="grid size-12 place-items-center rounded-full bg-panel text-sm font-semibold">{completeness}%</span>
        </div>
        <div className="min-w-40 flex-1"><p className="font-semibold">Brand profile completeness</p><p className="text-sm text-muted">{filledFields} of {BRAIN_FIELDS.length} fields currently have content. Save to store changes; empty fields are not inferred.</p></div>
        <nav aria-label="Brand brain sections" className="flex flex-wrap gap-2">{groups.map((group) => <a key={group} href={`#brain-${group.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`} className="rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2">{group}</a>)}</nav>
      </div>
      {groups.map((group) => (
        <section id={`brain-${group.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`} key={group} className="scroll-mt-6 space-y-4">
          <h2 className="font-display text-2xl">{group}</h2>
          <div className="grid gap-4">
            {BRAIN_FIELDS.filter((field) => field.group === group).map((field) => {
              const source = detail.provenance[field.key];
              return (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={brain[field.key].trim() && source ? provenanceLabel(source) : "Empty. Not inferred."}
                  error={errors[field.key]?.message}
                >
                  <TextArea
                    {...register(field.key)}
                    disabled={!canEdit}
                    maxLength={4000}
                  />
                </Field>
              );
            })}
          </div>
        </section>
      ))}
      <Field
        label="Automation preference"
        hint="Stored only. Nothing is published or approved because this preference is set."
      >
        <SelectInput
          {...register("automationLevel")}
          disabled={!canEdit}
        >
          {AUTOMATION_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </SelectInput>
      </Field>
      {errors.automationLevel?.message ? <p role="alert" className="text-sm text-danger">{errors.automationLevel.message}</p> : null}
      {saveError ? <Notice>{saveError}</Notice> : null}
      {isDirty ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm" role="status"><span>{discardRequested ? "Discard your unsaved brain changes?" : "Unsaved changes"}</span>{discardRequested ? <div className="flex gap-2"><Button type="button" variant="quiet" onClick={() => setDiscardRequested(false)}>Continue editing</Button><Button type="button" variant="danger" onClick={() => { reset(detail.brain); setDiscardRequested(false); }}>Discard changes</Button></div> : <Button type="button" variant="quiet" onClick={() => setDiscardRequested(true)}>Discard changes</Button>}</div> : null}
      {canEdit ? <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Saving…" : "Save brain"}</Button> : null}
      <Panel>
        <h2 className="font-display text-xl">Versions</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {detail.versions.map((version) => (
            <li key={version.version} className="flex justify-between gap-3">
              <span>Version {version.version} · {version.note}</span>
              <span className="text-muted">{version.createdAt.slice(0, 16).replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </form>
      <Materials brandId={brandId} canEdit={canEdit} />
    </div>
  );
}

function Materials({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const assetsQuery = useAssetsQuery(brandId);
  const logos = assetsQuery.data?.logos ?? [];
  const uploadLogoMutation = useScopedMutation({
    mutationKey: ["mutation", "brand.logo", brandId],
    mutationFn: (base64: string) => uploadLogo({ data: { brandId, base64 } }),
    invalidate: () => [qk.assets(brandId)],
    success: (_base64, saved) => saved.status === "stored" ? "Logo stored." : saved.detail,
    onSuccess: (saved) => setNote(saved.status === "stored" ? "Logo stored." : saved.detail),
  });
  const materialMutation = useScopedMutation({
    mutationKey: ["mutation", "brand.material", brandId],
    mutationFn: (vars: { filename: string; mime: string; text: string; base64: string }) => storeMaterial({ data: { brandId, ...vars } }),
    // Stored material adds source documents, which the brand overview counts.
    invalidate: () => [qk.assets(brandId), qk.machine(brandId)],
    success: (_vars, saved) => saved.detail,
    onSuccess: (saved) => setNote(saved.detail),
  });
  const pending = uploadLogoMutation.isPending || materialMutation.isPending;
  const failure = uploadLogoMutation.error ?? materialMutation.error;
  const error = failure ? errorText(failure) : null;

  return (
    <div className="space-y-4">
      <Panel>
        <h2 className="font-display text-2xl">Logo</h2>
        <p className="mt-2 text-sm text-muted">PNG, JPEG, or WEBP, checked from the file bytes and stored with this brand. There is no separate object store.</p>
        {assetsQuery.error ? <ErrorState message={errorText(assetsQuery.error)} onRetry={() => void assetsQuery.refetch()} /> : null}
        {logos[0] ? <img src={`data:${logos[0].mime};base64,${logos[0].body}`} alt="Stored logo" className="mt-3 h-16 w-auto" /> : assetsQuery.error ? null : <p className="mt-3 text-muted">No logo stored.</p>}
        {canEdit ? (
          <label className="mt-3 block space-y-2 text-sm font-semibold">
            Upload brand logo
            <input
              className="block w-full min-w-0 text-sm font-normal"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const raw = String(reader.result ?? "");
                  const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
                  void uploadLogoMutation.mutateAsync(base64).catch(() => undefined);
                };
                reader.readAsDataURL(file);
              }}
            />
          </label>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Source material</h2>
        <p className="mt-2 text-sm text-muted">Plain text, DOCX, and PDF text can be stored. Instruction-like lines are dropped. An image-only PDF fails. Nothing here overwrites the brain.</p>
        {canEdit ? (
          <form
            className="mt-3 space-y-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = event.currentTarget;
              const text = String(new FormData(form).get("material") ?? "");
              void materialMutation.mutateAsync({ filename: "pasted.txt", mime: "text/plain", text, base64: "" }).then(() => form.reset(), () => undefined);
            }}
          >
            <label className="block space-y-2 text-sm font-semibold">
              Upload text, DOCX, or PDF
              <input
                className="block w-full text-sm font-normal"
                type="file"
                accept=".txt,.md,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                aria-describedby="material-file-hint"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const raw = String(reader.result ?? "");
                    const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
                    void materialMutation.mutateAsync({ filename: file.name, mime: file.type || "application/octet-stream", text: "", base64 }).catch(() => undefined);
                  };
                  reader.readAsDataURL(file);
                }}
              />
              <span id="material-file-hint" className="block font-normal text-muted">The file is stored as untrusted text. It does not change the brain.</span>
            </label>
            <TextArea name="material" aria-label="Pasted source text" placeholder="Or paste brand or product text" />
            <Button type="submit" disabled={pending}>Store pasted text</Button>
          </form>
        ) : null}
      </Panel>
      {error ? <Notice>{error}</Notice> : null}
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}
