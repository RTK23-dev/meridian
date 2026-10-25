// The orchestrator's live catalog: OpenRouter's four public listings (text, image, speech and video), read through the gateway, each
// row turned into a CatalogEntry with the prices the engine prices a plan from. Fail closed:
// - no connected key: the read is not_connected, with the reason, and the listings are not guessed;
// - a listing that fails: the read is failed, with the reason; a partial catalog is never returned as a whole one;
// - a row that does not parse, or has no id, is dropped with its reason (loadCatalog does this).
// A model in more than one listing keeps its most specific kind (image, speech or video over text), as the recorded snapshot does.

import type { Gateway } from "../gateway/gateway.ts";
import { httpError, jsonBody } from "../gateway/errors.ts";
import { loadCatalog, type CatalogLoad } from "./catalog.ts";

const PROVIDER = "openrouter";

/** The four listings, in the order they are read. Each is GET <path> under the provider's API root. */
export const ORCHESTRATOR_LISTINGS = [
  { path: "/models", kind: "text" },
  { path: "/models?output_modalities=image", kind: "image" },
  { path: "/models?output_modalities=speech", kind: "speech" },
  { path: "/videos/models", kind: "video" },
] as const;

export type LiveCatalogRead =
  | { status: "ok"; catalog: CatalogLoad }
  | { status: "not_connected"; reason: string }
  | { status: "failed"; reason: string };

const SPECIFICITY: Record<string, number> = { text: 0, image: 1, speech: 1, video: 1 };

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function stringsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** One listing row as a catalog row. A row without an id is kept as it is, so loadCatalog drops it with the reason. */
export function rowOf(raw: unknown, kind: string): Record<string, unknown> {
  const row = (raw ?? {}) as Record<string, any>;
  const architecture = (row.architecture ?? {}) as Record<string, unknown>;
  const pricing = (row.pricing ?? {}) as Record<string, unknown>;
  const skus = (row.pricing_skus ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.id,
    kind,
    input_modalities: stringsOrNull(architecture.input_modalities),
    output_modalities: stringsOrNull(architecture.output_modalities),
    // The context window, in tokens, as the listing states it. Null when the listing does not state one.
    context_length: numberOrNull(row.context_length),
    pricing: {
      promptUsdPerToken: kind === "text" || kind === "speech" ? numberOrNull(pricing.prompt) : null,
      completionUsdPerToken: kind === "text" ? numberOrNull(pricing.completion) : null,
      imageUsd: kind === "image" ? numberOrNull(pricing.image) : null,
      usdPerSecond1080p: kind === "video" ? numberOrNull(skus.duration_seconds_1080p) : null,
    },
  };
}

/** The four listings' bodies merged into one catalog: the most specific kind of a model wins, and the first row of a kind wins. */
export function mergeListings(bodies: Array<{ kind: string; body: unknown }>, takenAt: string): CatalogLoad {
  const rows = new Map<string, { row: Record<string, unknown>; specificity: number }>();
  const extra: unknown[] = [];
  for (const { kind, body } of bodies) {
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) continue;
    for (const raw of data) {
      const row = rowOf(raw, kind);
      const id = row.id;
      if (typeof id !== "string") {
        extra.push(row);
        continue;
      }
      const specificity = SPECIFICITY[kind] ?? 0;
      const held = rows.get(id);
      if (held === undefined || specificity > held.specificity) rows.set(id, { row, specificity });
    }
  }
  const entries: unknown[] = [...rows.values()].map((held) => held.row);
  entries.push(...extra);
  return loadCatalog({ source: "OpenRouter's public listings: text, image, speech and video", takenAt, entries });
}

async function readListing(gateway: Gateway, organizationId: string | null, path: string): Promise<{ kind: "body"; body: unknown } | { kind: "not_connected"; reason: string } | { kind: "failed"; reason: string }> {
  let result;
  try {
    result = await gateway.call({ provider: PROVIDER, organizationId, method: "GET", path });
  } catch (error) {
    return { kind: "failed", reason: `GET ${path} could not be sent: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
  }
  if (result.status === "not_connected") return { kind: "not_connected", reason: result.reason };
  if (result.response.status !== 200) {
    const error = httpError(PROVIDER, result.response);
    if (error.kind === "config") return { kind: "not_connected", reason: error.message };
    return { kind: "failed", reason: `GET ${path} failed: ${error.message}` };
  }
  try {
    return { kind: "body", body: jsonBody(PROVIDER, result.response) };
  } catch (error) {
    return { kind: "failed", reason: `GET ${path} returned a body that is not JSON: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
  }
}

export async function readOrchestratorCatalog(gateway: Gateway, options: { organizationId: string | null; now: () => string }): Promise<LiveCatalogRead> {
  const bodies: Array<{ kind: string; body: unknown }> = [];
  for (const listing of ORCHESTRATOR_LISTINGS) {
    const read = await readListing(gateway, options.organizationId, listing.path);
    if (read.kind === "not_connected") return { status: "not_connected", reason: read.reason };
    if (read.kind === "failed") return { status: "failed", reason: read.reason };
    bodies.push({ kind: listing.kind, body: read.body });
  }
  return { status: "ok", catalog: mergeListings(bodies, options.now()) };
}
