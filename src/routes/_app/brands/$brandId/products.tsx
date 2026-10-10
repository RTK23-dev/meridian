import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button, ScreenSkeleton } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { ProductSheet } from "@/components/brain/product-sheet";
import { ProductsTable } from "@/components/brain/products-table";
import { hasRole } from "@/lib/meridian/access";
import type { ProductRow } from "@/lib/meridian/api";
import { useBrandQuery } from "@/lib/query/hooks";

export const Route = createFileRoute("/_app/brands/$brandId/products")({ staticData: { pageTitle: "Products" }, component: ProductsPage });

function ProductsPage() {
  const { brandId } = Route.useParams();
  return (
    <Products brandId={brandId} />
  );
}

function Products({ brandId }: { brandId: string }) {
  const query = useBrandQuery(brandId);
  const detail = query.data ?? null;
  const [sheet, setSheet] = useState<{ open: boolean; product: ProductRow | null }>({ open: false, product: null });

  if (query.isError && !detail) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!detail) return <ScreenSkeleton label="Loading products" shape="rows" />;
  const canEdit = hasRole(detail.identity.role, "member");

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link to="/brands/$brandId" params={{ brandId }} className="text-sm text-fg-muted underline-offset-4 hover:underline">{detail.identity.name}</Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-4xl">Products</h1>
          {canEdit ? <Button type="button" onClick={() => setSheet({ open: true, product: null })}>Add product</Button> : null}
        </div>
        <p className="max-w-2xl text-fg-muted">Allowed and prohibited claims are checked when a creative is saved. The guardian reports evidence. JEV applies the threshold.</p>
      </div>

      <ProductsTable
        brandId={brandId}
        products={detail.products}
        canEdit={canEdit}
        onEdit={(product) => setSheet({ open: true, product })}
      />

      {canEdit ? (
        <ProductSheet
          brandId={brandId}
          open={sheet.open}
          product={sheet.product}
          onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
        />
      ) : null}
    </div>
  );
}
