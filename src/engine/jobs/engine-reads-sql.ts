// Reads the deliver stage needs from the engine tables (Video Engine Bible 5.4, 6.14): the gate results and the decisions the
// orchestrator stored for one request. Both are organization-scoped, so a request never reads another workspace's rows.
//
// The stored JSON is parsed here and checked by the caller against its contract (the deliver stage parses every gate with
// gateResultSchema). A row that does not parse as JSON is an internal error, never an empty list.

import { EngineError, type Decision, type GateResult } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

export type RequestScope = { organizationId: string; requestId: string };

function jsonOf<T>(text: string, what: string, requestId: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new EngineError("internal", `a stored ${what} of ${requestId} is not JSON`, { cause: error, stage: "deliver" });
  }
}

/** Every gate result the orchestrator stored for the request, in the order it stored them. */
export async function gateResultsOf(sql: Sql, scope: RequestScope): Promise<GateResult[]> {
  const rows = await sql<{ gate: string; subject_id: string; passed: boolean; checks: string; failing_shot_ids: string }>`
    select gate, subject_id, passed, checks, failing_shot_ids from engine_gate_results
    where organization_id = ${scope.organizationId} and request_id = ${scope.requestId}
    order by created_at asc, id asc
  `;
  return rows.map((row) => {
    const failingShotIds = jsonOf<string[]>(row.failing_shot_ids, "gate result", scope.requestId);
    return {
      gate: row.gate as GateResult["gate"],
      subjectId: row.subject_id,
      pass: row.passed,
      checks: jsonOf<GateResult["checks"]>(row.checks, "gate result", scope.requestId),
      ...(failingShotIds.length > 0 ? { failingShotIds } : {}),
    };
  });
}

/** Every decision the orchestrator stored for the request, in the order it stored them. */
export async function decisionsOf(sql: Sql, scope: RequestScope): Promise<Decision[]> {
  const rows = await sql<{ at: string; chose: string; alternatives: string; reason: string; decided_by: string }>`
    select at, chose, alternatives, reason, decided_by from engine_decisions
    where organization_id = ${scope.organizationId} and request_id = ${scope.requestId}
    order by created_at asc, id asc
  `;
  return rows.map((row) => ({
    at: row.at,
    chose: row.chose,
    alternatives: jsonOf<Decision["alternatives"]>(row.alternatives, "decision", scope.requestId),
    reason: row.reason,
    by: row.decided_by as Decision["by"],
  }));
}
