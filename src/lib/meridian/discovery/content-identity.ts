/**
 * How a discovered record is identified within one brand.
 *
 * A page is identified by its canonical URL in the form `normalizeCanonicalUrl` produces, so the same page reached through
 * tracking parameters, http or https, or a trailing slash is one page. A stored record's content hash covers the canonical
 * URL and the stored content. Two records with the same hash in one brand are the same observation, so the second is not
 * stored again and the run reports it as seen before.
 */

import { createHash } from "node:crypto";
import { normalizeCanonicalUrl } from "../evidence/dedupe.ts";

/** Where a run's records are stored and which adapter and source status produced them. */
export interface RecordProvenance {
  organizationId: string;
  brandId: string;
  runId: string;
  adapterId: string;
  /** The adapter's health status at the moment this run fetched from it. */
  sourceStatus: string;
}

/** The identity key of a page's canonical URL. Falls back to the input for a value that is not an http(s) URL. */
export function canonicalPageKey(url: string): string {
  return normalizeCanonicalUrl(url) ?? url;
}

/** SHA-256 over the JSON form of the parts, so the same parts always hash to the same value. */
export function contentHashOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
