import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button, Field, Notice, Sheet, SheetContent, SheetDescription, SheetTitle, TextArea, TextInput, errorText } from "@/components/ui";
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
 * the product schema's validation, and closing with unsaved edits asks first.
 */
export function ProductSheet({ brandId, open, product, onOpenChange }: {
  brandId: string;
  open: boolean;
  /** null adds a product. */
  product: ProductRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [discardRequested, setDiscardRequested] = useState(false);
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
  const saveError = saveProductMutation.error ? errorText(saveProductMutation.error) : null;

  // Each time the sheet opens, load the chosen product, or a blank form for a new one.
  useEffect(() => {
    if (!open) return;
    reset(valuesFor(product));
    setDiscardRequested(false);
  }, [open, product, reset]);

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);

  async function submit(values: ProductFields) {
    const saved = await saveProductMutation.mutateAsync(values).then(() => true, () => false);
    if (saved) onOpenChange(false);
  }

  function requestClose() {
    if (isDirty) {
      setDiscardRequested(true);
      return;
    }
    onOpenChange(false);
  }

  function discardChanges() {
    reset(valuesFor(product));
    setDiscardRequested(false);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else requestClose(); }}>
      <SheetContent aria-describedby="product-sheet-description" className="flex max-h-[92vh] flex-col overflow-hidden">
        <SheetTitle className="font-display text-2xl">{product ? "Edit product" : "Add product"}</SheetTitle>
        <SheetDescription id="product-sheet-description" className="mt-1 text-sm text-fg-muted">
          Product details and claim rules are used when creative evidence is checked.
        </SheetDescription>
        {/* The fields scroll inside the sheet; the actions stay pinned below them, so they are always reachable. */}
        <form onSubmit={handleSubmit(submit)} className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto pb-2 md:grid-cols-2">
          <Field label="Name" error={errors.name?.message} required>
            <TextInput {...register("name")} required maxLength={160} />
          </Field>
          <Field label="Price" error={errors.price?.message}>
            <TextInput {...register("price")} maxLength={80} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Description" error={errors.description?.message}>
              <TextArea {...register("description")} maxLength={4000} />
            </Field>
          </div>
          <Field label="Features" error={errors.features?.message}>
            <TextArea {...register("features")} maxLength={4000} />
          </Field>
          <Field label="Benefits" error={errors.benefits?.message}>
            <TextArea {...register("benefits")} maxLength={4000} />
          </Field>
          <Field label="Allowed claims" error={errors.allowedClaims?.message}>
            <TextArea {...register("allowedClaims")} maxLength={2000} />
          </Field>
          <Field label="Prohibited claims" error={errors.prohibitedClaims?.message}>
            <TextArea {...register("prohibitedClaims")} maxLength={2000} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Product URL" error={errors.url?.message}>
              <TextInput {...register("url")} maxLength={500} placeholder="https://example.test" />
            </Field>
          </div>
          {saveError ? <div className="md:col-span-2"><Notice>{saveError}</Notice></div> : null}
          {isDirty ? (
            <div role="status" className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm">
              <span>{discardRequested ? "Discard your unsaved product changes?" : "Unsaved changes"}</span>
              {discardRequested ? (
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => setDiscardRequested(false)}>Continue editing</Button>
                  <Button type="button" variant="danger" onClick={discardChanges}>Discard changes</Button>
                </div>
              ) : (
                <Button type="button" variant="secondary" onClick={requestClose}>Discard changes</Button>
              )}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-border pt-4">
          <Button type="submit" disabled={pending || isSubmitting}>
            {pending || isSubmitting ? "Saving…" : product ? "Update product" : "Add product"}
          </Button>
          <Button type="button" variant="secondary" onClick={requestClose}>Cancel</Button>
        </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
