import type { Sql } from "../learning/store.ts";

export type ClaimedOauthState = { organizationId: string; redirectOrigin: string; returnPath: string | null };

/**
 * Consumes an OAuth state exactly once. The WHERE clause holds every check: the person who started the flow, the provider,
 * the origin the callback arrived on, unused, and unexpired. The update is one statement, so when two callbacks present the
 * same state, only one row changes and only one of them gets a claim. A mismatched person, origin or provider changes
 * nothing, so the state stays usable by its own person from its own origin.
 */
export async function claimOauthState(
  sql: Sql,
  input: { stateHash: string; userId: string; provider: string; origin: string },
): Promise<ClaimedOauthState | null> {
  const rows = await sql<{ organization_id: string; redirect_origin: string | null; return_path: string | null }>`
    update oauth_states set used_at = now()
    where state_hash = ${input.stateHash}
      and user_id = ${input.userId}
      and provider = ${input.provider}
      and redirect_origin = ${input.origin}
      and used_at is null
      and expires_at > now()
    returning organization_id, redirect_origin, return_path
  `;
  const row = rows[0];
  if (!row || !row.redirect_origin) return null;
  return { organizationId: row.organization_id, redirectOrigin: row.redirect_origin, returnPath: row.return_path };
}
