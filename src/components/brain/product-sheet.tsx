import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Button, Field, Sheet, SheetContent, SheetDescription, SheetTitle, Textarea, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { useDirtyDismiss } from "@/components/forms/use-dirty-dismiss";
import { plainError } from "@/lib/copy";
import { saveProduct, type ProductRow } from "@/lib/meridian/api";
import { productFieldsSchema, type ProductFields, type ProductFieldsInput } from "@/lib/meridian/schemas/product";
import { useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

const blank: ProductFieldsInput = {
  name: "",
  description: "",
  features: "",
  benefits: "",
  price: "",
  url: "",
  allowedClaims: "",
  prohibitedClaims: "",
};

function valuesFor(product: ProductRow | null): ProductFieldsInput {
  if (!product) return blank;
  return {
    name: product.name,
    description: product.description,
    features: product.features,
    benefits: product.benefits,
    price: product.price,
    url: product.url,
    allowedClaims: product.allowedClaims,
    prohibitedClaims: product.prohibitedClaims,
  };
}

/**
 * Add or edit a product in a Sheet. The sheet is a bottom drawer on every screen width. The form keeps
 * the product schema's validation. Escape, the close button and the outside click all ask before closing with unsaved edits.
 */
export function ProductSheet({ brandId, open, product, onOpenChange }: {
  brandId: string;
  open: boolean;
  /** null adds a product. */
  product: ProductRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<ProductFieldsInput, unknown, ProductFields>({
    resolver: zodResolver(productFieldsSchema),
    defaultValues: blank,
    mode: "onBlur",
  });
  const saveProductMutation = useScopedMutation({
    mutationKey: ["mutation", "product.save", brandId],
    mutationFn: (values: ProductFields) => saveProduct({ data: { brandId, productId: product?.id ?? "", ...values } }),
    invalidate: () => [qk.brand(brandId)],
    success: "Product saved.",
  });
  const pending = saveProductMutation.isPending;
  const saveError = saveProductMutation.error ? plainError(saveProductMutation.error) : null;
  const dirty = open && isDirty;
  const dismiss = useDirtyDismiss({
    dirty,
    onOpenChange,
    onDiscard: () => reset(valuesFor(product)),
  });

  // Each time the sheet opens, load the chosen product, or a blank form for a new one.
  useEffect(() => {
    if (open) reset(valuesFor(product));
  }, [open, product, reset]);

  async function submit(values: ProductFields) {
    const saved = await saveProductMutation.mutateAsync(values).then(() => true, () => false);
    if (saved) {
      // Saved values become the baseline, so closing after a save is not a discard.
      reset(values, { keepValues: true });
      onOpenChange(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={dismiss.requestOpenChange}>
      <UnsavedChangesGuard dirty={dirty} />
      <SheetContent aria-describedby="product-sheet-description" className="flex max-h-[92vh] flex-col overflow-hidden">
        <SheetTitle className="font-display text-2xl">{product ? "Edit product" : "Add product"}</SheetTitle>
        <SheetDescription id="product-sheet-description" className="mt-1 text-sm text-fg-muted">
          Product details and claim rules are used when creative evidence is checked.
        </SheetDescription>
        {/* The fields scroll inside the sheet; the actions stay pinned below them, so they are always reachable. */}
        <form onSubmit={handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto pb-2 md:grid-cols-2">
          <Field label="Name" error={errors.name?.message} required>
            <Input {...register("name")} required maxLength={160} />
          </Field>
          <Field label="Price" error={errors.price?.message}>
            <Input {...register("price")} maxLength={80} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Description" error={errors.description?.message}>
              <Textarea {...register("description")} maxLength={4000} />
            </Field>
          </div>
          <Field label="Features" error={errors.features?.message}>
            <Textarea {...register("features")} maxLength={4000} />
          </Field>
          <Field label="Benefits" error={errors.benefits?.message}>
            <Textarea {...register("benefits")} maxLength={4000} />
          </Field>
          <Field label="Allowed claims" error={errors.allowedClaims?.message}>
            <Textarea {...register("allowedClaims")} maxLength={2000} />
          </Field>
          <Field label="Prohibited claims" error={errors.prohibitedClaims?.message}>
            <Textarea {...register("prohibitedClaims")} maxLength={2000} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Product URL" error={errors.url?.message}>
              <Input {...register("url")} maxLength={500} placeholder="https://example.test" />
            </Field>
          </div>
          {saveError ? <div className="md:col-span-2"><PlainErrorMessage message={saveError.message} raw={saveError.raw} /></div> : null}
          <UnsavedChangesBar
            dirty={isDirty}
            subject="product"
            confirming={dismiss.confirming}
            onConfirmingChange={dismiss.setConfirming}
            onDiscard={dismiss.discard}
            className="md:col-span-2"
          />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-border pt-4">
          <Button type="submit" disabled={pending || isSubmitting}>
            {pending || isSubmitting ? "Saving…" : product ? "Update product" : "Add product"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => dismiss.requestOpenChange(false)}>Cancel</Button>
        </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
