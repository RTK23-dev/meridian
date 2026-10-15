// The workspaces an operations read may see (Video Engine Bible 15.3; AGENTS.md rule 2, tenancy checks on every server function).
// Every metric, alert and listing in this folder names the workspaces it reads, and every SQL statement filters on them. The
// caller (an API route, or a test) is responsible for passing only workspaces its user may read. An empty or malformed list is
// refused, never widened to "all workspaces".

import { EngineError } from "../contracts/index.ts";

/** The workspaces one read covers. Each id is an organization id (the Bible's workspaceId, contracts/STATUS.md). */
export type OpsScope = { organizationIds: readonly string[] };

/** A read covers at most this many workspaces (the load test uses 100). A longer list is refused rather than split silently. */
export const MAX_SCOPE_WORKSPACES = 1000;

/** The validated, de-duplicated workspace ids of a scope. Refuses an empty list, a blank id and more than the maximum. */
export function scopeIds(scope: OpsScope): string[] {
  const ids = scope.organizationIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new EngineError("invalid_input", "an operations read needs at least one workspace it may see");
  }
  if (ids.length > MAX_SCOPE_WORKSPACES) {
    throw new EngineError("invalid_input", `an operations read covers at most ${MAX_SCOPE_WORKSPACES} workspaces`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new EngineError("invalid_input", "a workspace id in an operations read is blank");
    }
    seen.add(id);
  }
  return [...seen].sort();
}

/**
 * The ids as a JSON array text, for `organization_id in (select value from json_array_elements_text($1::json))`. JSON is passed as
 * a string, as the rest of the engine's SQL does (the test database refuses object parameters).
 */
export function scopeParam(scope: OpsScope): string {
  return JSON.stringify(scopeIds(scope));
}
