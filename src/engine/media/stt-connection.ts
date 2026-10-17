// Whether a speech-to-text vendor can be called (Bible 20.2, CLAUDE.md working rule 1). The stt route names Deepgram (owner decision
// 2026-10-16), and this returns not_connected with a NOT_CONNECTED reason until the composition root wires its adapter and the
// gateway can reach the provider. It sends nothing. A stage that needs speech-to-text asks this first, so it fails closed before it
// reserves or spends anything. The check reads the route table through the gateway (gateway.route), and never picks a vendor itself.

import { priceFor } from "../config/prices.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import type { SpeechToText } from "./stt.ts";

export const NOT_CONNECTED = "NOT_CONNECTED";

export type SpeechToTextConnection =
  { status: "ready"; stt: SpeechToText } | { status: "not_connected"; reason: string };

/** The reason text of a failed connection. It always starts with NOT_CONNECTED, so logs and the gate read the same word. */
export function notConnectedReason(detail: string): string {
  return `${NOT_CONNECTED}: ${detail}`;
}

/**
 * The list price per minute of a routed target (config/prices.ts), or null when the route has no price key or its price is not per
 * minute. A null price refuses the call (estimateSttUsd), so nothing is estimated as zero.
 */
export function pricePerMinuteOf(route: ResolvedRoute): number | null {
  if (route.priceKey === null) return null;
  const price = priceFor(route.priceKey);
  return price.unit === "per_minute" ? price.usd : null;
}

/** What the composition root gives the speech stages: the connection, and the list price the metered call is estimated at. */
export type SpeechPorts = { connection: SpeechToTextConnection; sttPricePerMinuteUsd: number | null };

/**
 * The speech ports of this deployment: the connection (speechToTextConnection) and the route's list price (pricePerMinuteOf), read from
 * the same stt route. A route the gateway cannot resolve has no price, so a call is refused with unknown_price, never estimated as zero.
 */
export function speechPortsOf(gateway: Gateway, options: { resolve?: (route: ResolvedRoute) => SpeechToText | null } = {}): SpeechPorts {
  const connection = speechToTextConnection(gateway, options);
  let sttPricePerMinuteUsd: number | null = null;
  try {
    sttPricePerMinuteUsd = pricePerMinuteOf(gateway.route("stt"));
  } catch {
    sttPricePerMinuteUsd = null;
  }
  return { connection, sttPricePerMinuteUsd };
}

/**
 * The speech-to-text connection for this deployment. `resolve` maps a routed target to a wired adapter, or null when none is
 * wired: the composition root passes deepgramForRoute (stt-deepgram.ts) with the gateway and the project lookup. Without it, nothing is ready.
 */
export function speechToTextConnection(
  gateway: Gateway,
  options: { resolve?: (route: ResolvedRoute) => SpeechToText | null } = {},
): SpeechToTextConnection {
  let route: ResolvedRoute;
  try {
    route = gateway.route("stt");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the stt route is not set";
    return {
      status: "not_connected",
      reason: notConnectedReason(`the speech-to-text route cannot be used (Bible 20.2): ${detail}`),
    };
  }
  const stt = options.resolve?.(route) ?? null;
  if (stt === null) {
    return {
      status: "not_connected",
      reason: notConnectedReason(
        `the stt route names ${route.provider.id}:${route.model}, but no speech-to-text adapter is resolved for it on this deployment. No call is made.`,
      ),
    };
  }
  return { status: "ready", stt };
}
