/**
 * The nightly change cap on tuned values (Bible 16.3: every tuned value has a floor, a ceiling and a maximum change per night, initially
 * 15%). A night that proposes a change to a tuned value is held to the cap. The part of a move beyond the cap is refused for the excess,
 * the value is kept at the cap, and the morning summary says what was refused and why. The clamp is the engine's own (clampTunable), so
 * the cap has one rule, not a copy of it.
 *
 * Pure: it reads the proposals it is given and writes nothing. Sleep mode writes no engine config, so an accepted change is recorded for
 * the learning step and is not applied anywhere in this build.
 */
import { clampTunable, MAX_NIGHTLY_CHANGE_SHARE, type Tunable } from "../../../engine/config/tunable.ts";

/** One tuned value a night proposes to move: the value as it stands, with its bounds, and the value proposed. */
export type TunedProposal = { key: string; current: Tunable; proposed: number };

/** A proposed change inside the cap, in full: the value it moves from and to. */
export type TuningAccepted = { key: string; from: number; to: number };

/**
 * A proposed change the cap refused in part, or in whole. `kept` is the value the night keeps and `excess` is the part of the move that was
 * refused. A proposal that is not a finite number is refused whole: `proposed` is null, `excess` is null, and the current value is kept.
 */
export type TuningRefused = {
  key: string;
  from: number;
  proposed: number | null;
  kept: number;
  excess: number | null;
  reason: string;
};

export type NightlyTuning = {
  maxChangeShare: number;
  accepted: TuningAccepted[];
  refused: TuningRefused[];
};

function percentOf(share: number): number {
  return Math.round(share * 100);
}

/** The reason a proposal is refused, as a clause: the cap, the bounds, or both. */
function reasonOf(current: Tunable, proposed: number, maxChangeShare: number): string {
  const beyondShare = Math.abs(proposed - current.value) > Math.abs(current.value) * maxChangeShare;
  const beyondBounds = proposed < current.floor || proposed > current.ceiling;
  const share = `it moves more than ${percentOf(maxChangeShare)}% from the current value`;
  if (beyondShare && beyondBounds) return `${share}, and it is outside the floor or ceiling`;
  if (beyondShare) return share;
  return "it is outside the floor or ceiling";
}

/**
 * Holds each proposal to the nightly cap. A proposal inside the cap and the bounds is accepted. One beyond them is refused for the
 * excess, and the value is kept where the cap or the bound stops it. A proposal equal to the current value is neither.
 */
export function nightlyTuningOf(proposals: readonly TunedProposal[], maxChangeShare: number = MAX_NIGHTLY_CHANGE_SHARE): NightlyTuning {
  const accepted: TuningAccepted[] = [];
  const refused: TuningRefused[] = [];
  for (const { key, current, proposed } of proposals) {
    const kept = clampTunable(proposed, current, maxChangeShare);
    if (!Number.isFinite(proposed)) {
      refused.push({ key, from: current.value, proposed: null, kept, excess: null, reason: "the proposal is not a finite number" });
      continue;
    }
    if (kept === proposed) {
      if (proposed !== current.value) accepted.push({ key, from: current.value, to: proposed });
      continue;
    }
    refused.push({
      key,
      from: current.value,
      proposed,
      kept,
      excess: Math.abs(proposed - kept),
      reason: reasonOf(current, proposed, maxChangeShare),
    });
  }
  return { maxChangeShare, accepted, refused };
}

function formatted(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * The morning summary's line on tuned values: how many changes were accepted, and each refusal with its values and its reason. Empty
 * when no value was proposed, so a night with nothing to say adds nothing to its summary.
 */
export function tuningSummaryOf(tuning: NightlyTuning): string {
  if (tuning.accepted.length === 0 && tuning.refused.length === 0) return "";
  const accepted = tuning.accepted.length;
  const lead = `Tuning: ${accepted} proposed change${accepted === 1 ? "" : "s"} inside the ${percentOf(tuning.maxChangeShare)}% nightly cap, ${tuning.refused.length} refused.`;
  const refusals = tuning.refused.map((item) => {
    const proposed = item.proposed === null ? "no number" : formatted(item.proposed);
    return `Refused ${item.key}: proposed ${proposed}, kept ${formatted(item.kept)}, because ${item.reason}.`;
  });
  return [lead, ...refusals].join(" ");
}
