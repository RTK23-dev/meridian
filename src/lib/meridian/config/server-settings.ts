// Non-secret server settings (coding loop, T3). A flag is read through one of the accessors here, so the settings a reader depends on
// are visible in one place. Secrets are not read here: keys stay with the provider resolver (src/lib/meridian/credentials), which is
// the allowlisted reader. Each accessor reads the environment when it is called, as the readers did before, so a change is seen at once.

/** The testing runtime flag. Only the exact value "true" turns it on. Any other value, or none, leaves it off. */
export function testingRuntimeFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIDIAN_TESTING_RUNTIME === "true";
}

/** Whether a proxy's forwarded headers are trusted for client keys. Only the exact value "true" trusts them. */
export function trustProxyHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIDIAN_TRUST_PROXY_HEADERS === "true";
}

/** Whether synthetic telemetry may be written outside development. Only the exact value "true" allows it. */
export function syntheticTelemetryAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_SYNTHETIC_TELEMETRY === "true";
}
