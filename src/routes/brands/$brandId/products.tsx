import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, ErrorState, Field, Notice, Panel, Skeleton, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { deleteProduct, saveProduct, type ProductRow } from "@/lib/meridian/api";
import { useBrandQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { productFieldsSchema, type ProductFields, type ProductFieldsInput } from "@/lib/meridian/schemas/product";

export const Route = createFileRoute("/brands/$brandId/products")({ component: ProductsPage });

const blank = {
  name: "",
  description: "",
  features: "",
  benefits: "",
  price: "",
  url: "",
  allowedClaims: "",
  prohibitedClaims: "",
};

function ProductsPage() {
  const { brandId } = Route.useParams();
  return (
    <Products brandId={brandId} />
  );
}

function Products({ brandId }: { brandId: string }) {
  const query = useBrandQuery(brandId);
  const detail = query.data ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [discardRequested, setDiscardRequested] = useState(false);
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<ProductFieldsInput, unknown, ProductFields>({
    resolver: zodResolver(productFieldsSchema),
    defaultValues: blank,
    mode: "onBlur",
  });
  const { pending, error: saveError, run } = useBusy([qk.brand(brandId)]);

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!detail) return <div role="status" aria-label="Loading products" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(detail.identity.role, "member");

  async function submit(values: ProductFields) {
    const saved = await run(async () => {
      await saveProduct({ data: { brandId, productId: editing ?? "", ...values } });
    });
    if (saved) {
      reset(blank);
      setEditing(null);
      setFormOpen(false);
      setDiscardRequested(false);
    }
  }

  function edit(product: ProductRow) {
    setEditing(product.id);
    setFormOpen(true);
    setDiscardRequested(false);
    reset({
      name: product.name,
      description: product.description,
      features: product.features,
      benefits: product.benefits,
      price: product.price,
      url: product.url,
      allowedClaims: product.allowedClaims,
      prohibitedClaims: product.prohibitedClaims,
    });
  }

  function requestClose() {
    if (isDirty) {
      setDiscardRequested(true);
      return;
    }
    setFormOpen(false);
    setEditing(null);
    reset(blank);
  }

  function discardChanges() {
    reset(blank);
    setEditing(null);
    setFormOpen(false);
    setDiscardRequested(false);
  }

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div>
        <Link to="/brands/$brandId" params={{ brandId }} className="text-sm text-muted">{detail.identity.name}</Link>
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="font-display text-4xl">Products</h1>{canEdit ? <Button type="button" onClick={() => { reset(blank); setEditing(null); setDiscardRequested(false); setFormOpen(true); }}>Add product</Button> : null}</div>
        <p className="max-w-2xl text-muted">Allowed and prohibited claims are checked when a creative is saved. The guardian reports evidence. JEV applies the threshold.</p>
      </div>
      {detail.products.length === 0 ? (
        <Panel>No products yet.</Panel>
      ) : (
        <ul className="space-y-3">
          {detail.products.map((product) => (
            <li key={product.id} className="rounded-lg border border-line bg-panel p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-display text-2xl">{product.name}</h2>
                {canEdit ? (
                  <div className="flex gap-2">
                    <Button type="button" variant="quiet" onClick={() => edit(product)}>Edit</Button>
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => {
                        void run(async () => {
                          await deleteProduct({ data: { brandId, productId: product.id } });
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                ) : null}
              </div>
              {product.price ? <p className="text-sm text-muted">{product.price}</p> : null}
              {product.description ? <p className="mt-2">{product.description}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <Dialog open={formOpen} onOpenChange={(open) => { if (open) setFormOpen(true); else requestClose(); }}>
        <DialogContent aria-describedby="product-form-description" className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>{editing ? "Edit product" : "Add product"}</DialogTitle>
        <DialogDescription id="product-form-description">Product details and claim rules are used when creative evidence is checked.</DialogDescription>
        <form onSubmit={handleSubmit(submit)} className="mt-4 grid gap-4 md:grid-cols-2">
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
          <Field label="Product URL" error={errors.url?.message}>
            <TextInput {...register("url")} maxLength={500} placeholder="https://example.test" />
          </Field>
          {saveError ? <div className="md:col-span-2"><Notice>{saveError}</Notice></div> : null}
          {isDirty ? <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm" role="status"><span>{discardRequested ? "Discard your unsaved product changes?" : "Unsaved changes"}</span>{discardRequested ? <div className="flex gap-2"><Button type="button" variant="quiet" onClick={() => setDiscardRequested(false)}>Continue editing</Button><Button type="button" variant="danger" onClick={discardChanges}>Discard changes</Button></div> : <Button type="button" variant="quiet" onClick={requestClose}>Discard changes</Button>}</div> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Saving…" : editing ? "Update product" : "Add product"}</Button>
            <Button type="button" variant="quiet" onClick={requestClose}>Cancel</Button>
          </div>
        </form>
        </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
