/**
 * The rule for a typed spend cap, in dollars. A blank cap is not sent, so it is accepted. Any other value must be a finite
 * number at zero or more. The test is on the number itself: rounding first turns -0.001 into -0, which is not a refusal.
 * This module imports nothing, so the browser bundle can use it directly.
 */
export function isCapAmount(value: string): boolean {
  if (value.trim() === "") return true;
  const amount = Number(value.trim());
  return Number.isFinite(amount) && amount >= 0;
}
