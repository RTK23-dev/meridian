// The direction layer: the film contract, the direction check, the prompt compiler, the crew's faithfulness and the take check, on the
// recorded microwave film (fixtures/) and on films broken one rule at a time.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pixelBuildSchema, type PixelBuild } from "../compose/pixel/stage.ts";
import { directionFindings, directionPasses, numbersIn, readingMs } from "./check.ts";
import { colourName, compileShotPrompt, describedPrompt, sfxCues } from "./compile.ts";
import { actorAt, faithFindings, faithPasses } from "./faithful.ts";
import { directedFilmSchema, type DirectedFilm } from "./film.ts";
import { onCadence, phrase } from "./motion-vocab.ts";
import { takeFindings } from "./take-check.ts";

const film: DirectedFilm = directedFilmSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/microwave.film.json", import.meta.url), "utf8")));
const build: PixelBuild = pixelBuildSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/microwave.build.json", import.meta.url), "utf8")));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rules = (findings: Array<{ rule: string; severity: string }>, severity: string) => findings.filter((f) => f.severity === severity).map((f) => f.rule);

describe("the directed film contract", () => {
  it("parses the recorded film and refuses a shot with no avoid list, a third card line or an unknown moment", () => {
    assert.equal(film.shots.length, 7);
    const noAvoid = clone(film);
    noAvoid.shots[0]!.avoid = [];
    assert.equal(directedFilmSchema.safeParse(noAvoid).success, false);
    const threeLines = clone(film) as { cards: Array<{ lines: string[] }> };
    threeLines.cards[0]!.lines = ["ONE", "TWO", "THREE"];
    assert.equal(directedFilmSchema.safeParse(threeLines).success, false);
    const vague = clone(film) as { shots: Array<{ oneMoment: { kind: string } }> };
    vague.shots[0]!.oneMoment.kind = "vibes";
    assert.equal(directedFilmSchema.safeParse(vague).success, false);
  });
});

describe("the direction check", () => {
  it("passes the recorded film, with only the two moments that no card marks left as warnings", () => {
    const findings = directionFindings(film);
    assert.ok(directionPasses(film));
    assert.deepEqual(rules(findings, "block"), []);
    assert.deepEqual(rules(findings, "warn"), ["moment_unsynced", "moment_unsynced"]);
  });

  it("blocks a late answer, a moment outside its shot, and an arc that does not contain the moment", () => {
    const late = clone(film);
    late.shots[0]!.oneMoment.hitAtMs = 3500;
    late.shots[0]!.motionArc = { anticipationMs: [2500, 3500], releaseMs: [3500, 3900], settleMs: [3900, 4500] };
    assert.ok(rules(directionFindings(late), "block").includes("answer_late"));
    const outside = clone(film);
    outside.shots[1]!.oneMoment.hitAtMs = 5000;
    assert.ok(rules(directionFindings(outside), "block").includes("moment_inside"));
    const arc = clone(film);
    arc.shots[2]!.motionArc.releaseMs = [3000, 3400];
    assert.ok(rules(directionFindings(arc), "block").includes("arc_order"));
  });

  it("blocks words over the subject and an eye target in the band kept for the words (L7)", () => {
    const over = clone(film);
    over.cards[0]!.band = "bottom";
    assert.ok(rules(directionFindings(over), "block").includes("card_over_subject"));
    const eye = clone(film);
    eye.shots[3]!.composition.eyeTarget = { x: 0.5, y: 0.2 };
    assert.ok(rules(directionFindings(eye), "block").includes("eye_in_word_band"));
  });

  it("blocks a number with no sourced claim and a claim with no source (L23), but not a count's starting zero", () => {
    const unsourced = clone(film);
    unsourced.claims[0]!.source = null;
    assert.ok(rules(directionFindings(unsourced), "block").includes("claim_without_source"));
    const invented = clone(film);
    invented.cards[6]!.lines = ["3.7 BILLION", "TIMES A SECOND"];
    const blocked = directionFindings(invented).filter((f) => f.rule === "number_without_claim");
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]!.message, /^3\.7 /);
    assert.ok(!directionFindings(film).some((f) => f.rule === "number_without_claim"), "the readout counts from 0, which is not a claim");
    assert.deepEqual(numbersIn("2,450,000,000 and 2.45 and 1,000."), ["2450000000", "2.45", "1000"]);
  });

  it("blocks a looping film whose last shot does not return to frame 0, and a card-clocked film with no words at 0", () => {
    const open = clone(film);
    open.shots[6]!.loop = "none";
    assert.ok(rules(directionFindings(open), "block").includes("loop_not_closed"));
    const silentStart = clone(film);
    silentStart.cards[0]!.atMs = 400;
    assert.ok(rules(directionFindings(silentStart), "block").includes("no_words_at_start"));
  });

  it("warns on a card too short to read, but not on the hook card coming back as the loop's seam", () => {
    assert.equal(readingMs(5), 2100);
    const quick = clone(film);
    quick.cards[1]!.untilMs = 3000;
    quick.cards[2]!.atMs = 3000;
    assert.ok(directionFindings(quick).some((f) => f.rule === "reading_time" && f.at === "card 1"));
    assert.ok(!directionFindings(film).some((f) => f.rule === "reading_time"), "the 500 ms return of the hook card is the seam");
  });

  it("warns on a silent moment and on an avoid list that only repeats the global one", () => {
    const silent = clone(film);
    silent.shots[2]!.sound.hitSfx = "none";
    silent.shots[2]!.avoid = ["muddy or blurred edges"];
    const warns = rules(directionFindings(silent), "warn");
    assert.ok(warns.includes("moment_silent"));
    assert.ok(warns.includes("avoid_generic"));
  });
});

