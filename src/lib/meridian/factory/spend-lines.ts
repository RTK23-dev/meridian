/**
 * The words the Factory uses for a run's spend (NORTH_STAR section 8, item 2). Pure: it imports nothing that needs the server, so the
 * run list and the cost list in the browser use it directly. The figures come from spend.ts, read from factory_costs. Nothing here is
 * estimated: a decision with no price is "tokens only, not priced", and its cost is unknown, never zero.
 */

/** The figures a run's spend is shown from. Matches RunSpend in spend.ts. */
export type SpendFigures = {
  pricedMicros: number;
  pricedDecisions: number;
  tokenOnlyDecisions: number;
  tokens: number;
  providerCents: number;
};

/** A micro-dollar amount as dollars, with enough places to show a fraction of a cent. */
export function usdOfMicros(micros: number): string {
  return `$${(Math.max(0, micros) / 1_000_000).toFixed(6)}`;
}

/** Cents as dollars. */
export function usdOfCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/** The lines that say what a run spent, in plain words. The last line is the rule the caps follow, and it is always shown. */
export function spendLinesOf(spend: SpendFigures): string[] {
  const lines: string[] = [];
  const anyMetered = spend.pricedDecisions > 0 || spend.tokenOnlyDecisions > 0;
  if (!anyMetered && spend.providerCents === 0) {
    lines.push("No metered spend yet. A decision that reports its tokens is recorded here.");
  }
  if (spend.pricedDecisions > 0) {
    lines.push(`Priced spend ${usdOfMicros(spend.pricedMicros)} over ${spend.pricedDecisions} decision${spend.pricedDecisions === 1 ? "" : "s"}.`);
  }
  if (spend.tokenOnlyDecisions > 0) {
    lines.push(
      `${spend.tokenOnlyDecisions} decision${spend.tokenOnlyDecisions === 1 ? "" : "s"}: tokens only, not priced. The model has no published price in this build, so the cost is unknown, not zero.`,
    );
  }
  if (anyMetered) {
    lines.push(`${spend.tokens} tokens were reported for these decisions.`);
  }
  if (spend.providerCents > 0) {
    lines.push(`Provider calls reported ${usdOfCents(spend.providerCents)}.`);
  }
  lines.push("Unpriced spend is not counted by caps. A cap counts only priced cost.");
  return lines;
}
