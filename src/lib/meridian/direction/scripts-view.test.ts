import assert from "node:assert/strict";
import test from "node:test";
import { STRONG_SCRIPT } from "./fixtures.ts";
import { directionNoteOf, NOTE_MESSAGE_MAX, scriptLinesOf } from "./scripts-view.ts";
import { chooseInputSchema, parseInput, reviseInputSchema, writeInputSchema } from "./input.ts";
import type { DirectedScript } from "./script.ts";

const STITCHED: DirectedScript = {
  ...STRONG_SCRIPT,
  hookFamily: "clip_stitch",
  beats: [
    { beatId: "b1", role: "hook", voice: "", onScreenText: "Which mug stays hot", picture: "The creator's mug test, as posted.", borrowed: { source: "The trend 'three mug test' from the brief", credit: "@mugtester" }, durationMs: 4000 },
    ...STRONG_SCRIPT.beats.slice(1).map((beat, index) => (index === 0 ? { ...beat, role: "setup" as const, link: undefined } : beat)),
  ],
};

test("a chosen script's lines are its spoken beats, in order, on one line each", () => {
  assert.deepEqual(
    scriptLinesOf(STRONG_SCRIPT).map((line) => line.role),
    STRONG_SCRIPT.beats.map((beat) => beat.role),
  );
  const lines = scriptLinesOf({ ...STRONG_SCRIPT, beats: [{ ...STRONG_SCRIPT.beats[0]!, voice: "Three mugs.\n  Same coffee." }, ...STRONG_SCRIPT.beats.slice(1)] });
  assert.equal(lines[0]!.text, "Three mugs. Same coffee.");
  assert.equal(scriptLinesOf(STITCHED)[0]!.role, "setup", "a beat with no voice has no line to speak");
});

test("the direction note names each beat's picture, words and sound, and a borrowed opening to attach at publishing", () => {
  const note = directionNoteOf(STITCHED, "option 1, version 2");
  assert.match(note, /^Direction for the chosen script \(option 1, version 2, direction-codex@2\)\./);
  assert.match(note, /\nb1 \(hook\): picture: The creator's mug test, as posted\.; on screen: "Which mug stays hot"; no voice\./);
  assert.match(note, /b1 opens on a borrowed clip: The trend 'three mug test' from the brief, credited on screen as "@mugtester"\. The engine does not render another creator's footage/);
  assert.match(note, /It aims for surprise, is sent for utility, and rewards a rewatch with hidden reveal\.$/);
});

test("a long note is cut whole beats at a time, within a message's limit", () => {
  const long: DirectedScript = { ...STRONG_SCRIPT, beats: Array.from({ length: 20 }, (_, index) => ({ ...STRONG_SCRIPT.beats[1]!, beatId: `b${index + 1}`, picture: "p".repeat(400) })) };
  const note = directionNoteOf(long, "option 1, version 1");
  assert.ok(note.length <= NOTE_MESSAGE_MAX);
  assert.match(note, /\(The rest of the note was cut\.\)$/);
});

test("the server functions' inputs keep only their fields and refuse in plain words", () => {
  assert.deepEqual(parseInput(writeInputSchema, { sessionId: "s1", count: 3, job: "follow", niche: null, maxSeconds: 45, language: "pt-BR", organizationId: "other" }), {
    sessionId: "s1",
    count: 3,
    job: "follow",
    niche: null,
    maxSeconds: 45,
    language: "pt-BR",
  });
  assert.throws(() => parseInput(writeInputSchema, { sessionId: "s1", count: 3, job: "follow", niche: null, maxSeconds: 45, language: "Portuguese" }), /Set the script's language as a tag/);
  assert.throws(() => parseInput(writeInputSchema, { sessionId: "s 1", count: 1, job: "reach", niche: null, maxSeconds: 30, language: "en" }), /Choose a valid draft or script/);
  assert.throws(() => parseInput(writeInputSchema, { sessionId: "s1", count: 9, job: "reach", niche: null, maxSeconds: 30, language: "en" }), /Check count/);
  assert.deepEqual(parseInput(reviseInputSchema, { sessionId: "s1", scriptId: "x" }), { sessionId: "s1", scriptId: "x", note: "" });
  assert.throws(() => parseInput(reviseInputSchema, { sessionId: "s1", scriptId: "x", note: "n".repeat(601) }), /Keep a note to 600 characters/);
  assert.throws(() => parseInput(chooseInputSchema, { sessionId: "s1" }), /Check scriptId|Choose a valid/);
});
