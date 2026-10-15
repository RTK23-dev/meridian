// The timeline pieces the editor cuts (Bible 8.2 steps 2 to 5): place each shot in its beat, snap the cuts, merge short shots,
// split long ones, and cut the hook at its scaled time. A piece is one shot's span, or a part of a shot split with a punch-in.
// Every operation keeps each media piece inside what its take can show (the source must cover the clip). Pure.

import { EngineError, type BeatSpan, type ScenePlan, type ShotSpec, type Take, type VisualType } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { snapCut, type Range, type SnapContext } from "./words.ts";

export type MediaSource = { uri: string; srcInMs: number; takeDurationMs: number };
export type ComponentSource = { name: string; props: Record<string, unknown> };

export type Piece = {
  shotId: string;
  visualType: VisualType;
  layer: "base" | "cutaway" | "presenter" | "graphics";
  /** Presenter shots: on the presenter layer or of the ugc_presenter type. They are exempt from the 6 s maximum (Bible 8.3). */
  presenter: boolean;
  startMs: number;
  endMs: number;
  media: MediaSource | null;
  component: ComponentSource | null;
  /** True when this piece begins with a punch-in because a shot was split there. */
  splitStart: boolean;
};

export const MIN_SHOT_MS = thresholds.edit.shotLengthMinMs;
export const MAX_SHOT_MS = thresholds.edit.shotLengthMaxMs;

/** A shot's source for the timeline. Generated and stock shots need their chosen take; a component draws itself. */
export function sourceOf(shot: ShotSpec, take: Take | undefined): { media: MediaSource | null; component: ComponentSource | null } {
  if (shot.source.kind === "component") {
    return { media: null, component: { name: shot.source.component, props: { ...shot.source.props } } };
  }
  if (take === undefined) throw new EngineError("internal", `shot ${shot.shotId} has no take`, { stage: "edit" });
  return { media: { uri: take.uri, srcInMs: 0, takeDurationMs: take.durationMs }, component: null };
}

/** Each shot sits in its beat. Several shots in one beat share its span in plan order, by their planned lengths (Bible 8.2 step 2). */
export function placeShots(
  plan: ScenePlan,
  beats: readonly BeatSpan[],
  takes: ReadonlyMap<string, Take>,
): Piece[] {
  const pieces: Piece[] = [];
  for (const beat of beats) {
    const shots = plan.shots.filter((shot) => shot.beatId === beat.beatId);
    if (shots.length === 0) continue;
    const span = beat.endMs - beat.startMs;
    const weights = shots.map((shot) => shot.endMs - shot.startMs);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let running = 0;
    shots.forEach((shot, index) => {
      const startMs = index === 0 ? beat.startMs : beat.startMs + Math.round((span * running) / total);
      running += weights[index] ?? 0;
      const endMs = index === shots.length - 1 ? beat.endMs : beat.startMs + Math.round((span * running) / total);
      const source = sourceOf(shot, takes.get(shot.shotId));
      pieces.push({
        shotId: shot.shotId,
        visualType: shot.visualType,
        layer: shot.layer,
        presenter: shot.layer === "presenter" || shot.visualType === "ugc_presenter",
        startMs,
        endMs,
        media: source.media,
        component: source.component,
        splitStart: false,
      });
    });
  }
  return pieces;
}

/** The window a cut between two pieces may move in: each media piece can show only what its take holds. */
export function boundaryRange(previous: Piece, next: Piece): Range {
  let lo = previous.startMs + 1;
  let hi = next.endMs - 1;
  if (previous.media !== null) {
    hi = Math.min(hi, previous.startMs + (previous.media.takeDurationMs - previous.media.srcInMs));
  }
  if (next.media !== null) {
    lo = Math.max(lo, next.endMs - (next.media.takeDurationMs - next.media.srcInMs));
  }
  return { lo, hi };
}

/** Moves every cut between pieces to its snapped place (Bible 8.2 step 3), inside the window each take allows. */
export function snapBoundaries(pieces: Piece[], snap: SnapContext): void {
  for (let index = 1; index < pieces.length; index += 1) {
    const previous = pieces[index - 1];
    const next = pieces[index];
    if (previous === undefined || next === undefined) continue;
    const range = boundaryRange(previous, next);
    if (range.lo > range.hi) continue;
    const cut = snapCut(next.startMs, range, snap);
    previous.endMs = cut;
    next.startMs = cut;
  }
}

function canExtendEnd(piece: Piece, newEnd: number): boolean {
  return piece.media === null || piece.media.srcInMs + (newEnd - piece.startMs) <= piece.media.takeDurationMs;
}

function canExtendStart(piece: Piece, newStart: number): boolean {
  return piece.media === null || piece.media.srcInMs - (piece.startMs - newStart) >= 0;
}

/**
 * Merges short pieces into a neighbour of the same type (Bible 8.2 step 4). A piece shorter than 0.5 x its target, and than the
 * 0.4 s minimum, goes into the previous piece if that can show the extra footage, else the next one. A piece with no same-type
 * neighbour that can take it stays, and the rule that follows reports it.
 */
