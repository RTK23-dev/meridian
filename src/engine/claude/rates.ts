// Claude token rates for the estimate and the list-price fallback (Bible 11.1: Opus $4 / $20, Sonnet $2 / $10 per million
// tokens in / out; Haiku costed at Haiku 4.5's $1 / $5 until Haiku 5.5's rate is confirmed). Keyed by the OpenRouter id in
// config/routes.ts. A model with no rate here has no estimate, and the call refuses rather than guessing (fail closed).
//
// These rates sit in this folder only because config/ is outside the W3 write scope. They belong in config/prices.ts; see
// STATUS.md. Cached-input reads ($0.20 per million) and Batch pricing (half price) are not used: the route does not support
// them yet (Bible 20.3 item 6).

import { budgets } from "../config/budgets.ts";
import { EngineError } from "../contracts/errors.ts";
import { roundUsd } from "../contracts/money.ts";

export const CLAUDE_RATES_VERSION = "claude_rates@1";

const TOKENS_PER_MILLION = 1_000_000;

export type TokenRate = { inputUsdPerMillion: number; outputUsdPerMillion: number };

export const claudeRates: Readonly<Record<string, TokenRate>> = {
  "anthropic/claude-opus-5.5": { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
  "anthropic/claude-sonnet-5.5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  "anthropic/claude-haiku-5.5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
};

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
