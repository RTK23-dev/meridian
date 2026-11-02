// The model catalog with the workspace's model policy applied on every read (owner direction, 2026-10-23). The cached listing is kept as
// it was read; the families are read per call, so a change in Settings applies at once, not when the cache expires. A switched-off family
// is removed from the entries and from the video listing, so no chooser, adapter profile or reviewer pick can reach it. Nothing here
// calls a provider.

import { isDisabledModel, allowedByFamilies } from "../config/model-policy.ts";
import type { CatalogRead, ModelCatalogSource } from "./catalog.ts";

/** The video listing without the rows of a switched-off family. A listing with no data array is returned as it is. */
export function withoutDisabledRows(listing: unknown, families: readonly string[]): unknown {
  if (typeof listing !== "object" || listing === null || !Array.isArray((listing as { data?: unknown }).data)) return listing;
  const rows = (listing as { data: unknown[] }).data;
  const data = rows.filter((row) => {
    const id = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined;
    return typeof id !== "string" || !isDisabledModel(id, families);
  });
  return { ...(listing as object), data };
}

export function withModelPolicy(source: ModelCatalogSource, familiesFor: (organizationId: string) => Promise<readonly string[]>): ModelCatalogSource {
  return {
    async read(organizationId: string): Promise<CatalogRead> {
      const read = await source.read(organizationId);
      if (read.status !== "read") return read;
      const families = await familiesFor(organizationId);
      if (families.length === 0) return read;
      return {
        status: "read",
        catalog: {
          ...read.catalog,
          entries: allowedByFamilies(read.catalog.entries, families),
          videoListing: withoutDisabledRows(read.catalog.videoListing, families),
        },
      };
    },
  };
}
