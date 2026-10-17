// The bill of one OpenRouter generation (Bible 10.5 step 5, contract v9). OpenRouter reports a finished generation's cost on
// GET /generation?id=<generation id> as `data.total_cost`, in USD. It is read once, right after the call's answer is stored: the stats
// can lag the answer, so a miss is `unavailable`, and the call stays held until the reconciler reads it again (budget/reconcile-holds.ts).
// A missing or unreadable total_cost is a miss, never a bill of zero or an estimate.
//
// UNVERIFIED LIVE: the path and the field are the ones OpenRouter's generation stats document as of 2026-10-17, and the owner's live run
// confirms them. The read goes through gateway.call, so the key and the host are the gateway's.

import { z } from "zod";
import { adapters } from "../config/adapters.ts";
import { bodyText } from "./errors.ts";
import type { Gateway, GatewayResult } from "./gateway.ts";

const PROVIDER = "openrouter";
/** A generation id as OpenRouter names it ("gen-..."): letters, digits and a few separators, bounded. Anything else is not looked up. */
const GENERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

/** The stats answer. Only `data.total_cost` is read. Other fields are untrusted and not used. */
export const generationStatsSchema = z.object({ data: z.object({ total_cost: z.number() }) });
export type GenerationStats = z.infer<typeof generationStatsSchema>;

/** A provider's bill for one generation: billed in USD, or unavailable with the reason. */
export type GenerationBill = { status: "billed"; usd: number } | { status: "unavailable"; reason: string };

function unavailable(reason: string): GenerationBill {
  return { status: "unavailable", reason };
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * One read of a generation's bill. It sends one GET through the gateway and never retries: the caller records a miss as unsettled. A
 * non-200 answer, a body that is not JSON, a missing or non-finite total_cost, and a negative cost are all unavailable.
 */
export async function openRouterGenerationBill(
  gateway: Pick<Gateway, "call">,
  input: { organizationId: string | null; generationId: string },
): Promise<GenerationBill> {
  if (!GENERATION_ID_PATTERN.test(input.generationId)) {
    return unavailable("the generation id is not one the engine can look up, so no stats are read");
  }
  let result: GatewayResult;
  try {
    result = await gateway.call({
      provider: PROVIDER,
      organizationId: input.organizationId,
      method: "GET",
      path: `/generation?id=${encodeURIComponent(input.generationId)}`,
      timeoutMs: adapters.timeoutsMs.speech.value,
    });
  } catch (error) {
    return unavailable(`the generation stats did not answer (${messageOf(error)})`);
  }
  if (result.status === "not_connected") return unavailable(`OpenRouter is not connected: ${result.reason}`);
  const response = result.response;
  if (response.status !== 200) return unavailable(`the generation stats answered HTTP ${response.status}`);
  let body: unknown;
  try {
    body = JSON.parse(bodyText(response));
  } catch {
    return unavailable("the generation stats answer is not JSON");
  }
  const parsed = generationStatsSchema.safeParse(body);
  if (!parsed.success) return unavailable("the generation stats have no total_cost");
  const usd = parsed.data.data.total_cost;
  if (!Number.isFinite(usd) || usd < 0) return unavailable("the generation stats total_cost is not a non-negative amount");
  return { status: "billed", usd };
}