describe("the compiler", () => {
  it("compiles a provider prompt from the direction: the arc in time order, the camera, the empty band, the loop, and no lettering", () => {
    const compiled = compileShotPrompt(film, film.shots[6]!, "kling");
    assert.match(compiled.prompt, /pixel art with ordered dithering/);
    assert.match(compiled.prompt, /at the 1\.5 second mark the beep: the microwave pops and the bowl hops/);
    assert.match(compiled.prompt, /the top third stays empty/);
    assert.match(compiled.prompt, /perfect seamless loop/);
    assert.match(compiled.prompt, /No text in frame\.$/);
    assert.equal(compiled.tested, false, "no live run has tested the phrasing");
    for (const negative of ["a fade to black", "watermark", "muddy or blurred edges"]) assert.ok(compiled.negativePrompt.includes(negative));
    assert.ok(compiled.prompt.indexOf("pulls back") < compiled.prompt.indexOf("1.5 second") || compiled.prompt.includes("winds up") || compiled.prompt.includes("compresses"));
  });

  it("phrases each provider family its own way, and the described control is one line", () => {
    const values = { subject: "the bowl", what: "it pops", at: 2.5 };
    assert.notEqual(phrase("release", "kling", values).text, phrase("release", "wan", values).text);
    assert.equal(phrase("release", "generic", values).text, "then at 2.5 seconds it pops, fast and decisive");
    assert.match(describedPrompt(film.shots[0]!), /^An animated a soup bowl/);
  });

  it("names colours in words a model follows", () => {
    assert.equal(colourName("#12163C"), "deep blue");
    assert.equal(colourName("#3B164F"), "deep purple");
    assert.equal(colourName("#F4CE44"), "neon yellow");
    assert.equal(colourName("#FFFFFF"), "white");
  });

  it("places a hit sound on every moment, a blip on each card, readable ticks on the readout and a chime on the call to action", () => {
    const cues = sfxCues(film);
    const moments = cues.filter((cue) => cue.from === "moment");
    assert.deepEqual(moments.map((cue) => cue.atMs), [2500, 6000, 9000, 14500, 21000, 26000, 30000]);
    assert.deepEqual(moments.map((cue) => cue.kind), ["zap", "whoosh", "click", "boom", "pop", "whoosh", "beep"]);
    const ticks = cues.filter((cue) => cue.from === "tick");
    assert.ok(ticks.length > 10 && ticks.every((tick, i) => i === 0 || tick.atMs - ticks[i - 1]!.atMs >= 89));
    assert.ok(!cues.some((cue) => cue.from !== "moment" && moments.some((m) => Math.abs(m.atMs - cue.atMs) < 60)), "a cue on a hit gives way to the hit");
    assert.ok(cues.some((cue) => cue.from === "cta" && cue.atMs === 28500));
  });

  it("holds a time to the cadence: on twos at 30 fps a drawing lasts two frames", () => {
    assert.equal(onCadence(1 / 30, 30, 2), 0);
    assert.equal(onCadence(2 / 30, 30, 2), 2 / 30);
    assert.equal(onCadence(0.5, 30, 1), 0.5);
  });
});

