// Confirming a selection (round 3, K11). A proposal (selector.ts) is shown to the person in a normal run, and nothing is sent to the orchestrator
// until they confirm, optionally after changing the cookbook or its values. In an automated loop the top pick is accepted as it is. Every
// choice is recorded with how it was made: confirmed, changed by the person, or auto-accepted. The record is what the research agents learn
// from (decision D6).

import { contentHash } from "../../../engine/contracts/hash.ts";
import type { ControlValue } from "./controls.ts";
import type { Proposal } from "./selector.ts";
import { fitsControl } from "./validate.ts";
import { eligibilityFor, type RunInputs } from "./eligibility.ts";
import type { Cookbook } from "./schema.ts";

export type SelectionRecord = {
  cookbookId: string;
  version: number;
  values: Record<string, ControlValue>;
  valuesHash: string;
  /**
   * confirmed: the person accepted the top pick as proposed. changed: the person chose another cookbook or other values. auto_accepted: an
   * automated loop. picked: no selector is connected, so the person chose from the eligible list with no suggestion.
   */
  how: "confirmed" | "changed" | "auto_accepted" | "picked";
  /** The pick the selector gave first, so a change is visible in the record. Null when no selector gave one (a picked record). */
  proposedCookbookId: string | null;
};

export type SelectionState = { state: "awaiting_confirmation" } | { state: "auto_accepted"; record: SelectionRecord } | { state: "none" };

type ProposedPick = Extract<Proposal, { status: "proposed" }>["picks"][number];

/** A normal run waits for the person. An automated loop accepts the top pick as it is. No proposal means nothing to accept. */
export function selectionStateOf(proposal: Proposal, runKind: RunInputs["runKind"]): SelectionState {
  if (proposal.status !== "proposed") return { state: "none" };
  if (runKind === "normal") return { state: "awaiting_confirmation" };
  const top = proposal.picks[0];
  if (!top) return { state: "none" };
  return { state: "auto_accepted", record: recordOf(top, top.values, "auto_accepted", top.cookbookId) };
}

/**
 * The person's confirmation. The choice names a cookbook from the eligible ones (the proposal's picks or its alternatives, which the proposal
 * lists by id) and values that fit its controls. Anything else is refused.
 */
export function confirmSelection(input: {
  proposal: Proposal;
  choice: { cookbookId: string; version: number; values?: Record<string, ControlValue> };
  cookbooks: readonly Cookbook[];
  inputs: RunInputs;
}): { ok: true; record: SelectionRecord } | { ok: false; reason: string } {
  if (input.proposal.status !== "proposed") return { ok: false, reason: "There is no proposal to confirm." };
  const cookbook = input.cookbooks.find((candidate) => candidate.cookbookId === input.choice.cookbookId && candidate.version === input.choice.version);
  if (!cookbook) return { ok: false, reason: "That cookbook is not in this library." };
  const eligibility = eligibilityFor(cookbook, input.inputs);
  if (!eligibility.eligible) return { ok: false, reason: `That cookbook cannot run with these inputs: ${eligibility.reasons.join("; ")}` };
  const values: Record<string, ControlValue> = {};
  for (const [id, value] of Object.entries(input.choice.values ?? {})) {
    const control = cookbook.controls.find((candidate) => candidate.id === id);
    if (!control || !fitsControl(control, value)) return { ok: false, reason: `Control ${id} does not take that value.` };
    values[id] = value;
  }
  const proposed = input.proposal.picks[0];
  const unchanged =
    proposed !== undefined &&
    proposed.cookbookId === cookbook.cookbookId &&
    proposed.version === cookbook.version &&
    Object.keys(values).every((id) => values[id] === proposed.values[id]);
  const finalValues = { ...(proposed?.values ?? {}), ...values };
  const record = recordOf(
    { cookbookId: cookbook.cookbookId, version: cookbook.version, values: finalValues } as ProposedPick,
    finalValues,
    unchanged ? "confirmed" : "changed",
    proposed?.cookbookId ?? cookbook.cookbookId,
  );
  return { ok: true, record };
}

/**
 * The person's choice when no selector is connected: a cookbook from the eligible list, with its values. There is no suggestion to compare
 * with, so the record says picked and names no proposed cookbook.
 */
export function pickFromList(input: {
  eligibleIds: readonly string[];
  cookbooks: readonly Cookbook[];
  inputs: RunInputs;
  choice: { cookbookId: string; version: number; values?: Record<string, ControlValue> };
}): { ok: true; record: SelectionRecord } | { ok: false; reason: string } {
  if (!input.eligibleIds.includes(input.choice.cookbookId)) return { ok: false, reason: "That cookbook cannot run with these inputs." };
  const cookbook = input.cookbooks.find((candidate) => candidate.cookbookId === input.choice.cookbookId && candidate.version === input.choice.version);
  if (!cookbook) return { ok: false, reason: "That cookbook is not in this library." };
  const values: Record<string, ControlValue> = {};
  for (const [id, value] of Object.entries(input.choice.values ?? {})) {
    const control = cookbook.controls.find((candidate) => candidate.id === id);
    if (!control || !fitsControl(control, value)) return { ok: false, reason: `Control ${id} does not take that value.` };
    values[id] = value;
  }
  // The values the cookbook starts from are its defaults, so the record holds the whole set the run used.
  const finalValues: Record<string, ControlValue> = Object.fromEntries(cookbook.controls.map((control) => [control.id, control.default]));
  Object.assign(finalValues, values);
  return { ok: true, record: recordOf({ cookbookId: cookbook.cookbookId, version: cookbook.version }, finalValues, "picked", null) };
}

function recordOf(pick: Pick<ProposedPick, "cookbookId" | "version">, values: Record<string, ControlValue>, how: SelectionRecord["how"], proposedCookbookId: string | null): SelectionRecord {
  return {
    cookbookId: pick.cookbookId,
    version: pick.version,
    values,
    valuesHash: contentHash(values),
    how,
    proposedCookbookId,
  };
}
