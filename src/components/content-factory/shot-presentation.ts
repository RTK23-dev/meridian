// What a shot's remake quote says on the board, and whether the remake button may be pressed. Pure, so the rules are tested without the
// page. The quote is an estimate at list prices: the bill is recorded when each call is billed, and the unspent part is released after.

import { costLabel } from "../../lib/meridian/content-factory/feed.ts";

/** A remake quote as the board reads it (service.ts shotRemakeQuote). */
export type QuoteView =
  | { status: "quoted"; fits: boolean; reservedUsd: number; reasons: string[] }
  | { status: "refused"; reasons: string[] };

/** The quote the board holds for a shot: still loading, not available (the engine decides on confirm), or read. */
export type QuoteState = { state: "loading" } | { state: "unavailable" } | { state: "ready"; quote: QuoteView };

export function quoteSentence(quote: QuoteView): string {
  if (quote.status === "refused") return quote.reasons[0] ?? "This shot cannot be remade now.";
  if (!quote.fits) return `This remake would be refused: ${quote.reasons.join("; ")}.`;
  return `Remaking this shot holds up to ${costLabel(quote.reservedUsd)} until its calls are billed, then the unspent part is released. The amount is an estimate at list prices.`;
}

/**
 * Whether the button may be pressed. While the quote loads it may not, so a reviewer never confirms a remake the board has not priced. A
 * quote that is not available may be pressed: the engine checks the same rules again when the reviewer confirms. A refused or unfitting
 * quote may not, because the remake would be refused.
 */
export function quoteAllowsRemake(state: QuoteState): boolean {
  if (state.state === "loading") return false;
  if (state.state === "unavailable") return true;
  return state.quote.status === "quoted" && state.quote.fits;
}
