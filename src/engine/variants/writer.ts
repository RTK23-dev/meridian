// The variant writer's call (Video Engine Bible 6.13, 11.1). A hook or language variant needs new words for some beats; this file builds
// the role's input from the request and makes one call through the Claude client (claude/client.ts runRole). That call reserves on the
// request's reservation, is journaled, and is retried once on a contract failure, so a call here is a ledger entry like any other.
//
// The outcome is typed: done with the lines, refused (the reservation does not cover it), not_connected (no key), or failed (the answer
// broke its contract twice, or the call was started and never answered). A variant with any other outcome is not built.

import { runRole, type RoleDeps } from "../claude/client.ts";
import { RoleAnswerError } from "../claude/errors.ts";
import { variantWriter, variantWriterInputSchema, type VariantWriterInput } from "../claude/roles/variant_writer.ts";
import { EngineError, type ProductionRequest } from "../contracts/index.ts";

const STAGE = "variants";

/** The attributes the writer writes lines for. A product, persona or caption change writes no words. */
export type WriterChange = { kind: "hook"; index: number; count: number } | { kind: "language"; language: string };

/**
 * The writer's input for one variant (Bible 6.13). A hook writes the request's hook beat, as the one line of its row. A language writes
 * every beat, in the target language. The beats are the master's text: they are data for the writer, not instructions. Pure.
 */
export function writerInputFor(input: { request: ProductionRequest; change: WriterChange; claims: readonly string[] }): VariantWriterInput {
  const { request, change, claims } = input;
  const beats =
    change.kind === "hook"
      ? request.script.beats.filter((beat) => beat.role === "hook").slice(0, 1)
      : request.script.beats;
  if (beats.length === 0) {
    throw new EngineError("invalid_input", "the request has no hook beat for a hook variant", { stage: STAGE });
  }
  const parsed = variantWriterInputSchema.safeParse({
    variant:
      change.kind === "hook"
        ? { attribute: "hook", label: `hook line ${change.index} of ${change.count}` }
        : { attribute: "language", label: `language ${change.language}` },
    targetLanguage: change.kind === "language" ? change.language : request.script.language,
    beats: beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, text: beat.text, emphasis: beat.emphasis ?? [] })),
    claims: [...claims],
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError(
      "invalid_input",
      `the variant writer input does not match its contract: ${issue ? issue.path.join(".") || "(root)" : "unknown"}`,
      { stage: STAGE },
    );
  }
  return parsed.data;
}

export type WriterCall = {
  requestId: string;
  workspaceId: string;
  reservationId: string;
  /** The job's infrastructure attempt, from 1 (Bible 5.1). */
  attempt: number;
  input: VariantWriterInput;
};

export type WriterOutcome =
  | { status: "done"; lines: { beatId: string; text: string }[]; calls: number }
  | { status: "refused"; reason: string }
  | { status: "not_connected"; reason: string }
  | { status: "failed"; reason: string };

/** One variant writer call through the Claude client. Infrastructure errors (network, timeout) throw, so the job retries. */
export async function writeVariantLines(deps: RoleDeps, call: WriterCall): Promise<WriterOutcome> {
  try {
    const outcome = await runRole(deps, variantWriter, {
      requestId: call.requestId,
      workspaceId: call.workspaceId,
      reservationId: call.reservationId,
      attempt: call.attempt,
      input: call.input,
    });
    if (outcome.status === "done") return { status: "done", lines: outcome.value.lines, calls: outcome.calls.length };
    if (outcome.status === "refused") return { status: "refused", reason: outcome.reason };
    // A call that was started and has no stored answer is not repeated here: its hold stays on the ledger (Bible 14.1).
    return { status: "failed", reason: "the writer's call was started before and has no answer, so it is not repeated" };
  } catch (error) {
    if (error instanceof RoleAnswerError) return { status: "failed", reason: error.message };
    if (error instanceof EngineError && error.kind === "config") return { status: "not_connected", reason: error.message };
    throw error;
  }
}
