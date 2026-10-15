import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonSchemaFor } from "../../gateway/openrouter.ts";
import { loadPrompt } from "../../prompts/load.ts";
import { estimateClaudeUsd } from "../rates.ts";
import {
  frameReader,
  frameReaderAnswerSchema,
  frameReaderInputSchema,
  frameReaderUserContent,
  FRAME_READER_MAX_FRAMES,
  type FrameReaderInput,
} from "./frame_reader.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** The raw input, not yet parsed, so a test can check that the contract refuses it. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    durationMs: 3000,
    cutsMs: [1000],
    frames: [
      { atMs: 500, imageUrl: PNG },
      { atMs: 1500, imageUrl: PNG },
    ],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}): FrameReaderInput {
  return frameReaderInputSchema.parse(raw(overrides));
}

/** A reading that is valid for any frame at the given index. */
function reading(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index,
    confidence: 0.9,
    captions: [],
    overlays: [],
    textWords: 0,
    shake: "none",
    speedRamp: "none",
    ...overrides,
  };
}

/** A recorded answer of the role for the two frames above (hand-written to the contract, labelled synthetic in the tests). */
const RECORDED_ANSWER = {
  frames: [
    reading(0, {
      captions: [
        {
          box: { x: 0.1, y: 0.78, w: 0.8, h: 0.07 },
          words: 3,
          style: "outlined",
          highlight: "one_word",
        },
      ],
      textWords: 0,
    }),
    reading(1, {
      captions: [
        {
          box: { x: 0.12, y: 0.8, w: 0.76, h: 0.07 },
          words: 2,
          style: "outlined",
          highlight: "one_word",
        },
      ],
      overlays: [{ box: { x: 0.05, y: 0.1, w: 0.4, h: 0.2 }, kind: "graphic" }],
      shake: "present",
      speedRamp: "unclear",
    }),
  ],
};

