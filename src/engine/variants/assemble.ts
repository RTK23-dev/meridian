// The assembly of a generation variant's EDL (Video Engine Bible 6.8, 6.13). A variant changes a line, a product or a persona, so its
// narration, its captions and its picture change with it. The EDL is therefore built again by the same editor that built the master
// (edit/editor.ts, buildEdl), over the variant's own inputs: its plan (the master's, with the references and prompts the change needs), its
// voice (the variant's narration, or the master's when the change keeps it), the takes each generated shot plays (the master's accepted take,
// or the variant's own) and the same style kit and video DNA. Captions, cuts and the voice clip all come from those inputs, so they match the
// variant's words. Copying the master's EDL and swapping the voice and the takes would keep the master's captions, which are the master's words.
//
// The result is an EDL that carries variantOf (the master EDL) and passes the same edit rules as the master, or a refusal with the checks that
// failed. Pure: no store, no call.
//
// Recorded future step: changed-lines-only (the voice re-spoken for the changed beats alone) needs a splice of the voice clips (an ordered
// audio.voice list and a spliceAudio media function, variants/STATUS.md). The full re-speak used here does not.

import { buildEdl, type EmphasisMark } from "../edit/editor.ts";
import type { RuleResult } from "../edit/rules.ts";
import type { EditDecisionList, ScenePlan, StyleKit, Take, VideoDNA, VoiceTrack } from "../contracts/index.ts";

export type AssemblyInput = {
  requestId: string;
  /** The master EDL the variant is a variant of (its variantOf). */
  masterEdlId: string;
  /** The variant's plan: the master's shots, with the references and prompts the change needs. */
  plan: ScenePlan;
  /** The voice the EDL speaks: the variant's own track, or the master's when the change keeps the voice (a product). */
  voice: VoiceTrack;
  dna: VideoDNA;
  /** The take each generated or stock shot of the plan plays. */
  takes: Take[];
  kit: StyleKit;
  /** The emphasis marks of the script (Bible 8.2 step 10), copied from the request. */
  emphasis: EmphasisMark[];
};

export type AssemblyResult =
  | { status: "built"; edlId: string; edl: EditDecisionList; checks: RuleResult[]; failingShotIds: string[] }
  | { status: "not_built"; edlId: string; reason: string; checks: RuleResult[]; failingShotIds: string[] };

/** The variant's EDL, built over its own inputs and checked by the edit rules. Pure. */
export function assembleVariantEdl(input: AssemblyInput): AssemblyResult {
  const build = buildEdl({
    requestId: input.requestId,
    plan: input.plan,
    voice: input.voice,
    grammar: input.dna.editGrammar,
    referenceDurationMs: input.dna.durationMs,
    takes: input.takes,
    kit: input.kit,
    emphasis: input.emphasis,
  });
  if (!build.pass || build.edl === null) {
    const failing = build.checks.filter((check) => !check.pass).map((check) => check.rule);
    const reason = failing.length > 0 ? `the variant's EDL did not pass the edit gate: ${failing.join(", ")}` : "the variant's EDL did not pass the edit gate";
    return { status: "not_built", edlId: build.edlId, reason, checks: build.checks, failingShotIds: build.failingShotIds };
  }
  return {
    status: "built",
    edlId: build.edlId,
    edl: { ...build.edl, variantOf: input.masterEdlId },
    checks: build.checks,
    failingShotIds: build.failingShotIds,
  };
}
