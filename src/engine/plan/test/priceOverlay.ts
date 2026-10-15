// A test-only overlay of the price table (config/prices.ts). Not a test file. The budget estimate (budget/estimate.ts) reads prices
// through priceFor, which reads this same table, so a test that wants a price to be known (for example, the owner has priced
// image.edit per image) must put it in the table for the run, and restore the table after. Nothing here changes production: the
// table is restored in `finally`, and node runs each test file in its own process.

import { prices, type Price } from "../../config/prices.ts";

/** Runs `run` with the overlay's prices in the table, then puts every overwritten price back, even when `run` throws. */
export async function withPriceOverlay<T>(
  overlay: Record<string, Price>,
  run: () => Promise<T> | T,
): Promise<T> {
  const table = prices.entries as Record<string, Price>;
  const saved = new Map<string, Price>();
  for (const [key, price] of Object.entries(overlay)) {
    saved.set(key, table[key] as Price);
    table[key] = price;
  }
  try {
    return await run();
  } finally {
    for (const [key, price] of saved) table[key] = price;
  }
}
