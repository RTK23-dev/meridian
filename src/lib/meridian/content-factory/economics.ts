// What a brand's video runs cost, from the engine's ledger (portfolio economics). Four amounts are kept apart and never added together:
//   - estimated: the planning estimate of every call. It is not spending.
//   - billed: the amount a provider's bill (or a confirmed absence of one, which is zero) settled. This is what was spent.
//   - held: a call whose bill has not been read yet. It is not counted as spent, and it is shown with its estimate, which is not a bill.
// A cost per delivered video divides the billed amount of the delivered runs by their number, and says so when a delivered run still has a
// held call: the figure is then not final. Nothing here estimates a bill; a run with no bill contributes no cost.

export type RunRecord = { requestId: string; delivered: boolean };

export type LedgerLine = {
  requestId: string;
  estimateUsd: number;
  /** The settled amount: a bill, or zero for a confirmed absence. Null while the call is held. */
  actualUsd: number | null;
  settlement: "billed" | "confirmed_absent" | null;
};

export type BrandEconomics = {
  runs: number;
  delivered: number;
  estimatedUsd: number;
  billedUsd: number;
  heldCalls: number;
  heldEstimateUsd: number;
  /** Billed amount of the delivered runs, divided by their number. Null when no run is delivered. */
  costPerDeliveredUsd: number | null;
  /** False when a delivered run still has a held call, so its cost may still change. */
  costPerDeliveredFinal: boolean;
};

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The economics of a brand's runs. A line whose request is not among the runs is ignored: the runs say which lines are the brand's. */
export function economicsOf(runs: readonly RunRecord[], lines: readonly LedgerLine[]): BrandEconomics {
  const deliveredIds = new Set(runs.filter((run) => run.delivered).map((run) => run.requestId));
  const runIds = new Set(runs.map((run) => run.requestId));
  let estimatedUsd = 0;
  let billedUsd = 0;
  let heldCalls = 0;
  let heldEstimateUsd = 0;
  let deliveredBilledUsd = 0;
  let deliveredHeld = false;
  for (const line of lines) {
    if (!runIds.has(line.requestId)) continue;
    const delivered = deliveredIds.has(line.requestId);
    estimatedUsd += line.estimateUsd;
    if (line.settlement === null || line.actualUsd === null) {
      heldCalls += 1;
      heldEstimateUsd += line.estimateUsd;
      if (delivered) deliveredHeld = true;
      continue;
    }
    billedUsd += line.actualUsd;
    if (delivered) deliveredBilledUsd += line.actualUsd;
  }
  const delivered = deliveredIds.size;
  return {
    runs: runs.length,
    delivered,
    estimatedUsd: roundUsd(estimatedUsd),
    billedUsd: roundUsd(billedUsd),
    heldCalls,
    heldEstimateUsd: roundUsd(heldEstimateUsd),
    costPerDeliveredUsd: delivered === 0 ? null : roundUsd(deliveredBilledUsd / delivered),
    costPerDeliveredFinal: !deliveredHeld,
  };
}
