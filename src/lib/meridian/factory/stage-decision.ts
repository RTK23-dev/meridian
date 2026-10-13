import type { FactoryStage } from "./pipeline.ts";
import type { AutomationMode } from "./run-settings.ts";

/** Stages that spend money or publish. Manual and semi stop before each one until a person approves it. */
const SPEND_OR_PUBLISH: ReadonlySet<FactoryStage> = new Set(["factory.produce", "factory.launch", "factory.test"]);

export type StageDecision =
  | { action: "run" }
  | { action: "await_approval"; reason: string }
  | { action: "stop"; reason: string };

export type StageDecisionInput = {
  automation: AutomationMode;
  stage: FactoryStage;
  /** A person has approved this stage for this run. */
  approved: boolean;
  killSwitchEngaged: boolean;
  /** The total spend cap for the run, in cents, or null when none is set. */
  capCents: number | null;
  /** Metered spend recorded for this run, in cents: the sum of its factory_costs rows. */
  spentCents: number;
  /** The daily spend cap, in cents, or null when none is set. */
  dailyCapCents?: number | null;
  /** Metered spend for this run in the last 24 hours, in cents. */
  dailySpentCents?: number;
};

/**
 * Decides whether one stage may run now (NORTH_STAR §4 and §5 step 7).
 *
 * - The kill switch stops every stage, not only the spend ones.
 * - A spend or publish stage stops when a cap is reached. The check is made before the stage, in every mode, so a cap is never
 *   exceeded by the stage that reaches it. A daily cap and a total cap are each checked.
 * - manual: a person approves each spend or publish stage, and the review stage.
 * - semi: a person approves each spend or publish stage once for the run. Review runs on its own, and the gates still block.
 * - full: runs without a person, but only while a spend cap is set and not yet reached. A full run with no cap stops.
 *
 * A stage that is not approved waits; it does not fail. The approval is recorded for the run and stage, so the run continues from
 * the same point once it is given.
 */
export function stageDecision(input: StageDecisionInput): StageDecision {
  if (input.killSwitchEngaged) {
    return { action: "stop", reason: "The kill switch is engaged. Nothing runs until it is released." };
  }
  const spends = SPEND_OR_PUBLISH.has(input.stage);
  const review = input.stage === "factory.review";
  const totalCap = input.capCents ?? 0;
  const dailyCap = input.dailyCapCents ?? 0;
  if (spends) {
    if (totalCap > 0 && input.spentCents >= totalCap) return { action: "stop", reason: "The spend cap for this run is reached." };
    if (dailyCap > 0 && (input.dailySpentCents ?? 0) >= dailyCap) {
      return { action: "stop", reason: "The daily spend cap for this brand is reached." };
    }
  }
  if (input.automation === "full") {
    if (!spends) return { action: "run" };
    if (totalCap <= 0 && dailyCap <= 0) {
      return { action: "stop", reason: "Full automation needs a spend cap before it spends or publishes. Set one, then start again." };
    }
    return { action: "run" };
  }
  const needsApproval = spends || (input.automation === "manual" && review);
  if (needsApproval && !input.approved) {
    return { action: "await_approval", reason: `This step waits for a person's approval in ${input.automation} mode.` };
  }
  return { action: "run" };
}
