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

/** What the reviewer chose to do to a shot: keep it (a plain remake), edit its prompt, or change its visual type. */
export type ChangeMode = "keep" | "edit_prompt" | "cinematic" | "stock_footage";

export const CHANGE_MODE_LABELS: Record<ChangeMode, string> = {
  keep: "Make it again, as it is",
  edit_prompt: "Edit its prompt",
  cinematic: "Change it to a cinematic shot",
  stock_footage: "Change it to stock footage",
};

/** The decision a change form makes, or the reason it cannot yet: a prompt is required to edit, and a query to use stock footage. */
export type ChangeOutcome = { ok: true; decision: ShotDecisionView | null } | { ok: false; reason: string };

/** The decision in the shape the engine takes (review/shot-decision.ts). Only the fields this form writes. */
export type ShotDecisionView = { action: "edit_prompt"; prompt: string } | { action: "change_visual_type"; visualType: "cinematic" | "stock_footage"; prompt?: string; query?: string };

export function changeOf(mode: ChangeMode, text: string, query: string): ChangeOutcome {
  const prompt = text.trim();
  if (mode === "keep") return { ok: true, decision: null };
  if (mode === "edit_prompt") {
    return prompt === "" ? { ok: false, reason: "Write the new prompt for this shot." } : { ok: true, decision: { action: "edit_prompt", prompt } };
  }
  if (mode === "stock_footage") {
    const search = query.trim();
    return search === "" ? { ok: false, reason: "Write the search for the stock footage." } : { ok: true, decision: { action: "change_visual_type", visualType: "stock_footage", query: search } };
  }
  return { ok: true, decision: { action: "change_visual_type", visualType: "cinematic", ...(prompt === "" ? {} : { prompt }) } };
}
