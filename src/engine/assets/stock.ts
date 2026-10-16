// Stock video (Bible 10.3 "stock"; source kind stock in Bible 7.1). Stock is not a ProviderAdapter: AssetSpec.modelClass cannot
// name stock, and a search returns many candidate clips rather than one generated take. Stock search is free (price 0, key
// required), so it makes no ledger entry. It still goes through the gateway, and only the search's own clip is kept.
//
// Attribution is kept with every clip: the vendor's page for the clip, the author, and the licence status. Licence terms for
// commercial social use are an owner check (E2.6): until it is recorded, a clip's licence is "unverified", and nothing here
// treats it as cleared.

import type { ProviderError } from "../contracts/assets.ts";
import type { ResolvedRoute, Gateway } from "../gateway/gateway.ts";
import type { AdapterConnection } from "./adapter.ts";

export type StockClip = {
  vendor: string;
  clipId: string;
  /** The vendor's page for the clip (Pexels url, Pixabay pageURL). */
  sourceUrl: string;
  author: { name: string; url: string | null };
  /** Unverified until the owner records the licence check (E2.6). The page is not in PROVIDER_APIS.md, so it is null. */
  licence: { status: "unverified"; pageUrl: null };
  /** The https file to fetch. The router never fetches it: the artifact store does, through the gateway. */
  downloadUrl: string;
  width: number;
  height: number;
  durationMs: number;
};

export type StockSearch = { status: "ok"; clips: StockClip[] } | { status: "failed"; error: ProviderError };

export interface StockProvider {
  /** The gateway provider, for example "pexels". */
  readonly providerId: string;
  connection(organizationId: string | null): Promise<AdapterConnection>;
  search(query: string, options: { minDurationMs: number; organizationId: string | null }): Promise<StockSearch>;
}

export type StockOutcome =
  | { status: "found"; providerId: string; clip: StockClip; clips: StockClip[]; reasons: string[] }
  | { status: "no_results"; reasons: string[] }
  | { status: "not_connected"; reasons: string[] }
  | { status: "failed"; reasons: string[] };

export type StockSearchInput = {
  gateway: Gateway;
  organizationId: string | null;
  query: string;
  minDurationMs: number;
  /** The provider for a route, or null when the route has no stock adapter. */
  providerFor: (route: ResolvedRoute) => StockProvider | null;
};

/**
 * Searches the stock targets in route order. The first vendor with clips wins. A vendor that is not connected, fails, or has no
 * clip for the query is passed over, and each passed-over vendor says why. A search with no clips anywhere is no_results.
 */
export async function searchStock(input: StockSearchInput): Promise<StockOutcome> {
  const reasons: string[] = [];
  let anyConnected = false;
  let anyFailed = false;
  for (const route of input.gateway.routes("stock")) {
    const provider = input.providerFor(route);
    if (provider === null) {
      reasons.push(`${route.provider.id}: no stock adapter`);
      continue;
    }
    const connection = await provider.connection(input.organizationId);
    if (!connection.connected) {
      reasons.push(`${provider.providerId}: ${connection.reason}`);
      continue;
    }
    anyConnected = true;
    const search = await provider.search(input.query, { minDurationMs: input.minDurationMs, organizationId: input.organizationId });
    if (search.status === "failed") {
      anyFailed = true;
      reasons.push(`${provider.providerId}: ${search.error.kind}: ${search.error.message}`);
      continue;
    }
    const first = search.clips[0];
    if (first !== undefined) {
      return { status: "found", providerId: provider.providerId, clip: first, clips: search.clips, reasons };
    }
    reasons.push(`${provider.providerId}: no clip matched the query`);
  }
  if (anyFailed) return { status: "failed", reasons };
  if (!anyConnected) return { status: "not_connected", reasons };
  return { status: "no_results", reasons };
}
