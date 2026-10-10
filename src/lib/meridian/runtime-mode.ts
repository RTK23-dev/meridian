/**
 * Whether this process is a test or testing runtime. Read on every call, so a test can switch it for one call and restore
 * it afterwards. Every other test-only switch in the production path reads this rule through here.
 */
export function isTestingRuntimeNow(): boolean {
  return process.env.NODE_ENV === "test" || process.env.MERIDIAN_TESTING_RUNTIME === "true";
}
