// What a person sees of a direction script, and what choosing it writes to the draft. Pure: no database, no provider.
//
// A chosen script reaches the engine as the draft's script lines: one line per beat with a voice, in order, each with its role, so the
// engine uses the script and skips write_script (content-factory/request.ts). A beat with no voice (a picture-only beat, a borrowed
// opening) has no line to speak; its picture, its words on screen and its sound go to one note with the rest of the direction, which
// the request carries as a change line. The engine does not render another creator's footage (Bible principle 4; contract item 4 is not
// built), so a borrowed opening is named in the note as a clip to attach at publishing, with its credit.

import { DIRECTION_CODEX_VERSION, formatArchetype, hookFamily } from "./codex.ts";
import type { Concept } from "./concepts.ts";
import { attemptShips, type ScriptAttempt } from "./pipeline.ts";
import type { DirectedScript } from "./script.ts";
import type { ScriptRole } from "../content-factory/model.ts";

/** The longest note a draft message may hold (content_factory_messages). */
export const NOTE_MESSAGE_MAX = 4000;

export type ScriptLine = { role: ScriptRole; text: string };

/** The script lines a chosen script posts: one per beat with a voice, in order. */
export function scriptLinesOf(script: DirectedScript): ScriptLine[] {
  return script.beats.flatMap((beat) => {
    const text = oneLine(beat.voice);
    return text ? [{ role: beat.role, text }] : [];
  });
}

function oneLine(text: string | undefined, max = 600): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The direction note posted with a chosen script: each beat's picture, words on screen and sound, the borrowed opening when there is
 * one, and the feeling it aims for. At most NOTE_MESSAGE_MAX characters; a long note keeps its first beats whole and says it was cut.
 */
export function directionNoteOf(script: DirectedScript, label: string): string {
  const head = `Direction for the chosen script (${label}, ${DIRECTION_CODEX_VERSION}). The script lines are the words to speak; this note is what each beat shows and sounds like.`;
  const lines: string[] = [];
  for (const beat of script.beats) {
    const parts = [
      beat.picture ? `picture: ${oneLine(beat.picture, 400)}` : "",
      beat.onScreenText ? `on screen: "${oneLine(beat.onScreenText, 160)}"` : "",
      beat.sound ? `sound: ${oneLine(beat.sound, 120)}` : "",
      beat.voice.trim() ? "" : "no voice",
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`${beat.beatId} (${beat.role}): ${parts.join("; ")}.`);
  }
  const borrowed = script.beats[0]?.borrowed;
  if (borrowed) {
    lines.push(
      `${script.beats[0]!.beatId} opens on a borrowed clip: ${oneLine(borrowed.source, 300)}, credited on screen as "${oneLine(borrowed.credit, 80)}". The engine does not render another creator's footage, so attach the clip at publishing with the platform's Stitch or Remix, credited, or by hand.`,
    );
  }
  lines.push(`It aims for ${script.feeling.replace(/_/g, " ")}, is sent for ${script.sendTrigger.replace(/_/g, " ")}, and rewards a rewatch with ${script.rewatchDevice.replace(/_/g, " ")}.`);
  let note = head;
  for (const line of lines) {
    if (note.length + 1 + line.length > NOTE_MESSAGE_MAX - 40) return `${note}\n(The rest of the note was cut.)`;
    note = `${note}\n${line}`;
  }
  return note;
}

/** A stored script as the Scripts panel and the agent tools show it. */
export type ScriptCard = {
  id: string;
  runId: string;
  parentId: string | null;
  version: number;
  rank: number | null;
  state: "option" | "chosen";
  /** The last draft passed every check, and the swipe test would ship it. */
  ships: boolean;
  /** The last draft has a blocking finding: it cannot be chosen until it is revised. */
  blocked: boolean;
  createdAt: string;
  concept: { hookFamily: string; format: string; feeling: string; angle: string; promise: string; payoff: string; novelty: string };
  topic: string | null;
  language: string;
  durationMs: number;
  beats: Array<{
    beatId: string;
    role: string;
    voice: string;
    onScreenText: string | null;
    picture: string | null;
    sound: string | null;
    borrowed: { source: string; credit: string } | null;
    startMs: number;
    endMs: number;
  }>;
  rationale: string;
  findings: Array<{ severity: "block" | "warn"; message: string; beatId: string | null }>;
  counts: { block: number; warn: number; info: number };
  floors: { trust: string; originality: string };
  swipe: { verdict: string; blocker: string; leanIn: number | null; risky: Array<{ beatId: string; fromMs: number; reason: string }>; fixes: string[] } | null;
  /** How many drafts this version took: 1 when the first draft held. */
  drafts: number;
};

/** The findings a card lists: blocks first, then warnings, at most this many. */
export const CARD_FINDINGS = 12;

export function scriptCard(input: {
  id: string;
  runId: string;
  parentId: string | null;
  version: number;
  rank: number | null;
  state: string;
  createdAt: string;
  concept: Concept;
  attempts: ScriptAttempt[];
}): ScriptCard | null {
  const last = input.attempts.at(-1);
  if (!last) return null;
  const { script, report, swipe } = last;
  const timeline = new Map(report.timeline.map((beat) => [beat.beatId, beat]));
  return {
    id: input.id,
    runId: input.runId,
    parentId: input.parentId,
    version: input.version,
    rank: input.rank,
    state: input.state === "chosen" ? "chosen" : "option",
    ships: attemptShips(last),
    blocked: report.blocked,
    createdAt: input.createdAt,
    concept: {
      hookFamily: hookFamily(input.concept.hookFamily).name,
      format: formatArchetype(input.concept.format).name,
      feeling: input.concept.feeling.replace(/_/g, " "),
      angle: input.concept.angle,
      promise: input.concept.promise,
      payoff: input.concept.payoff,
      novelty: input.concept.novelty,
    },
    topic: script.topic ?? null,
    language: script.language,
    durationMs: report.metrics.durationMs,
    beats: script.beats.map((beat) => ({
      beatId: beat.beatId,
      role: beat.role,
      voice: beat.voice,
      onScreenText: beat.onScreenText ?? null,
      picture: beat.picture ?? null,
      sound: beat.sound ?? null,
      borrowed: beat.borrowed ?? null,
      startMs: timeline.get(beat.beatId)?.startMs ?? 0,
      endMs: timeline.get(beat.beatId)?.endMs ?? 0,
    })),
    rationale: script.rationale,
    findings: report.findings
      .filter((finding): finding is typeof finding & { severity: "block" | "warn" } => finding.severity !== "info")
      .slice(0, CARD_FINDINGS)
      .map((finding) => ({ severity: finding.severity, message: finding.message, beatId: finding.beatId ?? null })),
    counts: report.counts,
    floors: report.floors,
    swipe: swipe
      ? {
          verdict: swipe.verdict,
          blocker: swipe.blocker,
          leanIn: last.leanIn,
          risky: swipe.windows.filter((window) => window.risk === "high").map((window) => ({ beatId: window.beatId, fromMs: window.fromMs, reason: window.reason })),
          fixes: swipe.fixes,
        }
      : null,
    drafts: input.attempts.length,
  };
}
