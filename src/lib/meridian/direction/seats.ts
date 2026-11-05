// Which model sits in each direction seat for one workspace (AGENTS.md rule 5: an explicit choice, or Auto). The director and the first
// writer are the workspace's model for "Copy and scripts". The second writer and the judge are their own tasks in Settings
// (settings/generation-models.ts); Auto is the copy model, so a run with nothing chosen still runs, and says that one family wrote and
// judged it. A chosen model is checked against the live catalogue before a run, like every generation task: a model that has left the
// catalogue is refused with its reason, never swapped for another.
//
// Slots are keyed by model id, so two seats with the same model share a slot, and the pipeline's notes (one writer family, a judge that
// shares a writer's model) follow from the seats themselves.

import { generationModelFor, type GenerationDeps } from "../providers/chat.server.ts";
import type { GenerationTask } from "../settings/generation-models.ts";
import type { SlotModel } from "./live.server.ts";

export type DirectionSeats = {
  slots: Record<string, SlotModel>;
  writers: string[];
  judge: string;
  director: string;
  /** What a person sees: the model in each seat, and whether the seat is on Auto. */
  view: { writer: string; secondWriter: string | null; judge: string; secondWriterAuto: boolean; judgeAuto: boolean };
};

export type SeatsOutcome = { ok: true; seats: DirectionSeats } | { ok: false; reason: string };

/** The stored model of a task, or null on Auto. `deps.stored` must be given: Auto is decided by what is stored, not by a default. */
type Stored = NonNullable<GenerationDeps["stored"]>;

async function chosenSeat(organizationId: string, task: GenerationTask, stored: Stored, deps: GenerationDeps): Promise<{ status: "auto" } | { status: "ok"; slot: SlotModel } | { status: "refused"; reason: string }> {
  if (!(await stored(organizationId, task))) return { status: "auto" };
  const decision = await generationModelFor(organizationId, task, { ...deps, stored });
  if (decision.status !== "ok") return { status: "refused", reason: decision.reason };
  return { status: "ok", slot: { model: decision.model, choice: decision.choice } };
}

/** The seats of one workspace's direction runs, each checked against the live catalogue. Nothing is called that spends. */
export async function directionSeats(organizationId: string, stored: Stored, deps: GenerationDeps = {}): Promise<SeatsOutcome> {
  const copy = await generationModelFor(organizationId, "copy", { ...deps, stored });
  if (copy.status !== "ok") return { ok: false, reason: `${copy.reason} Direction writes with the Copy and scripts model.` };
  const writer: SlotModel = { model: copy.model, choice: copy.choice };
  const second = await chosenSeat(organizationId, "direction_writer", stored, deps);
  if (second.status === "refused") return { ok: false, reason: `Second script writer: ${second.reason}` };
  const judge = await chosenSeat(organizationId, "direction_judge", stored, deps);
  if (judge.status === "refused") return { ok: false, reason: `Script judge: ${judge.reason}` };

  const slots: Record<string, SlotModel> = { [writer.model]: writer };
  const writers = [writer.model];
  if (second.status === "ok" && second.slot.model !== writer.model) {
    slots[second.slot.model] = second.slot;
    writers.push(second.slot.model);
  }
  const judgeSlot = judge.status === "ok" ? judge.slot : writer;
  slots[judgeSlot.model] = judgeSlot;
  return {
    ok: true,
    seats: {
      slots,
      writers,
      judge: judgeSlot.model,
      director: writer.model,
      view: {
        writer: writer.model,
        secondWriter: second.status === "ok" ? second.slot.model : null,
        judge: judgeSlot.model,
        secondWriterAuto: second.status === "auto",
        judgeAuto: judge.status === "auto",
      },
    },
  };
}
