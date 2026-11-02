import { testingRuntimeFlag } from "./config/server-settings.ts";

/**
 * Whether this process is a test or testing runtime. Read on every call, so a test can switch it for one call and restore
 * it afterwards. Every other test-only switch in the production path reads this rule through here.
 *
 * A production process is never a testing runtime, even when MERIDIAN_TESTING_RUNTIME is set by mistake. The testing
 * runtime enables placeholder providers and simulated performance, which must not reach a real workspace. Refusing the
 * switch there is the fail-closed direction: real providers only, and placeholders are refused.
 */
export function isTestingRuntimeNow(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.NODE_ENV === "test" || testingRuntimeFlag();
}
