import assert from "node:assert/strict";
import test from "node:test";
import { MAX_REPRESENTATIVE_FRAMES, selectRepresentativeFrames, type FrameCandidate } from "./frames.ts";

// Distinct bytes per frame, so no two fixtures are duplicates unless a test makes them so.
const bytesFor = (label: string) => new TextEncoder().encode(`frame:${label}`);

function frame(id: string, timestampMs: number | null, extra: Partial<FrameCandidate> = {}): FrameCandidate {
  return { id, bytes: bytesFor(id), timestampMs, ...extra };
}

test("frames without a real timestamp are never selected, and their time is never estimated", () => {
  const selection = selectRepresentativeFrames([frame("a", null), frame("b", null, { ocrText: "Buy now" })]);
  assert.deepEqual(selection.frames, []);
  assert.deepEqual(selection.omitted, [
    { id: "a", reason: "no_timestamp" },
    { id: "b", reason: "no_timestamp" },
  ]);
});

test("a non-finite or negative timestamp is treated as unknown", () => {
  const selection = selectRepresentativeFrames([frame("nan", Number.NaN), frame("neg", -5), frame("ok", 1000)]);
  assert.deepEqual(selection.omitted.filter((item) => item.reason === "no_timestamp").map((item) => item.id).sort(), ["nan", "neg"]);
  assert.deepEqual(selection.frames.map((item) => item.id), ["ok"]);
});

test("the four roles are chosen from the real timeline: hook, middle, proof, and call to action, in timestamp order", () => {
  const frames: FrameCandidate[] = [
    frame("f0", 0),
    frame("f1", 1500),
    frame("f2", 3000, { durationMs: 6000 }),
    frame("f3", 4500, { ocrText: "Clinically tested. Results in 14 days." }),
    frame("f4", 6000),
    frame("f5", 2600),
  ];
  const selection = selectRepresentativeFrames(frames);
  assert.equal(selection.frames.length, MAX_REPRESENTATIVE_FRAMES);
  assert.deepEqual(selection.frames.map((item) => [item.role, item.id, item.timestampMs]), [
    ["hook", "f0", 0],
    ["middle", "f2", 3000],
    ["proof", "f3", 4500],
    ["cta", "f4", 6000],
  ]);
  assert.deepEqual(selection.omitted, [{ id: "f1", reason: "not_selected" }, { id: "f5", reason: "not_selected" }]);
});

test("timestamps are carried exactly as reported, never rounded or shifted", () => {
  const selection = selectRepresentativeFrames([frame("only", 1234.5)]);
  assert.equal(selection.frames[0]?.timestampMs, 1234.5);
  assert.equal(selection.frames[0]?.role, "hook");
});

test("a proof frame is chosen only when OCR observed text; an empty slot is not filled with a random frame", () => {
  const selection = selectRepresentativeFrames([frame("a", 0), frame("b", 1000), frame("c", 2000), frame("d", 3000)]);
  assert.deepEqual(selection.frames.map((item) => item.role), ["hook", "middle", "cta"]);
  assert.ok(!selection.frames.some((item) => item.role === "proof"), "no fabricated proof frame");
  assert.equal(selection.frames.every((item) => item.ocrPresent === false), true);
});

test("when several frames carry text, the one with the most observed text is the proof frame", () => {
  // c sits at the middle of the media, so it is the middle beat. The proof slot is then chosen from b and d.
  const selection = selectRepresentativeFrames([
    frame("a", 0),
    frame("b", 1000, { ocrText: "Short." }),
    frame("c", 2000),
    frame("d", 3000, { ocrText: "A much longer line of on-screen proof text." }),
    frame("e", 4000),
  ]);
  assert.equal(selection.frames.find((item) => item.role === "middle")?.id, "c");
  const proof = selection.frames.find((item) => item.role === "proof");
  assert.equal(proof?.id, "d");
  assert.equal(proof?.ocrPresent, true);
});

test("identical bytes are sent once: the duplicate is omitted, not counted twice", () => {
  const same = new TextEncoder().encode("same pixels");
  const selection = selectRepresentativeFrames([
    { id: "first", bytes: same, timestampMs: 0 },
    { id: "copy", bytes: new Uint8Array(same), timestampMs: 500 },
    { id: "later", bytes: bytesFor("later"), timestampMs: 1000 },
  ]);
  assert.deepEqual(selection.omitted.find((item) => item.id === "copy"), { id: "copy", reason: "duplicate" });
  assert.equal(selection.frames.filter((item) => item.sha256 === selection.frames[0]?.sha256).length, 1);
});

test("an empty frame is omitted with its reason", () => {
  const selection = selectRepresentativeFrames([{ id: "blank", bytes: new Uint8Array(0), timestampMs: 0 }, frame("ok", 100)]);
  assert.deepEqual(selection.omitted, [{ id: "blank", reason: "empty" }]);
  assert.deepEqual(selection.frames.map((item) => item.id), ["ok"]);
});

test("the result does not depend on the order the caller listed the frames", () => {
  const frames = [frame("a", 0), frame("b", 2000), frame("c", 4000, { ocrText: "Proof" }), frame("d", 6000), frame("e", 8000)];
  const forward = selectRepresentativeFrames(frames);
  const reversed = selectRepresentativeFrames([...frames].reverse());
  assert.deepEqual(
    forward.frames.map(({ bytes: _bytes, ...rest }) => rest),
    reversed.frames.map(({ bytes: _bytes, ...rest }) => rest),
  );
});

test("the selection never exceeds four frames, however many are supplied", () => {
  const frames = Array.from({ length: 40 }, (_, index) => frame(`f${index}`, index * 250, { ocrText: index % 3 === 0 ? `text ${index}` : undefined }));
  const selection = selectRepresentativeFrames(frames);
  assert.ok(selection.frames.length <= MAX_REPRESENTATIVE_FRAMES);
  assert.equal(selection.frames.length, MAX_REPRESENTATIVE_FRAMES);
  assert.deepEqual(selection.frames.map((item) => item.timestampMs), [...selection.frames.map((item) => item.timestampMs)].sort((a, b) => a - b));
});

test("a single frame is the hook and nothing else; no frames gives an empty, versioned selection", () => {
  assert.deepEqual(selectRepresentativeFrames([]).frames, []);
  const one = selectRepresentativeFrames([frame("only", 0)]);
  assert.deepEqual(one.frames.map((item) => item.role), ["hook"]);
  assert.equal(one.version, "representative-frames.v1");
});