describe("the frame_reader role (Bible 6.2 step 6, 11.1, v4)", () => {
  it("is a check call on frame_reader@1, Haiku with vision, priced at the proposed 12k in and 2k out", () => {
    assert.equal(frameReader.role, "frame_reader");
    assert.equal(frameReader.capability, "llm.check");
    assert.equal(frameReader.prompt.version, 1);
    assert.equal(frameReader.maxOutputTokens, 2000);
    assert.deepEqual(frameReader.estimateTokens, { input: 12000, output: 2000 });
    assert.equal(
      estimateClaudeUsd("anthropic/claude-haiku-5.5", frameReader.estimateTokens),
      0.022,
    );
  });

  it("pins the bytes of frame_reader@1", () => {
    assert.equal(
      loadPrompt(frameReader.prompt).fileHash,
      "sha256:63a636dbed7058b802ff0a85c89cf74b726d7892f210b55f4699174ec0a186a1",
    );
  });

  describe("the input contract", () => {
    it("accepts frames in time order inside the video, with cuts inside it", () => {
      assert.equal(frameReaderInputSchema.safeParse(input()).success, true);
    });

    it("refuses a frame at or past the end, a cut past the end, and frames out of order", () => {
      assert.equal(
        frameReaderInputSchema.safeParse({
          durationMs: 3000,
          cutsMs: [],
          frames: [{ atMs: 3000, imageUrl: PNG }],
        }).success,
        false,
      );
      assert.equal(frameReaderInputSchema.safeParse(raw({ cutsMs: [3000] })).success, false);
      assert.equal(
        frameReaderInputSchema.safeParse(
          raw({
            frames: [
              { atMs: 1500, imageUrl: PNG },
              { atMs: 500, imageUrl: PNG },
            ],
          }),
        ).success,
        false,
      );
    });

    it("refuses more frames than the per-call maximum, and an image that is not an inline data URL", () => {
      const many = Array.from({ length: FRAME_READER_MAX_FRAMES + 1 }, (_, index) => ({
        atMs: index * 100,
        imageUrl: PNG,
      }));
      assert.equal(
        frameReaderInputSchema.safeParse({ durationMs: 5000, cutsMs: [], frames: many }).success,
        false,
      );
      assert.equal(
        frameReaderInputSchema.safeParse(
          raw({ frames: [{ atMs: 500, imageUrl: "https://example.test/frame.png" }] }),
        ).success,
        false,
      );
    });
  });

  describe("the answer contract", () => {
    it("accepts the recorded answer for two frames", () => {
      const parsed = frameReaderAnswerSchema(input()).safeParse(RECORDED_ANSWER);
      assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    });

    it("refuses an answer with the wrong number of readings, or an index out of place", () => {
      const schema = frameReaderAnswerSchema(input());
      assert.equal(schema.safeParse({ frames: [reading(0)] }).success, false);
      assert.equal(schema.safeParse({ frames: [reading(0), reading(0)] }).success, false);
      assert.equal(schema.safeParse({ frames: [reading(1), reading(0)] }).success, false);
    });

    it("refuses any key the contract does not name, at the top, in a reading and in a box: no free text", () => {
      const schema = frameReaderAnswerSchema(input());
      assert.equal(
        schema.safeParse({ frames: [reading(0), reading(1)], notes: "extra" }).success,
        false,
      );
      assert.equal(
        schema.safeParse({ frames: [reading(0, { text: "BUY NOW" }), reading(1)] }).success,
        false,
      );
      const withLabel = reading(0, {
        captions: [
          {
            box: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
            words: 2,
            style: "plain",
            highlight: "none",
            label: "buy now",
          },
        ],
      });
      assert.equal(schema.safeParse({ frames: [withLabel, reading(1)] }).success, false);
    });

    it("refuses a box that lies outside the frame, a word count out of range, and an unknown style", () => {
      const schema = frameReaderAnswerSchema(input());
      const outside = reading(0, {
        captions: [
          { box: { x: 0.8, y: 0.7, w: 0.4, h: 0.1 }, words: 2, style: "plain", highlight: "none" },
        ],
      });
      assert.equal(schema.safeParse({ frames: [outside, reading(1)] }).success, false);
      const tooMany = reading(0, {
        captions: [
          { box: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 }, words: 13, style: "plain", highlight: "none" },
        ],
      });
      assert.equal(schema.safeParse({ frames: [tooMany, reading(1)] }).success, false);
      const unknownStyle = reading(0, {
        captions: [
          { box: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 }, words: 2, style: "neon", highlight: "none" },
        ],
      });
      assert.equal(schema.safeParse({ frames: [unknownStyle, reading(1)] }).success, false);
    });

    it("refuses more than three caption boxes in a frame, and a confidence outside 0 to 1", () => {
      const schema = frameReaderAnswerSchema(input());
      const box = {
        box: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
        words: 2,
        style: "plain",
        highlight: "none",
      };
      assert.equal(
        schema.safeParse({ frames: [reading(0, { captions: [box, box, box, box] }), reading(1)] })
          .success,
        false,
      );
      assert.equal(
        schema.safeParse({ frames: [reading(0, { confidence: 1.2 }), reading(1)] }).success,
        false,
      );
    });

    it("the answer has no string field except the fixed enums: no words can come back in it", () => {
      const schema = JSON.stringify(jsonSchemaFor(frameReaderAnswerSchema(input())));
      const parsed = JSON.parse(schema) as Record<string, unknown>;
      const strings: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (node === null || typeof node !== "object") return;
        const object = node as Record<string, unknown>;
        if (object.type === "string" && !Array.isArray(object.enum)) strings.push(path);
        for (const [key, value] of Object.entries(object)) walk(value, `${path}/${key}`);
      };
      walk(parsed, "");
      assert.deepEqual(strings, [], `free-text fields in the answer schema: ${strings.join(", ")}`);
    });
  });

  it("sends the frames as one untrusted data block with indices and times, then each image in order", () => {
    const parts = frameReaderUserContent(input());
    const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    assert.match(text, /<untrusted-data name="frames">/);
    assert.match(text, /"cutsMs":\[1000\]/);
    const images = parts.filter((part) => part.type === "image_url");
    assert.equal(images.length, 2);
    assert.match(text, /Frame 0 at 500 ms:/);
    assert.match(text, /Frame 1 at 1500 ms:/);
  });
});
