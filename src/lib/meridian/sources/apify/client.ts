// The one path from Meridian to Apify. Every request goes through the engine's API gateway (src/engine/gateway), which adds
// the workspace's Apify key as a Bearer token, so this file never reads a key and never calls fetch. Apify's answer is
// data: its items are validated by instagram-volume.ts before anything is stored.
//
// Fail closed: with no usable key the answer is not_connected, and nothing is sent. A failed call is failed, never ok.

import { INSTAGRAM_VOLUME_CONFIG } from "./config.ts";
// Type-only: the runtime gateway is loaded lazily below, so importing this file starts no engine code and no database.
import type { Gateway } from "../../../../engine/gateway/gateway.ts";

export type ApifyRunResult =
  | { status: "ok"; items: unknown[] }
  | { status: "not_connected"; reason: string }
  | { status: "failed"; reason: string };

export type ApifyRunCall = {
  organizationId: string;
  /** The actor id the API takes, "owner~name". */
  actorId: string;
  /** The actor's input (its INPUT JSON). */
  input: Record<string, unknown>;
  /** Apify's documented `maxItems` query parameter: the most items Apify charges for in this run. */
  maxItems: number;
};

export interface ApifyClient {
  /** Whether the workspace's Apify key can be used, with the reason when it cannot. Sends nothing. */
  connection(organizationId: string): Promise<{ connected: boolean; reason: string | null }>;
  /** Runs one actor synchronously and returns its dataset items. */
  runSync(call: ApifyRunCall): Promise<ApifyRunResult>;
}

/** The part of the gateway this client uses. The engine's Gateway satisfies it; tests pass a recorded fake. */
export type ApifyGateway = Pick<Gateway, "call" | "connection">;

const DECODER = new TextDecoder();

function singleLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

/** Apify's error message, when its error body has one. The body is untrusted, so only a short single line is kept. */
function providerMessage(body: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(DECODER.decode(body));
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
        return ` ${singleLine((error as { message: string }).message, 200)}`;
      }
    }
  } catch {
    // Not JSON: no message is shown.
  }
  return "";
}

/** Reads one gateway answer. Only a 200 or 201 with a JSON list is a success (Apify documents 201 for this endpoint). */
export function settleApifyResponse(status: number, body: Uint8Array): ApifyRunResult {
  if (status === 408) return { status: "failed", reason: "Apify's run passed its time limit, so its items were not read." };
  if (status !== 200 && status !== 201) {
    return { status: "failed", reason: `Apify answered ${status}.${providerMessage(body)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(body));
  } catch {
    return { status: "failed", reason: "Apify answered with a body that is not JSON." };
  }
  if (!Array.isArray(parsed)) return { status: "failed", reason: "Apify answered without a list of items." };
  return { status: "ok", items: parsed };
}

/** An Apify client over a gateway. `getGateway` is awaited per call, so the engine is loaded only when a call is made. */
export function gatewayApifyClient(getGateway: () => Promise<ApifyGateway>): ApifyClient {
  return {
    async connection(organizationId) {
      try {
        return await (await getGateway()).connection("apify", organizationId);
      } catch {
        return { connected: false, reason: "The Apify credential could not be checked, so no request is made." };
      }
    },
    async runSync(call) {
      if (!Number.isInteger(call.maxItems) || call.maxItems < 1) {
        return { status: "failed", reason: "An Apify call needs a whole number of items above zero." };
      }
      const query = new URLSearchParams({
        maxItems: String(call.maxItems),
        timeout: String(INSTAGRAM_VOLUME_CONFIG.timeoutSeconds),
      });
      const path = `/actors/${encodeURIComponent(call.actorId)}/run-sync-get-dataset-items?${query.toString()}`;
      try {
        const gateway = await getGateway();
        const result = await gateway.call({
          provider: "apify",
          organizationId: call.organizationId,
          method: "POST",
          path,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(call.input),
          timeoutMs: INSTAGRAM_VOLUME_CONFIG.transportTimeoutMs,
        });
        if (result.status === "not_connected") return { status: "not_connected", reason: result.reason };
        return settleApifyResponse(result.response.status, result.response.body);
      } catch {
        // A network failure or an aborted request. The message is generic: it may carry request detail.
        return { status: "failed", reason: "The request to Apify did not complete." };
      }
    },
  };
}

let liveGateway: Promise<Gateway> | null = null;

/**
 * The engine's gateway, wired to Meridian's credential resolver and the shared fetch transport. Loaded once, on first use.
 * It is not cached after a failed load, so a later call can try again.
 */
export function liveApifyGateway(): Promise<Gateway> {
  if (!liveGateway) {
    liveGateway = (async () => {
      const [{ createGateway }, { fetchHttpTransport }, { meridianCredentialSource }] = await Promise.all([
        import("../../../../engine/gateway/gateway.ts"),
        import("../../../../engine/gateway/transport.ts"),
        import("../../../../engine/gateway/meridian.ts"),
      ]);
      return createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });
    })().catch((error: unknown) => {
      liveGateway = null;
      throw error;
    });
  }
  return liveGateway;
}

/** The production client: Apify through the engine gateway, loaded when first used. */
export function liveApifyClient(): ApifyClient {
  return gatewayApifyClient(liveApifyGateway);
}

/** A client that reports the reason it is not connected and sends nothing. The run shows that reason, never an empty success. */
export function notConnectedApifyClient(reason: string): ApifyClient {
  return {
    async connection() {
      return { connected: false, reason };
    },
    async runSync() {
      return { status: "not_connected", reason };
    },
  };
}
