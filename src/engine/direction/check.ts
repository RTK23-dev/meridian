// The direction check: the Director's film is scored against the seven parts of direction before anything is spent (L2: the
// director_check becomes a real direction check). It reads the film only, so it runs in tests, in agent mode and before a paid call.
//
//   block: the film cannot be built as directed (a shot with no moment inside it, words over the subject, a number with no source).
//   warn:  the film can be built but reads as described rather than directed (a card held too short to read, a moment with no sound).
//
// Each rule names its lesson: L1 to L13 are MERIDIAN_DIRECTION_LESSONS.md; L14 to L23 come from the 14-reel study of the 8-bit
// science explainers (docs/engine/STYLE_PRESET_PIXEL_EXPLAINER.md, section 2).

import { GLOBAL_AVOID, type Band, type Card, type DirectedFilm, type ShotDirection } from "./film.ts";

export type DirectionRule =
  | "shots_tile"
  | "moment_inside"
  | "arc_order"
  | "reference_shot"
  | "eye_in_word_band"
  | "card_over_subject"
  | "line_without_picture"
  | "number_without_claim"
  | "claim_without_source"
  | "answer_late"
  | "no_words_at_start"
  | "loop_not_closed"
  | "cta_outside"
  | "reading_time"
  | "word_rate"
  | "moment_unsynced"
  | "moment_silent"
  | "shot_long"
  | "no_rehook"
  | "no_equation_card"
  | "avoid_generic"
  | "cta_early";

export type DirectionFinding = {
  rule: DirectionRule;
  severity: "block" | "warn";
  lesson: string;
  /** A shot id, "card 3", "hud id" or "film". */
  at: string;
  message: string;
};

export type DirectionCheckOptions = {
  /** The latest the hook shot's one moment may land, from the film's start (L14). Default 3000 ms. */
  answerByMs?: number;
  /** How close a moment must be to a card change to count as in sync (L4). Default 200 ms. */
  syncToleranceMs?: number;
  /** Start times of spoken words, when the clock is the voice (L4: the hit lands on a word). */
  wordStartsMs?: number[];
  /** Require an "X = Y" or "X: Y" card (L19). Default true for card-clocked films. */
  requireEquationCard?: boolean;
};

/** The vertical span of a band, as fractions of the frame's height. */
export const BAND_SPANS: Record<Band, [number, number]> = { top: [0, 0.34], centre: [0.33, 0.67], bottom: [0.66, 1] };

const NUMBER = /\d[\d,.]*/g;

/** The numbers in a text, normalised (2,450 and 2450 are the same number; a trailing dot is punctuation). */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((raw) => raw.replace(/,/g, "").replace(/\.$/, ""));
}

export function cardWords(card: Card): number {
  return card.lines.join(" ").split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

/** How long a card needs on screen to be read: 0.6 s plus 0.3 s a word (about 2.2 words a second over a 5-word card). */
export function readingMs(words: number): number {
  return 600 + 300 * words;
}

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < b.to && b.from < a.to;
}

function absMoment(shot: ShotDirection): number {
  return shot.startMs + shot.oneMoment.hitAtMs;
}

