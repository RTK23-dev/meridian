// Budget constants (Bible 14). The redo allowance is tuned (16.2); the rest are initial estimates that the
// ledger replaces with measurements.

import { tunable } from "./tunable.ts";

export const budgets = {
  version: "budgets@1",

  // 14.1: production runs in cap mode (refuse calls beyond the reservation).
  productionMode: "cap" as const,

  // 6.5 and 14.1: redo allowance as a share of the generated-shot cost. Tuned from observed redo spend (16.2).
  redoAllowanceShare: tunable(0.25, 0.05, 1),

  // 14.2: fixed cost of every master, about $0.52 in total.
  fixedPerMasterUsd: {
    claudeRoles: 0.4,
    critic: 0.05,
    render: 0.05,
    speechAndFfmpeg: 0.02,
  },

  // Stage labels for the fixed budget lines (BudgetReservation.lines). Manifest.cost: brain = claudeRoles + critic,
  // render = render, other = media, generation = the shots.
  fixedStages: {
    claudeRoles: "claude_roles",
    critic: "critic",
    render: "render",
    media: "media",
  },

  // 14.4: there is no default request budget. The user sets the budget of every master in the request
  // (ProductionRequest.constraints.budgetUsd); intake refuses one below the format minimum. Owner decision, 2026-10-14.

  // 14.4: alert when a format's average real cost exceeds its estimate by this share for a day.
  overrunAlertShare: 0.2,

  // 14.3: cost of a variant change (initial), low and high in USD.
  variantCostUsd: {
    captionOrText: { low: 0.05, high: 0.07 },
    musicSwap: { low: 0.06, high: 0.06 },
    newHookLine: { low: 0.26, high: 0.26 },
    productSwap: { low: 0.4, high: 0.4 },
    newCinematicHook: { low: 1.06, high: 1.06 },
    newPersonaOrLanguage: { low: 1.4, high: 1.4 },
  },
} as const;
