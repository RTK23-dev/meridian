import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
  Button, DataTable,
} from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { deleteProduct, type ProductRow } from "@/lib/meridian/api";
import { useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

/** Products as a table. Edit opens the sheet. Delete asks first, because it hides the product from the brand. */
export function ProductsTable({ brandId, products, canEdit, onEdit }: {
  brandId: string;
  products: ProductRow[];
  canEdit: boolean;
  onEdit: (product: ProductRow) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<ProductRow | null>(null);
  const deleteMutation = useScopedMutation({
    mutationKey: ["mutation", "product.delete", brandId],
    mutationFn: (productId: string) => deleteProduct({ data: { brandId, productId } }),
    invalidate: () => [qk.brand(brandId)],
    success: "Product deleted.",
    onSuccess: () => setPendingDelete(null),
  });

  const columns: ColumnDef<ProductRow, unknown>[] = [
    { accessorKey: "name", header: "Product", cell: ({ row }) => <span className="font-semibold">{row.original.name}</span> },
    { accessorKey: "price", header: "Price", enableSorting: false, cell: ({ row }) => row.original.price || "No price stored" },
    { accessorKey: "url", header: "URL", enableSorting: false, cell: ({ row }) => row.original.url ? <span className="break-all">{row.original.url}</span> : "No URL stored" },
    {
      accessorKey: "prohibitedClaims",
      header: "Prohibited claims",
      enableSorting: false,
      cell: ({ row }) => row.original.prohibitedClaims ? <span className="line-clamp-2 whitespace-pre-wrap break-words">{row.original.prohibitedClaims}</span> : "None stored",
    },
  ];
  if (canEdit) {
    columns.push({
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => <div className="flex flex-wrap gap-2">
        <Button type="button" size="md" variant="secondary" aria-label={`Edit ${row.original.name}`} onClick={() => onEdit(row.original)}>Edit</Button>
        <Button type="button" size="md" variant="danger" aria-label={`Delete ${row.original.name}`} onClick={() => { deleteMutation.reset(); setPendingDelete(row.original); }}>Delete</Button>
      </div>,
    });
  }

  return <>
    <DataTable
      data={products}
      columns={columns}
      getRowId={(row) => row.id}
      emptyTitle="No products yet"
      emptyReason="Add a product so its allowed and prohibited claims are checked when a creative is saved."
    />
    <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
      <AlertDialogContent aria-describedby="delete-product-description">
        <AlertDialogTitle className="font-display text-xl">Delete {pendingDelete?.name ?? "this product"}?</AlertDialogTitle>
        <AlertDialogDescription id="delete-product-description" className="mt-2 text-sm text-fg-muted">
          This hides the product from this brand's product list.
        </AlertDialogDescription>
        {deleteMutation.error ? <div className="mt-4"><PlainErrorNotice error={deleteMutation.error} /></div> : null}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <AlertDialogCancel asChild><Button type="button" variant="secondary">Cancel</Button></AlertDialogCancel>
          <Button
            type="button"
            variant="danger"
            disabled={deleteMutation.isPending || !pendingDelete}
            onClick={() => { if (pendingDelete) void deleteMutation.mutateAsync(pendingDelete.id).catch(() => undefined); }}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete product"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
