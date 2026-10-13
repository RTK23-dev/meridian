/**
 * The published token prices the Factory uses to put a dollar cost on a decision (NORTH_STAR section 8, item 2). Each entry names the
 * provider's own price page and the date the price was read. A decision whose engine and model have no entry is still metered: its
 * prompt and completion tokens are recorded, and its cost is null. Null is never zero. The run says "tokens only, not priced".
 *
 * A price is changed only by reading the page again and writing a new version here. Nothing is guessed: a model that is not in this
 * table has no price.
 *
 * What a price here does not cover: the engine reports no cache-write tokens, so a request that wrote to the prompt cache is not priced
 * for those writes. The page lists a cache-write rate for this model, so a cost here can be lower than the invoice when writes happened.
 */

/** The version of this table. A cost row records it, so a later table can be told apart from this one. */
export const PRICE_TABLE_VERSION = "openai-token-prices-2026-10-13";

/** The page the OpenAI entry was read from, and the date it was read. */
export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
export const OPENAI_PRICING_READ_ON = "2026-10-13";

/** Above this many input tokens in one request, the long-context rates apply: "Long context: >272K input tokens". */
export const LONG_CONTEXT_INPUT_TOKENS = 272_000;

/** USD per 1,000,000 tokens. */
export type TokenRates = { input: number; cachedInput: number; output: number };

export type TokenPriceEntry = {
  /** The decision engine the model is run by. */
  engineId: string;
  /** The model name, as the engine is asked for it. Dated snapshots of it (model-YYYY-MM-DD) are priced under it. */
  model: string;
  /** Rates for a request with at most LONG_CONTEXT_INPUT_TOKENS input tokens. */
  short: TokenRates;
  /** Rates for a request with more than LONG_CONTEXT_INPUT_TOKENS input tokens. */
  long: TokenRates;
  sourceUrl: string;
  readOn: string;
};

/**
 * The entries. gpt-6-luna is the default model of the OpenAI Decisions engine (decisions/openai-engine.ts). Its rates are the Standard
 * table on the OpenAI pricing page, read on 2026-10-13, short context and long context, in the order the page lists them: input, cached
 * input, cache writes (not priced here, see the note above), output.
 */
export const TOKEN_PRICES: readonly TokenPriceEntry[] = [
  {
    engineId: "openai-decisions",
    model: "gpt-6-luna",
    short: { input: 0.1, cachedInput: 0.01, output: 0.5 },
    long: { input: 0.2, cachedInput: 0.02, output: 0.75 },
    sourceUrl: OPENAI_PRICING_URL,
    readOn: OPENAI_PRICING_READ_ON,
  },
];

/** True for a dated snapshot of the model, such as gpt-6-luna-2026-09-22. Any other suffix is a different model. */
function isSnapshotOf(label: string, model: string): boolean {
  if (!label.startsWith(`${model}-`)) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(label.slice(model.length + 1));
}

/**
 * The price entry for a decision, or null. The engine must be the entry's engine. The model asked for must be the entry's model, and the
 * model the provider reports must be that model or a dated snapshot of it. A missing report is accepted, because the model asked for is
 * the one that ran. A model the table does not name has no price.
 */
export function tokenPriceFor(engineId: string, requestedModel: string | null, returnedModel: string | null): TokenPriceEntry | null {
  const requested = (requestedModel ?? "").trim();
  const returned = (returnedModel ?? "").trim();
  if (!requested && !returned) return null;
  for (const entry of TOKEN_PRICES) {
    if (entry.engineId !== engineId) continue;
    if (requested !== "" && requested !== entry.model) continue;
    if (returned !== "" && returned !== entry.model && !isSnapshotOf(returned, entry.model)) continue;
    return entry;
  }
  return null;
}

/**
 * The cost of one decision's tokens, in micro-dollars (one millionth of a dollar), rounded to the nearest micro-dollar. Cached input
 * tokens are part of the input tokens the engine reports, so they are billed at the cached rate and the rest at the input rate.
 * Output tokens include reasoning tokens, as the engine reports them.
 */
export function decisionCostMicros(
  entry: TokenPriceEntry,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number {
  const rates = usage.inputTokens > LONG_CONTEXT_INPUT_TOKENS ? entry.long : entry.short;
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const usd = (uncached * rates.input + cached * rates.cachedInput + usage.outputTokens * rates.output) / 1_000_000;
  return Math.round(usd * 1_000_000);
}
