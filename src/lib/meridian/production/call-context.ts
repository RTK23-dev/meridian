/**
 * The Gemini key a production call for one organization may use. The caller resolves it here, through the one credential
 * resolver, and passes it to the providers. Providers never read the vault or the environment for a key themselves.
 */
import type { Sql } from "../learning/store.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import type { ProductionCallContext } from "./types.ts";

export async function productionCallContext(sql: Sql | undefined, organizationId: string | undefined): Promise<ProductionCallContext> {
  const resolution = await resolveCredential(sql, organizationId ?? "", "production");
  return resolution.status === "ready" ? { googleKey: resolution.secret } : {};
}
