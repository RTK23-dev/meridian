// The economics of a brand's runs: billed, estimated and held amounts are kept apart, a cost per delivered video is only final when no
// delivered run still has a held call, and a run with no bill contributes no cost.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { economicsOf, type LedgerLine } from "./economics.ts";

function line(requestId: string, estimateUsd: number, actualUsd: number | null, settlement: LedgerLine["settlement"]): LedgerLine {
  return { requestId, estimateUsd, actualUsd, settlement };
}

describe("economics of a brand's runs", () => {
  it("divides the billed amount of delivered runs by their number, and says the figure is final", () => {
    const economics = economicsOf(
      [{ requestId: "r1", delivered: true }, { requestId: "r2", delivered: true }],
      [line("r1", 1, 0.8, "billed"), line("r1", 0.5, 0.2, "billed"), line("r2", 1, 1.2, "billed")],
    );
    assert.equal(economics.delivered, 2);
    assert.equal(economics.billedUsd, 2.2);
    assert.equal(economics.costPerDeliveredUsd, 1.1, "2.2 billed over two delivered runs");
    assert.equal(economics.costPerDeliveredFinal, true);
  });

  it("keeps estimates out of the billed amount, and counts a held call with its estimate, not as spent", () => {
    const economics = economicsOf([{ requestId: "r1", delivered: false }], [line("r1", 2, 1.5, "billed"), line("r1", 0.75, null, null)]);
    assert.equal(economics.estimatedUsd, 2.75, "every call's estimate");
    assert.equal(economics.billedUsd, 1.5, "only the settled bill is spent");
    assert.equal(economics.heldCalls, 1);
    assert.equal(economics.heldEstimateUsd, 0.75);
  });

  it("marks the cost per delivered video as not final when a delivered run still has a held call", () => {
    const economics = economicsOf([{ requestId: "r1", delivered: true }], [line("r1", 1, 0.9, "billed"), line("r1", 0.4, null, null)]);
    assert.equal(economics.costPerDeliveredUsd, 0.9, "the billed amount so far, divided by one delivered run");
    assert.equal(economics.costPerDeliveredFinal, false, "the held call may still change it");
  });

  it("counts a confirmed absence as settled zero, which is not a held call and adds no cost", () => {
    const economics = economicsOf([{ requestId: "r1", delivered: true }], [line("r1", 0.3, 0, "confirmed_absent"), line("r1", 1, 0.6, "billed")]);
    assert.equal(economics.heldCalls, 0);
    assert.equal(economics.billedUsd, 0.6);
    assert.equal(economics.costPerDeliveredFinal, true);
  });

  it("has no cost per delivered video while nothing is delivered, and never shows an estimate as one", () => {
    const economics = economicsOf([{ requestId: "r1", delivered: false }], [line("r1", 2, null, null)]);
    assert.equal(economics.costPerDeliveredUsd, null);
    assert.equal(economics.billedUsd, 0);
  });

  it("ignores lines of a request that is not one of the brand's runs", () => {
    const economics = economicsOf([{ requestId: "r1", delivered: true }], [line("other", 5, 5, "billed"), line("r1", 1, 1, "billed")]);
    assert.equal(economics.billedUsd, 1);
    assert.equal(economics.estimatedUsd, 1);
  });

  it("rounds money to four places and reads an empty brand as empty", () => {
    const rounded = economicsOf([{ requestId: "r1", delivered: true }], [line("r1", 0.00004, 0.00333333, "billed")]);
    assert.equal(rounded.billedUsd, 0.0033);
    assert.deepEqual(economicsOf([], []), {
      runs: 0,
      delivered: 0,
      estimatedUsd: 0,
      billedUsd: 0,
      heldCalls: 0,
      heldEstimateUsd: 0,
      costPerDeliveredUsd: null,
      costPerDeliveredFinal: true,
    });
  });
});
