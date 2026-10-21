# Proposed: the orchestrator's Claude role (for the owner's approval)

Not applied. The repo's rules send database migrations and contract changes to the lead. This is the proposal.

## What it enables

The orchestrating model the user chooses writes the plan through the Claude client, so its call is reserved and written to the ledger
like every other role call. Today the planner (`src/engine/orchestrator/planner.ts`) takes its model call as an injected function, so
nothing reaches a provider from it.

## What is needed

1. **Contract.** Add `orchestrator_plan` to `CLAUDE_ROLES` in `src/engine/contracts/ledger.ts`.
2. **Migration.** The role names are enforced by CHECK constraints in `migrations/0081_engine_orchestration.sql` and
   `migrations/0100_engine_script_roles.sql`. A new migration must extend the list with `orchestrator_plan`. The number is the next free
   one after `0101`.
3. **Prompt.** `src/engine/prompts/orchestrator_plan@1.md`, the system text now in `planner.ts` (`buildPlannerPrompt`).
4. **Role.** `src/engine/claude/roles/orchestrator_plan.ts`: capability `llm.direction`, the plan schema as its answer, a token estimate.
5. **Client.** `RoleRequest` takes an optional `orchestrator: { modelId, price }`. With it, the route is `gateway.chosen(capability, modelId)`
   and the estimate is priced from the live catalog price (`promptUsdPerToken`, `completionUsdPerToken`), not from the fixed rate table in
   `claude/rates.ts`. Without a live price the call is refused, as it is for any unknown rate.

## Why not applied

Items 1 and 2 change a shared contract and the database. Item 5 changes the Claude client, which every role uses.

## Verification when approved

Recorded-transport tests of the role, the refusal of an unpriced model, and the ledger row written with `role = orchestrator_plan`.
A live call needs `OPENROUTER_API_KEY` in the environment and a budget cap.