describe("the crew's faithfulness", () => {
  it("passes the recorded build: every moment is built, the subjects are on target, the loop closes", () => {
    assert.ok(faithPasses(film, build));
    assert.deepEqual(rules(faithFindings(film, build), "block"), []);
  });

  it("blocks a moment the stage does not build, a missing subject and an open loop seam", () => {
    const idle = clone(build);
    idle.stages[0]!.actors.forEach((actor) => (actor.actions = []));
    idle.stages[0]!.fx = [];
    assert.ok(rules(faithFindings(film, idle), "block").includes("moment_not_built"));
    const nobody = clone(build);
    nobody.stages[2]!.subjectId = "nobody";
    assert.ok(rules(faithFindings(film, nobody), "block").includes("subject_missing"));
    const open = clone(build);
    open.stages[6]!.camera.to.zoom = 2;
    assert.ok(rules(faithFindings(film, open), "block").includes("loop_seam_open"));
  });

  it("blocks a subject moved into the band kept for the words", () => {
    const high = clone(build);
    const bowl = high.stages[0]!.actors.find((actor) => actor.id === "bowl")!;
    bowl.y = -60;
    assert.ok(rules(faithFindings(film, high), "block").includes("subject_in_word_band"));
  });

  it("places an actor along its moves", () => {
    const actor = { id: "a", shape: "circle" as const, x: 0, y: 0, w: 10, h: 10, colour: "#FFFFFF", actions: [{ do: "move" as const, atMs: 100, durMs: 100, to: { x: 50 } }] };
    assert.equal(actorAt(actor, 50).x, 0);
    assert.equal(actorAt(actor, 150).x, 25);
    assert.equal(actorAt(actor, 400).x, 50);
  });
});

describe("the take check", () => {
  const fps = 30;
  const frames = Math.round((film.durationMs / 1000) * fps);
  const flat = () => Array.from({ length: frames - 1 }, () => 0.004);
  const withMoments = () => {
    const motion = flat();
    for (const shot of film.shots) motion[Math.round(((shot.startMs + shot.oneMoment.hitAtMs) / 1000) * fps)] = 0.03;
    return motion;
  };

  it("passes a take whose every moment is a visible change and whose ends meet", () => {
    assert.deepEqual(takeFindings(film, { fps, motion: withMoments(), firstLastDistance: 0.002 }), []);
  });

  it("blocks a moment with no visible change, and an open loop", () => {
    const motion = withMoments();
    motion[Math.round(9 * fps)] = 0.004;
    const findings = takeFindings(film, { fps, motion, firstLastDistance: 0.09 });
    assert.deepEqual(findings.map((f) => `${f.rule}:${f.at}`), ["moment_invisible:s3", "loop_open:film"]);
  });

  it("blocks an avoided item a frame reader saw, and a palette that drifted from the reference frame", () => {
    const findings = takeFindings(film, {
      fps,
      motion: withMoments(),
      paletteDistance: [{ shotId: "s4", distance: 0.4 }],
      avoidSeen: [{ shotId: "s3", item: "ball-and-stick chemistry models" }],
    });
    assert.deepEqual(findings.map((f) => f.rule), ["look_drift", "avoid_seen"]);
  });

  it("warns on a subject that wanders in a locked shot", () => {
    const s4 = film.shots[3]!;
    const track = Array.from({ length: 10 }, (_, i) => ({ ms: s4.startMs + i * 500, x: i % 2 === 0 ? 0.2 : 0.8, y: 0.6 }));
    const findings = takeFindings(film, { fps, motion: withMoments(), subjectTrack: track });
    assert.deepEqual(findings.map((f) => `${f.rule}:${f.at}`), ["subject_drift:s4"]);
  });
});
