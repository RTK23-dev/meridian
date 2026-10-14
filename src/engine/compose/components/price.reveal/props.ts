// Props for price.reveal (Bible 9.2, offers). A price is data, never model text (L8): the input is an integer count of
// minor units (cents, or yen for JPY) and an ISO currency code. The schema turns each amount into its display text
// with formatPrice, below, and the component draws that text as given. The old price is struck through from the start;
// the new price pops in at revealMs.

import { z } from "zod";
import { msSchema, shortTextSchema, withDuration } from "../shared.ts";

export const CURRENCY_CODES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD"] as const;
export type Currency = (typeof CURRENCY_CODES)[number];

/** The symbol drawn before the amount, and the number of minor-unit digits (JPY has none). */
const CURRENCY_FORMAT: Record<Currency, { symbol: string; exponent: number }> = {
  USD: { symbol: "$", exponent: 2 },
  EUR: { symbol: "€", exponent: 2 },
  GBP: { symbol: "£", exponent: 2 },
  JPY: { symbol: "¥", exponent: 0 },
  CAD: { symbol: "CA$", exponent: 2 },
  AUD: { symbol: "A$", exponent: 2 },
};

/**
 * The display text for one amount: the symbol, the whole units with a comma every three digits, and the fraction only
 * when it is not zero (so 4900 USD reads "$49" and 4999 reads "$49.99"). Pure and locale-free, so it is the same
 * everywhere.
 */
export function formatPrice(amountMinor: number, currency: Currency): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError(`a price must be a positive whole number of minor units, got ${amountMinor}`);
  }
  const { symbol, exponent } = CURRENCY_FORMAT[currency];
  const scale = 10 ** exponent;
  const whole = Math.floor(amountMinor / scale);
  const fractionDigits = amountMinor - whole * scale;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = exponent > 0 && fractionDigits !== 0 ? `.${String(fractionDigits).padStart(exponent, "0")}` : "";
  return `${symbol}${grouped}${fraction}`;
}

const amountSchema = z.int().positive().max(1_000_000_000);

export const propsSchema = withDuration({
  currency: z.enum(CURRENCY_CODES).default("USD"),
  oldAmountMinor: amountSchema.optional(),
  newAmountMinor: amountSchema,
  revealMs: msSchema.default(600),
  caption: shortTextSchema(40).optional(),
})
  .refine((props) => props.revealMs < props.durationMs, {
    message: "revealMs must fall inside the clip",
    path: ["revealMs"],
  })
  .transform((props) => ({
    durationMs: props.durationMs,
    revealMs: props.revealMs,
    newText: formatPrice(props.newAmountMinor, props.currency),
    ...(props.oldAmountMinor === undefined ? {} : { oldText: formatPrice(props.oldAmountMinor, props.currency) }),
    ...(props.caption === undefined ? {} : { caption: props.caption }),
  }));

export type PriceRevealProps = z.infer<typeof propsSchema>;
