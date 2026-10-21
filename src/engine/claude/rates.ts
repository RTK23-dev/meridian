// Claude token rates for the estimate and the list-price fallback (Bible 11.1: Opus $4 / $20, Sonnet $2 / $10 per million
// tokens in / out; Haiku costed at Haiku 4.5's $1 / $5 until Haiku 5.5's rate is confirmed). Keyed by the OpenRouter id in
// config/routes.ts. A model with no rate here has no estimate, and the call refuses rather than guessing (fail closed).
//
// The rates live in config/prices.ts (prices@2, tokenRates); this file reads them. Cached-input reads ($0.20 per million) and Batch pricing (half price) are not used: the route does not support
// them yet (Bible 20.3 item 6).

import { budgets } from "../config/budgets.ts";
import { prices } from "../config/prices.ts";
import { EngineError } from "../contracts/errors.ts";
import { roundUsd } from "../contracts/money.ts";

export const CLAUDE_RATES_VERSION = "claude_rates@1";

const TOKENS_PER_MILLION = 1_000_000;

export type TokenRate = { inputUsdPerMillion: number; outputUsdPerMillion: number };

export const claudeRates: Readonly<Record<string, TokenRate>> = prices.tokenRates;

export type TokenCount = { input: number; output: number };

/**
 * The list-price estimate of one call, in USD with 4 decimals. A model with no rate throws unknown_price, so the estimate
 * never returns 0 or a guess for a price it does not know.
 */
export function estimateClaudeUsd(model: string, tokens: TokenCount): number {
  if (!Object.hasOwn(claudeRates, model)) {
    throw new EngineError("unknown_price", `no Claude token rate for ${model}; the estimate refuses to guess`, {
      stage: budgets.fixedStages.claudeRoles,
    });
  }
  const rate = claudeRates[model] as TokenRate;
  const usd = (tokens.input * rate.inputUsdPerMillion + tokens.output * rate.outputUsdPerMillion) / TOKENS_PER_MILLION;
  return roundUsd(usd);
}

/**
 * The estimate of one call at a live price, for a model the rate table does not name (the user's orchestrator model, read from the
 * catalog at run time). It rounds up to the micro-dollar, so a reservation is never short of the price. Refuses a negative or missing price.
 */
export function estimateFromPriceUsd(price: { promptUsdPerToken: number; completionUsdPerToken: number }, tokens: TokenCount): number {
  const values = [price.promptUsdPerToken, price.completionUsdPerToken];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new EngineError("unknown_price", "the live price of this model is not usable, so the estimate refuses to guess");
  }
  const usd = tokens.input * price.promptUsdPerToken + tokens.output * price.completionUsdPerToken;
  return Math.ceil(usd * 1_000_000) / 1_000_000;
}
