import { Link } from "@tanstack/react-router";
import type { BrandSummary } from "@/lib/meridian/workspace/actions";

/**
 * The places where something can be deleted. A brand is deleted from its own overview, where the name must be typed. This
 * page links there and does not offer a second delete path. A workspace delete is not in this build, and the page says so.
 */
export function DangerTab({ brands, canDelete }: { brands: BrandSummary[]; canDelete: boolean }) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="danger-brands-title" className="space-y-3 rounded-lg border border-danger/40 bg-surface p-5">
        <h2 id="danger-brands-title" className="text-section font-semibold text-fg">Delete a brand</h2>
        <p className="text-sm text-fg-muted">
          Open the brand and use Delete brand in its danger zone. You type the brand name to confirm. The audit trail keeps a record.
        </p>
        {!canDelete ? <p className="text-sm text-fg-muted">Only an admin can delete a brand.</p> : null}
        {canDelete && brands.length === 0 ? <p className="text-sm text-fg-muted">There are no brands to delete.</p> : null}
        {canDelete && brands.length > 0 ? (
          <ul className="divide-y divide-border">
            {brands.map((brand) => (
              <li key={brand.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="font-semibold text-fg">{brand.name}</span>
                <Link to="/brands/$brandId" params={{ brandId: brand.id }} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
                  Open {brand.name} to delete it<span className="sr-only"> from its overview</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="danger-workspace-title" className="space-y-2 rounded-lg border border-border bg-surface p-5">
        <h2 id="danger-workspace-title" className="text-section font-semibold text-fg">Delete this workspace</h2>
        <p className="text-sm text-fg-muted">
          This build does not delete a workspace, so no control is offered here. Brands can be deleted one at a time, as above.
        </p>
      </section>
    </div>
  );
}
