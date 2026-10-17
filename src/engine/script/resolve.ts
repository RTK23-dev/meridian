// The one resolver of a request's script (contract v8, Bible 6.x write_script). Every consumer that reads the words a video speaks
// takes them from here, so no consumer reads `request.script` itself:
//   - a script request: its own script (the words it was sent with);
//   - a brief request: the request's written_script artifact, which write_script stores once the script is written.
// A brief request with no written script yet is an internal error at that point. The resolver never guesses a script, and it never
// returns an empty one (fail closed, CLAUDE.md working rule 1). Pure: it reads no store. The stage reads the artifact through its
// inputs (Bible 5.1) and passes it here.

import { EngineError, writtenScriptSchema, type ProductionRequest, type ScriptBeat, type WrittenScript } from "../contracts/index.ts";

/** The words a video speaks, in the order it speaks them. The same shape for a sent script and a written one. */
export type ScriptBody = { language: string; beats: ScriptBeat[] };

/** The minimal shape of an artifact the resolver reads: its type and its body (an ArtifactEnvelope satisfies it). */
export type ArtifactLike = { envelope: { type: string; body: unknown; requestId: string } };

/**
 * The script of a request. A script request returns its own script; `written` must then be null (a script request has no written
 * script, and reading both would be a fault). A brief request returns the written script, and `written` must be its artifact.
 */
export function scriptOf(request: ProductionRequest, written: WrittenScript | null): ScriptBody {
  if (request.script !== undefined) {
    if (written !== null) {
      throw new EngineError("internal", `request ${request.requestId} sends its own script, so it has no written script to read`, {
        stage: "write_script",
      });
    }
    return { language: request.script.language, beats: [...request.script.beats] };
  }
  if (request.brief === undefined) {
    throw new EngineError("internal", `request ${request.requestId} has neither a script nor a brief`, { stage: "write_script" });
  }
  if (written === null) {
    throw new EngineError(
      "internal",
      `brief request ${request.requestId} has no written script yet: write_script writes it after analyze_reference, and no stage reads the script before that (contract v8)`,
      { stage: "write_script" },
    );
  }
  if (written.requestId !== request.requestId) {
    throw new EngineError("internal", `the written script names request ${written.requestId}, not ${request.requestId}`, { stage: "write_script" });
  }
  return { language: written.language, beats: [...written.beats] };
}

/**
 * The written script among a job's input artifacts, parsed, or null when none is one. An artifact of the type that does not parse, or
 * that belongs to another request, is an internal error: it is never read as a script.
 */
export function writtenScriptOf(inputs: readonly ArtifactLike[], requestId: string): WrittenScript | null {
  let found: WrittenScript | null = null;
  for (const input of inputs) {
    if (input.envelope.type !== "written_script") continue;
    if (input.envelope.requestId !== requestId) {
      throw new EngineError("invalid_input", `the written script belongs to request ${input.envelope.requestId}, not ${requestId}`, {
        stage: "write_script",
      });
    }
    const parsed = writtenScriptSchema.safeParse(input.envelope.body);
    if (!parsed.success) {
      throw new EngineError("internal", "the written script artifact no longer matches its contract", { stage: "write_script" });
    }
    if (found !== null) throw new EngineError("internal", `request ${requestId} has more than one written script input`, { stage: "write_script" });
    found = parsed.data;
  }
  return found;
}

/** Whether a request is a brief request (it has no script of its own, and the engine writes one). */
export function isBriefRequest(request: ProductionRequest): boolean {
  return request.script === undefined;
}
