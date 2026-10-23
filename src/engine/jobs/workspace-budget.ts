// The workspace monthly budget for estimate_reserve (Bible 14.1 step 2), read from Meridian's Settings (owner decision
// 2026-10-14: a "Monthly video budget (USD)" per workspace, no default). An unset budget is not connected, so nothing is
// reserved and the request says why; a made-up amount is never returned. A budget is a line (owner direction 2026-10-23, D12):
// there is no tolerance to read.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { WorkspaceBudgetSource } from "./handlers/estimate-reserve.ts";

export type MonthlyBudgetReader = (organizationId: string) => Promise<number | null>;

/** The source over a reader. Production passes `meridianMonthlyBudgetReader(sql)`; tests pass a fake reader. */
export function workspaceBudgetFromSettings(read: MonthlyBudgetReader): WorkspaceBudgetSource {
  return {
    async monthBudget({ organizationId }) {
      let usd: number | null;
      try {
        usd = await read(organizationId);
      } catch {
        return { status: "not_connected", reason: "the workspace monthly video budget could not be read, so nothing is reserved" };
      }
      if (usd === null) {
        return {
          status: "not_connected",
          reason: "no monthly video budget is set for this workspace; set \"Monthly video budget (USD)\" in Settings",
        };
      }
      return { status: "known", usd };
    },
  };
}

/** Meridian's own reader (src/lib/meridian/settings/video-budget.ts), loaded only when a budget is read. */
export function meridianMonthlyBudgetReader(sql: Sql): MonthlyBudgetReader {
  return async (organizationId) => {
    const { monthlyVideoBudgetUsd } = await import("../../lib/meridian/settings/video-budget.ts");
    return monthlyVideoBudgetUsd(sql, organizationId);
  };
}