/** Every finding for one film, in the order: film, shots, cards, numbers. */
export function directionFindings(film: DirectedFilm, options: DirectionCheckOptions = {}): DirectionFinding[] {
  const out: DirectionFinding[] = [];
  const add = (rule: DirectionRule, severity: "block" | "warn", lesson: string, at: string, message: string) =>
    out.push({ rule, severity, lesson, at, message });
  const answerBy = options.answerByMs ?? 3000;
  const tolerance = options.syncToleranceMs ?? 200;
  const shots = film.shots;

  // The shots cover the film end to end, in order, with no gap and no overlap.
  let cursor = 0;
  for (const shot of shots) {
    if (shot.startMs !== cursor) add("shots_tile", "block", "L1", shot.shotId, `starts at ${shot.startMs} ms, not at ${cursor} ms`);
    cursor = shot.endMs;
  }
  if (cursor !== film.durationMs) add("shots_tile", "block", "L1", "film", `the shots end at ${cursor} ms, the film at ${film.durationMs} ms`);

  if (!shots.some((shot) => shot.shotId === film.look.referenceShotId)) {
    add("reference_shot", "block", "L6", "film", `the look's reference shot "${film.look.referenceShotId}" is not a shot of this film`);
  }

  for (const shot of shots) {
    const length = shot.endMs - shot.startMs;
    const hit = shot.oneMoment.hitAtMs;
    if (hit <= 0 || hit >= length) {
      add("moment_inside", "block", "L4", shot.shotId, `the one moment at ${hit} ms is not inside the shot (0 to ${length} ms)`);
    }
    const { anticipationMs: a, releaseMs: r, settleMs: s } = shot.motionArc;
    const arcProblems: string[] = [];
    if (a[1] > r[0]) arcProblems.push("the anticipation runs into the release");
    if (!(r[0] <= hit && hit <= r[1])) arcProblems.push("the release does not contain the moment");
    if (s[0] < r[0]) arcProblems.push("the settle starts before the release");
    if (s[1] > length || r[1] > length || a[1] > length) arcProblems.push("the arc runs past the shot's end");
    if (arcProblems.length > 0) add("arc_order", "block", "L1 03", shot.shotId, arcProblems.join("; "));

    const [bandTop, bandBottom] = BAND_SPANS[shot.composition.emptyBand];
    const eyeY = shot.composition.eyeTarget.y;
    if (eyeY >= bandTop && eyeY <= bandBottom) {
      add("eye_in_word_band", "block", "L7", shot.shotId, `the eye target (y ${eyeY}) sits in the band kept empty for the words (${shot.composition.emptyBand})`);
    }
    if (shot.sound.hitSfx === "none") add("moment_silent", "warn", "L11", shot.shotId, "the one moment has no sound");
    if (length > 10000) add("shot_long", "warn", "L4", shot.shotId, `${(length / 1000).toFixed(1)} s on one moment: split it or give it a second event`);
    const specific = shot.avoid.filter((item) => !GLOBAL_AVOID.includes(item));
    if (specific.length === 0) add("avoid_generic", "warn", "L9", shot.shotId, "the avoid list repeats the global list only: name what this shot must not show");
  }

  // The hook: words on screen at once when the cards are the clock (L15), and the answer by 3 s (L14).
  const first = shots[0];
  if (first !== undefined && absMoment(first) > answerBy) {
    add("answer_late", "block", "L14", first.shotId, `the hook's moment lands at ${absMoment(first)} ms; the answer or flip must land by ${answerBy} ms`);
  }
  const lineCards = film.cards.map((card, index) => ({ card, index })).filter(({ card }) => card.kind === "line");
  if (film.clock === "cards" && !lineCards.some(({ card }) => card.atMs <= 100)) {
    add("no_words_at_start", "block", "L15", "film", "a card-clocked film shows its first line at frame 0");
  }

  // Cards: never over the subject (L7), always with a picture (L10), long enough to read (L15).
  let words = 0;
  for (const { card, index } of lineCards) {
    const span = { from: card.atMs, to: card.untilMs };
    const under = shots.filter((shot) => overlaps(span, { from: shot.startMs, to: shot.endMs }));
    for (const shot of under) {
      if (card.band !== shot.composition.emptyBand) {
        add("card_over_subject", "block", "L7", `card ${index}`, `the card sits in the ${card.band} band; ${shot.shotId} keeps the ${shot.composition.emptyBand} band empty`);
      }
    }
    if (!under.some((shot) => shot.line !== null)) {
      add("line_without_picture", "block", "L10", `card ${index}`, `"${card.lines.join(" ")}" has no shot that directs a picture for a line`);
    }
    const count = cardWords(card);
    words += count;
    // The hook card coming back in the last second is the loop's seam, not a new line to read.
    const first = lineCards[0]?.card;
    const loopReturn = index !== lineCards[0]?.index && card.untilMs === film.durationMs && first !== undefined && first.lines.join(" ") === card.lines.join(" ");
    if (!loopReturn && card.untilMs - card.atMs < readingMs(count)) {
      add("reading_time", "warn", "L15", `card ${index}`, `${count} words held ${card.untilMs - card.atMs} ms; reading needs about ${readingMs(count)} ms`);
    }
  }
  const rate = words / (film.durationMs / 1000);
  if (rate > 3) add("word_rate", "warn", "L15", "film", `${rate.toFixed(1)} on-screen words a second; the study's range is 1.3 to 2.9`);

  // The moment lands with a change the viewer reads: a new card or a number (L4).
  const changes = [...film.cards.map((card) => card.atMs), ...film.hud.map((hud) => hud.fromMs), ...film.hud.map((hud) => hud.untilMs)];
  for (const shot of shots) {
    const at = absMoment(shot);
    const synced = changes.some((change) => Math.abs(change - at) <= tolerance);
    const onWord = options.wordStartsMs?.some((word) => Math.abs(word - at) <= tolerance) ?? false;
    if (!synced && !onWord && shot.oneMoment.kind !== "count") {
      add("moment_unsynced", "warn", "L4", shot.shotId, `nothing the viewer reads changes within ${tolerance} ms of the moment at ${at} ms`);
    }
  }

  // A re-hook between 4 and 7 s: a new shot, a new card or a number starting (L14, study section 1).
  const rehook = shots.some((shot) => shot.startMs >= 4000 && shot.startMs <= 7000) || changes.some((change) => change >= 4000 && change <= 7000);
  if (film.durationMs > 12000 && !rehook) add("no_rehook", "warn", "L14", "film", "nothing changes between 4 and 7 s");

  if ((options.requireEquationCard ?? film.clock === "cards") && !lineCards.some(({ card }) => /[=:]/.test(card.lines.join(" ")))) {
    add("no_equation_card", "warn", "L19", "film", 'no "X = Y" or "X: Y" card');
  }

  // Numbers: every number a viewer reads belongs to a claim with a source (L20, L23).
  const claimNumbers = new Set(film.claims.flatMap((claim) => numbersIn(claim.text)));
  for (const [index, claim] of film.claims.entries()) {
    if (claim.source === null) add("claim_without_source", "block", "L23", `claim ${index}`, `"${claim.text}" has no source`);
  }
  film.cards.forEach((card, index) => {
    if (card.kind === "bubble") return;
    for (const number of numbersIn(card.lines.join(" "))) {
      if (!claimNumbers.has(number)) add("number_without_claim", "block", "L23", `card ${index}`, `${number} is on screen but in no sourced claim`);
    }
  });
  for (const hud of film.hud) {
    if (hud.kind === "timer" || hud.kind === "countdown") continue; // the viewer's own clock, not a claim
    // A count from zero is animation; the number it lands on (and a start other than zero) is a claim.
    for (const value of hud.from === 0 ? [hud.to] : [hud.from, hud.to]) {
      if (!claimNumbers.has(String(value))) add("number_without_claim", "block", "L23", hud.id, `the readout's ${value} is in no sourced claim`);
    }
  }

  // The end: a seamless film ends on a seamless shot (L8, L22), and the call to action sits late in the film.
  const last = shots[shots.length - 1];
  if (film.loop === "seamless" && last !== undefined && last.loop !== "seamless") {
    add("loop_not_closed", "block", "L22", last.shotId, "the film loops seamlessly, so its last shot must be directed to land on frame 0");
  }
  if (film.cta?.atMs != null) {
    if (film.cta.atMs >= film.durationMs) add("cta_outside", "block", "L13", "film", "the call to action starts after the film ends");
    else if (film.cta.atMs < film.durationMs * 0.6) add("cta_early", "warn", "L13", "film", "the call to action comes before the payoff");
  }
  return out;
}

/** True when nothing blocks. */
export function directionPasses(film: DirectedFilm, options?: DirectionCheckOptions): boolean {
  return directionFindings(film, options).every((finding) => finding.severity !== "block");
}
