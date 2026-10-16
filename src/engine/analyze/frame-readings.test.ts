// frame_reader inside analyze_reference and the render review, on recorded role answers (synthetic, labelled in fixtures/README.md).
// The measurements are the captured ones of the analyze reel; the picture readings are the captured punch clip. No test calls a
// live API. The acceptance here: the analyze gate passes on honest inputs with every grammar measurement made.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoleAnswerError } from "../claude/errors.ts";
import { videoDnaSchema } from "../contracts/analysis.ts";
import { pngBytes } from "../assets/test/recorded.ts";
import type { Frame } from "../media/index.ts";
import { RESERVATION_ID, REQUEST_ID, WORKSPACE } from "../claude/test/helpers.ts";
import {
  DNA_ID,
  frameReaderBody,
  frameReaderTextBody,
  genomeBody,
  recordedPictureClient,
  referencePorts as portsFor,
  referenceRun as run,
  segmenterBody,
} from "./test/harness.ts";
import { analyzeReference } from "./reference.ts";
import {
  captionWordsAt,
  overlayMeasures,
  readRenderedFrames,
  textWordsAt,
} from "./renderReadings.ts";
import type { FrameScope } from "./frameReader.ts";

/** The 15 frames of the analyze reel's plan, in order (see the frame plan of media/frames.ts). */
const FRAME_TIMES = [
  250, 750, 1250, 1533, 1750, 2250, 2750, 3033, 3250, 3750, 4250, 4567, 4750, 5250, 5750,
];

function frames(): Frame[] {
  return FRAME_TIMES.map((atMs) => ({
    atMs,
    width: 64,
    height: 64,
    png: new Uint8Array(pngBytes(64)),
  }));
}

describe("analyze_reference with frame_reader: every grammar measurement is made", () => {
  it("passes the dna gate on the recorded reference: captions, zoom, shake, speed ramps and loop all measured", async () => {
    const { ports, requests, released } = await portsFor({
      responses: [segmenterBody, genomeBody, frameReaderBody],
      analysisReadings: { picture: recordedPictureClient("punch") },
    });
    const outcome = await analyzeReference(run(), ports);

    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    const failing = outcome.gate.checks.filter((check) => !check.pass);
    assert.deepEqual(failing, [], `gate checks that failed: ${JSON.stringify(failing)}`);
    assert.equal(outcome.gate.pass, true);
    assert.deepEqual(outcome.unknown, [], "no grammar field is unknown");
    assert.ok(outcome.dna, "the DNA is built");
    assert.equal(videoDnaSchema.safeParse(outcome.dna).success, true);
    assert.equal(outcome.dna.videoDnaId, DNA_ID);

    const grammar = outcome.dna.editGrammar;
    assert.deepEqual(grammar.captions, {
      wordsPerCaption: [2, 3],
      position: "lower",
      style: "outlined",
      highlightCurrentWord: true,
    });
    assert.equal(grammar.motion.shakeOnImpact, false, "no shake was judged in the frames");
    assert.equal(grammar.motion.speedRamps, false, "no speed ramp was judged in the frames");
    assert.equal(typeof grammar.endsOnLoop, "boolean");
    assert.equal(released.length, 1, "the source is released once");
    assert.equal(
      requests.length,
      3,
      "the segmenter, the genome and frame_reader are each called once",
    );
  });

  it("sends frame_reader every frame of the plan, in order, with the cut list and the frame times, as untrusted data", async () => {
    const { ports, requests } = await portsFor({
      responses: [segmenterBody, genomeBody, frameReaderBody],
      analysisReadings: { picture: recordedPictureClient("punch") },
    });
    await analyzeReference(run(), ports);
    const body = requests[2]?.body;
    const text =
      typeof body === "string" ? body : Buffer.from(body ?? new Uint8Array()).toString("utf8");
    const message = JSON.parse(text) as { messages: Array<{ content: unknown }> };
    const user = message.messages.find((item) => Array.isArray(item.content)) as {
      content: Array<{ type: string; text?: string }>;
    };
    const images = user.content.filter((part) => part.type === "image_url");
    assert.equal(
      images.length,
      FRAME_TIMES.length,
      "one image per frame of the plan (fewer than the 24 limit)",
    );
    const block = user.content.map((part) => part.text ?? "").join("\n");
    assert.match(block, /<untrusted-data name="frames">/);
    assert.match(block, /"cutsMs":\[1533,3033,4567\]/);
    assert.match(block, /Frame 3 at 1533 ms:/);
  });

  it("retries a frame_reader answer that puts words in a text key, and uses the valid answer that follows", async () => {
    const { ports, requests } = await portsFor({
      responses: [segmenterBody, genomeBody, frameReaderTextBody, frameReaderBody],
      analysisReadings: { picture: recordedPictureClient("punch") },
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(
      outcome.gate.pass,
      true,
      JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)),
    );
    assert.equal(requests.length, 4, "the refused answer is retried once");
  });

  it("an answer that fails the contract twice fails the stage: nothing is stored from a guess", async () => {
    const { ports } = await portsFor({
      responses: [segmenterBody, genomeBody, frameReaderTextBody, frameReaderTextBody],
      analysisReadings: { picture: recordedPictureClient("punch") },
    });
    await assert.rejects(
      () => analyzeReference(run(), ports),
      (error: unknown) => error instanceof RoleAnswerError,
    );
  });
});

describe("the render review's reads of the rendered frames (Bible 12.3)", () => {
  it("reads overlays and caption words at the frames the review asks for, with no text read", async () => {
    const { ports } = await portsFor({ responses: [frameReaderBody] });
    const scope: FrameScope = {
      organizationId: WORKSPACE,
      requestId: REQUEST_ID,
      reservationId: RESERVATION_ID,
      attempt: 1,
      durationMs: 6000,
      cutsMs: [1533, 3033, 4567],
    };
    const outcome = await readRenderedFrames(ports.roles, scope, frames());
    assert.equal(outcome.status, "answered");
    if (outcome.status !== "answered") return;
    assert.equal(outcome.readings.length, FRAME_TIMES.length);

    // The recorded answer has no overlay, so a graphic clip at 1533 ms is not drawn in its frame.
    assert.deepEqual(
      overlayMeasures(
        [{ clipId: "clip_graphic", atMs: 1533, box: { x: 0.05, y: 0.1, w: 0.4, h: 0.2 } }],
        outcome.readings,
      ),
      [{ clipId: "clip_graphic", present: false }],
    );
    // The caption at 1533 ms is the frame's third (an odd index): three words.
    assert.equal(captionWordsAt(outcome.readings, 1533), 3);
    assert.equal(textWordsAt(outcome.readings, 1533), 0);
    // A time the review did not send is not read (null), so the check that needs it fails closed.
    assert.equal(captionWordsAt(outcome.readings, 1000), null);
  });
});
