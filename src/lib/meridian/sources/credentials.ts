/**
 * The key a source connector uses for one workspace. It is the same resolver call every provider uses, so a source reads the
 * workspace's saved key first, and the deployment's key only when that category's shared default is opted in. A source
 * without a usable key reports the resolver's reason. It never reports itself connected.
 */
import { secretForCategory } from "../credentials/resolve.ts";
import type { SourceCredentialCategory } from "../credentials/contract.ts";

export type SourceKey = {
  /** The key, or null when the source has none to use. */
  secret: string | null;
  /** Why there is no key, shown in source health. Empty when a key is ready. */
  reason: string;
};

export async function sourceKeyFor(category: SourceCredentialCategory, organizationId: string | undefined): Promise<SourceKey> {
  const resolved = await secretForCategory(category, organizationId);
  return { secret: resolved.secret, reason: resolved.reason };
}
