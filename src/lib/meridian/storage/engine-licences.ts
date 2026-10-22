// The deployment's list of providers whose outputs the owner licenses for commercial social use (Bible 12.3). The engine reads it through
// the pre-render rights check (src/engine/jobs/licensed-uris.ts). It has no default: unset, the list is empty and only reviewer clips pass.

export function engineLicensedProviders(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGINE_LICENSED_PROVIDERS ?? "";
}
