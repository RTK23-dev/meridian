import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Field, TextArea, TextInput,
  errorText,
} from "@/components/ui";
import { FormError } from "@/components/settings/form-error";
import { plainServerError } from "@/components/settings/form-model";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { updateBrand, type BrandDetail } from "@/lib/meridian/api";
import { brandIdentitySchema, type BrandIdentity, type BrandIdentityInput } from "@/lib/meridian/schemas/brand";
import { useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { useWorkspace } from "@/components/workspace";

function savedValuesOf(detail: BrandDetail) {
  return { ...detail.identity, targetCustomers: detail.brain.targetCustomers };
}

/**
 * Identity fields in a collapsible card. The form stays mounted while closed, so an unsaved edit is not lost when the card
 * is folded away. A closed card is hidden by the disclosure, which removes it from the accessibility tree.
 */
export function BrandDetailsCard({ brandId, detail, canEdit }: { brandId: string; detail: BrandDetail; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [discardRequested, setDiscardRequested] = useState(false);
  const { reload } = useWorkspace();
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<BrandIdentityInput, unknown, BrandIdentity>({
    resolver: zodResolver(brandIdentitySchema),
    defaultValues: { name: "", description: "", category: "", industry: "", website: "", country: "", sells: "", targetCustomers: "" },
    mode: "onBlur",
  });
  const saveBrand = useScopedMutation({
    mutationKey: ["mutation", "brand.update", brandId],
    mutationFn: (values: BrandIdentity) => updateBrand({ data: { brandId, ...values } }),
    invalidate: () => [qk.brand(brandId), qk.machine(brandId)],
    success: "Brand details saved.",
    onSuccess: () => reload(),
  });
  const rawSaveError = saveBrand.error ? errorText(saveBrand.error) : null;
  const savedValues = savedValuesOf(detail);

  // A fresh server copy replaces the form only while there are no edits in progress.
  useEffect(() => {
    if (isDirty) return;
    reset(savedValuesOf(detail));
  }, [detail, isDirty, reset]);

  async function submit(values: BrandIdentity) {
    const saved = await saveBrand.mutateAsync(values).then(() => true, () => false);
    // Text typed while the save was running stays. Only the saved baseline moves.
    if (saved) reset(values, { keepValues: true });
  }

  return (
    <section aria-labelledby="brand-details-title" className="rounded-lg border border-border bg-surface">
      <UnsavedChangesGuard dirty={isDirty} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="min-w-0 space-y-1">
            <h2 id="brand-details-title" className="text-base font-semibold text-fg">Brand details</h2>
            <p className="text-sm text-fg-muted">Name, website, market, and what you sell. Changes save to this brand record.</p>
            {isDirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
          </div>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="secondary" size="md">{open ? "Hide details" : "Edit details"}</Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent forceMount>
          <form onSubmit={handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="grid gap-4 border-t border-border p-5 md:grid-cols-2">
            <Field label="Name" error={errors.name?.message} required><TextInput {...register("name")} maxLength={120} required disabled={!canEdit} /></Field>
            <Field label="Website" error={errors.website?.message}><TextInput {...register("website")} maxLength={500} disabled={!canEdit} /></Field>
            <Field label="Industry" error={errors.industry?.message}><TextInput {...register("industry")} maxLength={120} disabled={!canEdit} /></Field>
            <Field label="Category" error={errors.category?.message}><TextInput {...register("category")} maxLength={120} disabled={!canEdit} /></Field>
            <Field label="Country or market" error={errors.country?.message}><TextInput {...register("country")} maxLength={80} disabled={!canEdit} /></Field>
            <div className="md:col-span-2"><Field label="What you sell" error={errors.sells?.message}><TextArea {...register("sells")} maxLength={500} disabled={!canEdit} /></Field></div>
            <div className="md:col-span-2"><Field label="Description" error={errors.description?.message}><TextArea {...register("description")} maxLength={2000} disabled={!canEdit} /></Field></div>
            {rawSaveError ? <div className="md:col-span-2"><FormError message={plainServerError(rawSaveError, "brand")} raw={rawSaveError} /></div> : null}
            <div className="md:col-span-2">
              <UnsavedChangesBar
                dirty={isDirty}
                subject="brand details"
                confirming={discardRequested}
                onConfirmingChange={setDiscardRequested}
                onDiscard={() => { reset(savedValues); setDiscardRequested(false); }}
              />
            </div>
            {canEdit ? (
              <div className="md:col-span-2">
                <Button type="submit" disabled={saveBrand.isPending || isSubmitting}>{saveBrand.isPending || isSubmitting ? "Saving…" : "Save brand details"}</Button>
              </div>
            ) : <p className="text-sm text-fg-muted md:col-span-2">Viewers can read these details. A member or admin can change them.</p>}
          </form>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
