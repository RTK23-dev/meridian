// The `budget` gate (Bible 12.1 and 6.5). The reservation must have succeeded and must not be paused. Pure: it reads the
// BudgetReservation the budget module wrote, and never reads the store.

import { budgets } from "../../config/budgets.ts";
import { budgetReservationSchema, sumUsd, type GateCheck, type GateResult } from "../../contracts/index.ts";
import { usdUnits } from "../../plan/cost.ts";
import { check, gateResult, notEvaluated } from "./common.ts";

const RULES = ["reservation_succeeded", "not_paused", "cap_mode", "reserved_covers_estimate"] as const;

export function checkBudget(reservation: unknown): GateResult {
  const parsed = budgetReservationSchema.safeParse(reservation);
  if (!parsed.success) {
    const checks: GateCheck[] = [
      check("reservation_succeeded", false, { detail: `the reservation does not parse: ${parsed.error.message}` }),
    ];
    for (const rule of RULES.slice(1)) {
      checks.push(notEvaluated(rule, "the reservation does not parse"));
    }
    return gateResult("budget", "budget:unparsed", checks);
  }

  const value = parsed.data;
  const succeeded = value.state === "reserved";
  const notPaused = value.state !== "paused" && value.pausedReason === undefined;
  const capMode = value.mode === budgets.productionMode;
  const covers = usdUnits(value.reservedUsd) === usdUnits(sumUsd([value.estimateUsd, value.redoAllowanceUsd]));

  const checks: GateCheck[] = [
    check("reservation_succeeded", succeeded, {
      detail: succeeded ? "the reservation is held" : `the reservation is ${value.state}`,
    }),
    check("not_paused", notPaused, {
      detail: notPaused ? "the reservation is not paused" : `paused: ${value.pausedReason ?? value.state}`,
    }),
    check("cap_mode", capMode, {
      detail: capMode ? `mode ${value.mode}` : `mode ${value.mode}, but production runs in ${budgets.productionMode}`,
    }),
    check("reserved_covers_estimate", covers, {
      value: value.reservedUsd,
      limit: sumUsd([value.estimateUsd, value.redoAllowanceUsd]),
      detail: covers ? undefined : "reservedUsd is not the estimate plus the redo allowance",
    }),
  ];

  return gateResult("budget", value.reservationId, checks);
}
