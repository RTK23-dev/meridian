import { Link, createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Notice, Panel, Skeleton, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { deleteProduct, saveProduct, type ProductRow } from "@/lib/meridian/api";
import { useBrandQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

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
    <Authed>
      <Products brandId={brandId} />
    </Authed>
  );
}

function Products({ brandId }: { brandId: string }) {
  const query = useBrandQuery(brandId);
  const detail = query.data ?? null;
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const { pending, error: saveError, run } = useBusy([qk.brand(brandId)]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!detail) return <div role="status" aria-label="Loading products" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(detail.identity.role, "member");

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await saveProduct({ data: { brandId, productId: editing ?? "", ...draft } });
      setDraft(blank);
      setEditing(null);
    });
  }

  function edit(product: ProductRow) {
    setEditing(product.id);
    setDraft({
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

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div>
        <Link to="/brands/$brandId" params={{ brandId }} className="text-sm text-muted">{detail.identity.name}</Link>
        <h1 className="font-display text-4xl">Products</h1>
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
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <h2 className="font-display text-2xl md:col-span-2">{editing ? "Edit product" : "Add product"}</h2>
          <Field label="Name">
            <TextInput required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Price">
            <TextInput value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Description">
              <TextArea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </Field>
          </div>
          <Field label="Features">
            <TextArea value={draft.features} onChange={(event) => setDraft({ ...draft, features: event.target.value })} />
          </Field>
          <Field label="Benefits">
            <TextArea value={draft.benefits} onChange={(event) => setDraft({ ...draft, benefits: event.target.value })} />
          </Field>
          <Field label="Allowed claims">
            <TextArea value={draft.allowedClaims} onChange={(event) => setDraft({ ...draft, allowedClaims: event.target.value })} />
          </Field>
          <Field label="Prohibited claims">
            <TextArea value={draft.prohibitedClaims} onChange={(event) => setDraft({ ...draft, prohibitedClaims: event.target.value })} />
          </Field>
          <Field label="Product URL">
            <TextInput value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
          </Field>
          {saveError ? <div className="md:col-span-2"><Notice>{saveError}</Notice></div> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : editing ? "Update product" : "Add product"}</Button>
            {editing ? (
              <Button type="button" variant="quiet" onClick={() => { setEditing(null); setDraft(blank); }}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
