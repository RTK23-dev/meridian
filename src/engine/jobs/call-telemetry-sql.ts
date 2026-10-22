// The call telemetry store on engine_call_telemetry (migration 0112; gateway/telemetry.ts). It is offered only inside a budget
// transaction (withReservationLedger), so a call's row is written in the same transaction as its ledger settlement: the two are kept
// or lost together.
//
// A failed insert must not undo the settlement. So the insert runs under a savepoint: when it fails, the transaction goes back to the
// savepoint and carries on, and the settlement is kept. The failure is re-thrown here, and keepCallTelemetry logs it. The one case that
// is not covered is a rollback to the savepoint that itself fails, which means the connection is gone and the settlement fails with it.

import { EngineError } from "../contracts/index.ts";
import type { CallTelemetryRecord, CallTelemetryStore } from "../gateway/telemetry.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

export function callTelemetryInTransaction(tx: Sql, organizationId: string): CallTelemetryStore {
  return {
    async recordCallTelemetry(record: CallTelemetryRecord): Promise<void> {
      if (record.organizationId !== organizationId) {
        throw new EngineError("invalid_input", "a call's telemetry belongs to another workspace and was not written");
      }
      await tx`savepoint engine_call_telemetry`;
      try {
        await tx`
          insert into engine_call_telemetry (ledger_entry_id, organization_id, provider, model, generation_id, prompt_tokens, completion_tokens,
            latency_ms, response_cost_usd)
          values (${record.ledgerEntryId}, ${organizationId}, ${record.provider}, ${record.model}, ${record.generationId},
            ${record.promptTokens}, ${record.completionTokens}, ${record.latencyMs}, ${record.responseCostUsd})
        `;
      } catch (error) {
        await tx`rollback to savepoint engine_call_telemetry`;
        await tx`release savepoint engine_call_telemetry`;
        throw error;
      }
      await tx`release savepoint engine_call_telemetry`;
    },
  };
}
