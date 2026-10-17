// Shared schema helpers for times, spans and checks. Times are integer milliseconds (Bible section 4).

import { z } from "zod";

/** A time or offset in integer milliseconds, never negative. */
export const msSchema = z.int().nonnegative();

/** A duration in integer milliseconds, strictly positive. */
export const positiveMsSchema = z.int().positive();

/** True when the span runs forward (end strictly after start). */
export function spanOk(span: { startMs: number; endMs: number }): boolean {
  return span.endMs > span.startMs;
}

export const SPAN_MESSAGE = "endMs must be after startMs";

/**
 * Unknown means fail: a result passes only when it has at least one check and every check passes.
 * Used by GateResult (Bible 12) and TakeVerdict (Bible 6.7).
 */
export function allChecksPass(checks: ReadonlyArray<{ pass: boolean }>): boolean {
  return checks.length > 0 && checks.every((check) => check.pass);
}

export const PASS_MESSAGE = "pass must be true only when there is at least one check and every check passes";

export const hexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, {
  message: "colour must be #RRGGBB",
});

/**
 * Text of at most `max` characters that is not blank (contract v8): a brief, a source or a rationale made only of white space
 * is empty, and empty means refused. The length is the JavaScript string length (UTF-16 code units).
 */
export function nonBlankText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "must not be blank" });
}