export function mergeShortPieces(pieces: readonly Piece[], targetAt: (midMs: number) => number, notes: string[]): Piece[] {
  const out = pieces.map((piece) => ({ ...piece }));
  let merged = 0;
  let index = 0;
  while (index < out.length) {
    const piece = out[index];
    if (piece === undefined) break;
    const length = piece.endMs - piece.startMs;
    const target = targetAt((piece.startMs + piece.endMs) / 2);
    const floor = Math.max(MIN_SHOT_MS, thresholds.editor.fit.shortShare * target);
    if (length >= floor) {
      index += 1;
      continue;
    }
    const previous = out[index - 1];
    const next = out[index + 1];
    if (previous !== undefined && previous.visualType === piece.visualType && canExtendEnd(previous, piece.endMs)) {
      previous.endMs = piece.endMs;
      out.splice(index, 1);
      merged += 1;
      continue;
    }
    if (next !== undefined && next.visualType === piece.visualType && canExtendStart(next, piece.startMs)) {
      if (next.media !== null) next.media = { ...next.media, srcInMs: next.media.srcInMs - length };
      next.startMs = piece.startMs;
      out.splice(index, 1);
      merged += 1;
      continue;
    }
    index += 1;
  }
  if (merged > 0) notes.push(`merged ${merged} short shot${merged === 1 ? "" : "s"} into a neighbour of the same type`);
  return out;
}

/**
 * Cuts the first piece at the scaled hook time (Bible 8.2 step 5). The cut is a split with a punch-in, so the beats keep their
 * places. It only moves the first cut earlier. A component cannot be split, and then the cut stays where the plan put it.
 */
export function splitHook(pieces: readonly Piece[], hookTargetMs: number, snap: SnapContext, notes: string[]): Piece[] {
  const first = pieces[0];
  if (first === undefined) return [];
  if (hookTargetMs >= first.endMs) {
    notes.push(`hook first cut stays at ${first.endMs} ms: the target ${hookTargetMs} ms is not before it`);
    return [...pieces];
  }
  if (first.media === null) {
    notes.push(`hook first cut stays at ${first.endMs} ms: the first shot is a component, which cannot be split`);
    return [...pieces];
  }
  const cut = snapCut(hookTargetMs, { lo: first.startMs + MIN_SHOT_MS, hi: first.endMs - MIN_SHOT_MS }, snap);
  if (cut - first.startMs < MIN_SHOT_MS || first.endMs - cut < MIN_SHOT_MS) {
    notes.push(`hook first cut stays at ${first.endMs} ms: no cut near ${hookTargetMs} ms leaves two shots of at least ${MIN_SHOT_MS} ms`);
    return [...pieces];
  }
  const [head, tail] = splitPiece(first, [cut]);
  if (head === undefined || tail === undefined) return [...pieces];
  notes.push(`hook first cut placed at ${cut} ms (target ${hookTargetMs} ms)`);
  return [head, tail, ...pieces.slice(1)];
}

/** Parts of a piece cut at the given times (each strictly inside the piece). A part after a cut begins with a punch-in. */
function splitPiece(piece: Piece, cuts: readonly number[]): Piece[] {
  if (piece.media === null) return [piece];
  const bounds = [piece.startMs, ...cuts, piece.endMs];
  const parts: Piece[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const startMs = bounds[index] as number;
    const endMs = bounds[index + 1] as number;
    const media = piece.media;
    parts.push({
      ...piece,
      startMs,
      endMs,
      media: { ...media, srcInMs: media.srcInMs + (startMs - piece.startMs) },
      splitStart: index === 0 ? piece.splitStart : true,
    });
  }
  return parts;
}

/** How many parts a piece should split into, or 1 when it should not split (Bible 8.2 step 4). */
function partCount(piece: Piece, targetMs: number): number {
  const length = piece.endMs - piece.startMs;
  let count = 1;
  if (length > thresholds.editor.fit.longShare * targetMs) count = Math.max(2, Math.round(length / targetMs));
  if (!piece.presenter && length > MAX_SHOT_MS) count = Math.max(count, Math.ceil(length / MAX_SHOT_MS));
  return Math.min(count, Math.floor(length / MIN_SHOT_MS));
}

/**
 * Splits pieces that are longer than 1.5 x their target, and any non-presenter media piece over 6 s, into equal parts with a
 * punch-in at each cut (Bible 8.2 step 4). Components are not split: a card would restart its animation. A component that is
 * still too long stays, and the shot-length rule reports it.
 */
export function splitLongPieces(
  pieces: readonly Piece[],
  targetAt: (midMs: number) => number,
  snap: SnapContext,
  notes: string[],
): Piece[] {
  const out: Piece[] = [];
  let splits = 0;
  for (const piece of pieces) {
    const length = piece.endMs - piece.startMs;
    const target = targetAt((piece.startMs + piece.endMs) / 2);
    const needs = length > thresholds.editor.fit.longShare * target || (!piece.presenter && length > MAX_SHOT_MS);
    if (!needs) {
      out.push(piece);
      continue;
    }
    if (piece.media === null) {
      notes.push(`shot ${piece.shotId} is a component of ${length} ms, over its fit; components are not split`);
      out.push(piece);
      continue;
    }
    const parts = cutsForParts(piece, partCount(piece, target), snap);
    if (parts === null) {
      out.push(piece);
      continue;
    }
    splits += 1;
    out.push(...splitPiece(piece, parts));
  }
  if (splits > 0) notes.push(`split ${splits} long shot${splits === 1 ? "" : "s"} with a punch-in at each cut`);
  return out;
}

/** The snapped cut times for splitting a piece into the given number of parts, or null when no split fits the minimum length. */
function cutsForParts(piece: Piece, count: number, snap: SnapContext): number[] | null {
  const length = piece.endMs - piece.startMs;
  for (let parts = count; parts >= 2; parts -= 1) {
    const cuts: number[] = [];
    let previous = piece.startMs;
    let ok = true;
    for (let k = 1; k < parts; k += 1) {
      const raw = piece.startMs + Math.round((length * k) / parts);
      const lo = previous + MIN_SHOT_MS;
      const hi = piece.endMs - MIN_SHOT_MS * (parts - k);
      if (lo > hi) {
        ok = false;
        break;
      }
      const cut = snapCut(raw, { lo, hi }, snap);
      cuts.push(cut);
      previous = cut;
    }
    if (ok) return cuts;
  }
  return null;
}
