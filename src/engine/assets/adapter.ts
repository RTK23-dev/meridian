// The adapter contract the router uses (Bible 10.1), its helpers, and the storage interface for media that a provider returns
// as bytes. Adapters call only the gateway (src/engine/gateway); none of them calls fetch or reads a key.

import { EngineError } from "../contracts/errors.ts";
import { roundUsd } from "../contracts/money.ts";
import type { ProviderAdapter, ProviderCapabilities } from "../contracts/assets.ts";
import { prices, type PriceKey, type PriceUnit } from "../config/prices.ts";
import type { Gateway, GatewayCall } from "../gateway/gateway.ts";
import { bodyText } from "../gateway/errors.ts";
import type { HttpResponse } from "../gateway/types.ts";
import { ProviderCallError, providerErrorForStatus } from "./classify.ts";

/** Whether a vendor can be called for a workspace, with the reason when it cannot. Sends nothing. */
export type AdapterConnection = { connected: true } | { connected: false; reason: string };

/** What a finished job carries besides its uri. Untrusted: the adapter validates it before it returns it. */
export type AssetDetails = {
  mediaType?: string;
  generationId?: string;
};

/**
 * A ProviderAdapter the router can run. `providerId` is the gateway's provider (for example "openrouter" or "pexels"); the
 * adapter's `id` adds the model, so it is the bucket, breaker and cache identity (Bible 10.1 example).
 */
export interface RoutedAdapter extends ProviderAdapter {
  readonly providerId: string;
  connection(organizationId: string | null): Promise<AdapterConnection>;
  /** Details of a finished job, if the adapter keeps them. */
  detailsFor(jobRef: string): AssetDetails | undefined;
}

/** Capabilities of an adapter whose vendor has not been verified. Zero bounds and an empty aspect list match no spec. */
export const UNVERIFIED_CAPABILITIES: ProviderCapabilities = {
  maxSeconds: 0,
  minSeconds: 0,
  firstFrame: false,
  lastFrame: false,
  refsMax: 0,
  audio: false,
  aspect: [],
};

/** Storage for media that a provider returns as bytes (images, speech). Artifacts go through this, never through a vendor SDK. */
export interface MediaStore {
  put(input: { workspaceId: string; bytes: Uint8Array; mediaType: string; contentHash: string }): Promise<{ uri: string }>;
}

/** An in-memory MediaStore for tests. The uri it returns is not a real storage location. */
export function memoryMediaStore(): MediaStore & { readonly objects: Map<string, { mediaType: string; bytes: Uint8Array }> } {
  const objects = new Map<string, { mediaType: string; bytes: Uint8Array }>();
  return {
    objects,
    async put(input) {
      const uri = `memory://${input.workspaceId}/${input.contentHash.slice("sha256:".length)}`;
      if (!objects.has(uri)) objects.set(uri, { mediaType: input.mediaType, bytes: input.bytes });
      return { uri };
    },
  };
}

/**
 * The list price of a call: the price table's usd times the quantity in the table's own unit (Bible 10.3). An unknown price,
 * or a price in another unit, throws unknown_price. It never returns 0 for a price it does not know.
 */
export function listPriceUsd(key: PriceKey | null, unit: PriceUnit, quantity: number): number {
  if (key === null) throw new EngineError("unknown_price", "this route has no price key, so the call cannot be priced");
  const price = prices.entries[key];
  if (price.usd === null) throw new EngineError("unknown_price", `the price of ${key} is not known yet (unit ${price.unit})`);
  if (price.unit !== unit) throw new EngineError("unknown_price", `${key} is priced ${price.unit}, not ${unit}`);
  if (!Number.isFinite(quantity) || quantity < 0) throw new EngineError("invalid_input", "a price quantity must be finite and >= 0");
  return roundUsd(price.usd * quantity);
}

/** A gateway call. A provider that is not connected throws a config error, so nothing is sent. */
export async function callProvider(gateway: Gateway, input: GatewayCall): Promise<HttpResponse> {
  const result = await gateway.call(input);
  if (result.status === "not_connected") {
    throw new EngineError("config", `${input.provider} is not connected: ${result.reason}`);
  }
  return result.response;
}

/** Throws the classified ProviderError for a non-2xx answer. A 2xx answer returns without a value. */
export function ensureOk(response: HttpResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new ProviderCallError(providerErrorForStatus(response.status, bodyText(response)));
}
