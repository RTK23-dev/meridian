/**
 * The join from an order to the reel that drove it (NORTH_STAR section 5; Bible 16 sales learning). The rules, in order:
 *
 *  1. utm_content: the order's landing site carries the reel's utm_content. One reel matches, and the rule is "utm_content".
 *  2. dm_keyword: a discount code, or a note attribute named in NOTE_KEYWORD_NAMES, equals a reel's DM keyword (case-insensitive).
 *     One reel matches, and the rule is "dm_keyword".
 *
 * Anything else is unmatched, and that is recorded as null. A tie (two reels for one key) is also null: the join never guesses.
 * The signals come from a signed webhook body, but they are still data, so they are compared, never executed or displayed as HTML.
 */
import { utmOfLandingSite, type ShopifyOrder } from "./order.ts";

/** The note attribute names that carry a DM keyword. A storefront sets one of these when a buyer arrives from a DM. */
export const NOTE_KEYWORD_NAMES: readonly string[] = ["dm_keyword", "meridian_keyword"];

export type ReelLink = { creativeId: string; utmContent: string; dmKeyword: string };

export type OrderSignals = {
  utmContent: string | null;
  /** Discount codes as the order carries them. */
  discountCodes: readonly string[];
  /** Values of the note attributes named in NOTE_KEYWORD_NAMES. */
  noteKeywords: readonly string[];
};

export type ReelMatch = { creativeId: string; rule: "utm_content" | "dm_keyword" };

export function normalizeKeyword(value: string): string {
  return value.trim().toUpperCase();
}

/** The signals the join reads from one order. */
export function signalsOf(order: ShopifyOrder): OrderSignals {
  return {
    utmContent: utmOfLandingSite(order.landingSite).utmContent,
    discountCodes: order.discountCodes ?? [],
    noteKeywords: (order.noteAttributes ?? [])
      .filter((note) => NOTE_KEYWORD_NAMES.includes(note.name.trim().toLowerCase()))
      .map((note) => note.value),
  };
}

/** Matches one order to one reel, or returns null when no single reel is the match. Pure. */
export function matchOrderToReel(signals: OrderSignals, links: readonly ReelLink[]): ReelMatch | null {
  const utm = signals.utmContent?.trim() ?? "";
  if (utm) {
    const byUtm = links.filter((link) => link.utmContent === utm);
    if (byUtm.length === 1 && byUtm[0]) return { creativeId: byUtm[0].creativeId, rule: "utm_content" };
    // Two reels answering to one utm_content is a conflict, so it is unmatched. The keyword is not used to break the tie.
    if (byUtm.length > 1) return null;
  }
  const keywords = new Set(
    [...signals.discountCodes, ...signals.noteKeywords].map(normalizeKeyword).filter((keyword) => keyword !== ""),
  );
  if (keywords.size === 0) return null;
  const creatives = new Set(links.filter((link) => keywords.has(normalizeKeyword(link.dmKeyword))).map((link) => link.creativeId));
  if (creatives.size === 1) return { creativeId: [...creatives][0] ?? "", rule: "dm_keyword" };
  return null;
}
