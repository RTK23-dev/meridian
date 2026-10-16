// Tests for the three E5 components (Bible 9.2, 19 E5): kinetic.type, screen.mock and character.rig. Prop rules, escaping and
// media mapping through the compiler, and determinism of a composition that uses all three.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EditDecisionList } from "../../contracts/index.ts";
import { edlFixture, styleKitFixture } from "../../contracts/fixtures/index.ts";
import { compile } from "../compiler.ts";
import { COMPONENT_LIBRARY } from "./index.ts";
import { MAX_POSE_EVENTS, MAX_MOUTH_EVENTS, propsSchema as rigSchema } from "./character.rig/props.ts";
import { MAX_KINETIC_WORDS, propsSchema as kineticSchema } from "./kinetic.type/props.ts";
import { MAX_APP_ROWS, MAX_CHAT_MESSAGES, propsSchema as screenSchema } from "./screen.mock/props.ts";

type Schema = { safeParse: (input: unknown) => { success: boolean } };

/** The props as the compiler sees them: the component's own props plus the reserved durationMs. */
function accepts(schema: Schema, props: Record<string, unknown>, durationMs: number): boolean {
  return schema.safeParse({ ...props, durationMs }).success;
}

function textOf(files: Array<{ path: string; bytes: Uint8Array }>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error(`composition has no file ${path}`);
  }
  return new TextDecoder().decode(file.bytes);
}

/** An EDL with one graphics track: each clip runs back to back, for its own component and props. */
function clipEdl(clips: Array<{ component: string; props: Record<string, unknown>; durationMs: number }>): EditDecisionList {
  const edl = structuredClone(edlFixture);
  let cursor = 0;
  const graphics = clips.map((clip, index) => {
    const startMs = cursor;
    cursor += clip.durationMs;
    return { clipId: `c_e5_${index}`, startMs, endMs: cursor, component: clip.component, props: clip.props };
  });
  edl.tracks = [{ layer: "graphics", clips: graphics }];
  edl.durationMs = cursor;
  edl.audio.voice.endMs = cursor;
  delete edl.audio.music;
  edl.audio.sfx = [];
  edl.effects = [];
  return edl;
}

describe("kinetic.type: full kinetic type from the script, one line at a time", () => {
  const lines = [
    { text: "Stop buying", atMs: 0 },
    { text: "the blender", atMs: 900 },
  ];

  it("accepts lines in time order, and defaults to a stagger in the middle band", () => {
    const parsed = kineticSchema.parse({ lines, durationMs: 2000 });
    assert.equal(parsed.entrance, "stagger");
    assert.equal(parsed.band, "middle");
    assert.equal(parsed.wordStepMs, 120);
    assert.deepEqual(parsed.emphasis, []);
  });

  it("refuses lines out of order or at the same time, a line that starts after the clip, and an unknown entrance", () => {
    assert.equal(accepts(kineticSchema, { lines: [lines[1], lines[0]] }, 2000), false);
    assert.equal(accepts(kineticSchema, { lines: [lines[0], { text: "again", atMs: 0 }] }, 2000), false);
    assert.equal(accepts(kineticSchema, { lines: [{ text: "late", atMs: 2000 }] }, 2000), false);
    assert.equal(accepts(kineticSchema, { lines, entrance: "slide" }, 2000), false);
  });

  it("holds at most 24 words in all, six lines, four emphasis words, and a line of at most 40 characters", () => {
    const fourWords = (index: number) => ({ text: `a${index} b c d`, atMs: index * 100 });
    const six = Array.from({ length: 6 }, (_, index) => fourWords(index));
    assert.equal(MAX_KINETIC_WORDS, 24);
    assert.equal(accepts(kineticSchema, { lines: six }, 2000), true, "six lines of four words is 24 words");
    const fiveWordLine = { text: "a b c d e", atMs: 500 };
    assert.equal(accepts(kineticSchema, { lines: [...six.slice(0, 5), fiveWordLine] }, 2000), false, "25 words");
    const sevenLines = Array.from({ length: 7 }, (_, index) => ({ text: "a", atMs: index * 100 }));
    assert.equal(accepts(kineticSchema, { lines: sevenLines }, 2000), false, "seven lines");
    assert.equal(accepts(kineticSchema, { lines: [{ text: "x".repeat(40), atMs: 0 }] }, 2000), true, "one 40-character word");
    assert.equal(accepts(kineticSchema, { lines: [{ text: "x".repeat(41), atMs: 0 }] }, 2000), false, "41 characters");
    assert.equal(accepts(kineticSchema, { lines, emphasis: ["a", "b", "c", "d", "e"] }, 2000), false, "five emphasis words");
  });

  it("draws markup in a line as text: the compiled index.html carries it escaped, never as a tag", () => {
    const edl = clipEdl([
      {
        component: "kinetic.type",
        durationMs: 1500,
        props: { lines: [{ text: "<img src=x onerror=alert(1)>", atMs: 0 }], emphasis: [] },
      },
    ]);
    const result = compile(edl, styleKitFixture);
    const html = textOf(result.files, "index.html");
    assert.equal(html.includes("<img src=x"), false, "no raw tag reaches the page");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the line is carried as escaped JSON");
  });
});

describe("screen.mock: a notification, an app screen or a chat, on a phone or a desktop", () => {
  it("takes an image icon for a notification, and refuses audio as the icon", () => {
    const notification = { screen: "notification", app: "Blendbar", title: "On its way", iconUri: "store://golden/hero.png" };
    assert.equal(accepts(screenSchema, notification, 2000), true);
    assert.equal(accepts(screenSchema, { ...notification, iconUri: "store://golden/voice.wav" }, 2000), false);
  });

  it("defaults to a phone, and refuses an unknown device or screen", () => {
    const parsed = screenSchema.parse({ screen: "notification", app: "Blendbar", title: "Hi", durationMs: 1000 });
    assert.equal(parsed.device, "phone");
    assert.equal(accepts(screenSchema, { screen: "notification", app: "x", title: "y", device: "tablet" }, 1000), false);
    assert.equal(accepts(screenSchema, { screen: "video", title: "y" }, 1000), false);
  });

  it("requires rows on an app screen, and holds at most four", () => {
    const rows = Array.from({ length: MAX_APP_ROWS + 1 }, (_, index) => ({ label: `Row ${index}` }));
    assert.equal(accepts(screenSchema, { screen: "app", title: "Kit", rows: [] }, 2000), false);
    assert.equal(accepts(screenSchema, { screen: "app", title: "Kit", rows }, 2000), false);
    assert.equal(accepts(screenSchema, { screen: "app", title: "Kit", rows: rows.slice(0, MAX_APP_ROWS) }, 2000), true);
  });

  it("holds at most six chat messages, in time order, all inside the clip", () => {
    const message = (index: number) => ({ side: index % 2 === 0 ? "left" : "right", text: `m${index}`, atMs: index * 200 });
    const six = Array.from({ length: MAX_CHAT_MESSAGES }, (_, index) => message(index));
    assert.equal(accepts(screenSchema, { screen: "chat", messages: six }, 2000), true);
    assert.equal(accepts(screenSchema, { screen: "chat", messages: [...six, message(6)] }, 2000), false);
    assert.equal(accepts(screenSchema, { screen: "chat", messages: [message(2), message(1)] }, 2000), false);
    assert.equal(accepts(screenSchema, { screen: "chat", messages: [message(9)] }, 1000), false);
  });

  it("maps the icon to a local asset, so the EDL's URI never reaches the page, and shows markup as text", () => {
    const edl = clipEdl([
      {
        component: "screen.mock",
        durationMs: 2000,
        props: { screen: "notification", app: "Blendbar", title: "<b>Now</b>", iconUri: "store://golden/hero.png", atMs: 300 },
      },
    ]);
    const result = compile(edl, styleKitFixture);
    const html = textOf(result.files, "index.html");
    assert.equal(html.includes("store://golden/hero.png"), false, "the EDL URI is not in the page");
    assert.ok(html.includes("assets/"), "the icon is a local asset path");
    assert.equal(html.includes("<b>Now</b>"), false, "markup is escaped");
  });
});

describe("character.rig: one SVG rig, driven by a pose timeline and a mouth timeline", () => {
  it("accepts the rig, a pose and expression timeline, and mouth shapes in time order", () => {
    const props = {
      rigId: "bean.v1",
      position: "left",
      poses: [
        { atMs: 0, pose: "idle", expression: "neutral" },
        { atMs: 700, pose: "cheer" },
      ],
      mouth: [
        { atMs: 100, shape: "open" },
        { atMs: 300, shape: "round" },
      ],
    };
    const parsed = rigSchema.parse({ ...props, durationMs: 2000 });
    assert.equal(parsed.poses[1].expression, "neutral", "the expression defaults to neutral");
    assert.equal(parsed.position, "left");
  });

  it("refuses a pose or expression the rig does not draw, a viseme name from another rig, and an unknown rig", () => {
    assert.equal(accepts(rigSchema, { poses: [{ atMs: 0, pose: "dance" }] }, 2000), false);
    assert.equal(accepts(rigSchema, { poses: [{ atMs: 0, pose: "idle", expression: "sad" }] }, 2000), false);
    assert.equal(accepts(rigSchema, { mouth: [{ atMs: 0, shape: "A" }] }, 2000), false);
    assert.equal(accepts(rigSchema, { rigId: "mascot.v9" }, 2000), false);
  });

  it("refuses events out of order, events at or after the clip end, and more events than the rig can hold", () => {
    assert.equal(accepts(rigSchema, { mouth: [{ atMs: 300, shape: "open" }, { atMs: 100, shape: "closed" }] }, 2000), false);
    assert.equal(accepts(rigSchema, { poses: [{ atMs: 2000, pose: "idle" }] }, 2000), false);
    const poses = Array.from({ length: MAX_POSE_EVENTS + 1 }, (_, index) => ({ atMs: index, pose: "idle" }));
    assert.equal(accepts(rigSchema, { poses }, 60000), false);
    const mouth = Array.from({ length: MAX_MOUTH_EVENTS + 1 }, (_, index) => ({ atMs: index, shape: "open" }));
    assert.equal(accepts(rigSchema, { mouth }, 60000), false);
  });

  it("carries its timelines to the page as data, and the same EDL compiles to the same bytes twice", () => {
    const edl = clipEdl([
      {
        component: "character.rig",
        durationMs: 1800,
        props: {
          characterId: "char_fixture",
          poses: [{ atMs: 0, pose: "point", expression: "happy" }],
          mouth: [{ atMs: 200, shape: "wide" }, { atMs: 400, shape: "closed" }],
        },
      },
    ]);
    const first = compile(edl, styleKitFixture);
    const second = compile(edl, styleKitFixture);
    assert.equal(first.composition.contentHash, second.composition.contentHash);
    const html = textOf(first.files, "index.html");
    // data-variable-values carries the props as JSON, with the quotes escaped as attribute text.
    assert.ok(html.includes("&quot;shape&quot;:&quot;wide&quot;"), "the mouth timeline is in the page as data");
    assert.ok(html.includes("&quot;pose&quot;:&quot;point&quot;"), "the pose timeline is in the page as data");
    assert.ok(html.includes("char_fixture"));
  });
});

describe("the three E5 components compile together, deterministically", () => {
  it("a composition with a kinetic line, a screen and a rig has the same hash on every compile", () => {
    const edl = clipEdl([
      { component: "kinetic.type", durationMs: 1200, props: { lines: [{ text: "Four smoothies", atMs: 0 }], emphasis: ["smoothies"] } },
      {
        component: "screen.mock",
        durationMs: 1200,
        props: { screen: "chat", messages: [{ side: "left", text: "Is it loud?", atMs: 200 }] },
      },
      { component: "character.rig", durationMs: 1200, props: { poses: [{ atMs: 0, pose: "shrug" }], mouth: [{ atMs: 100, shape: "open" }] } },
    ]);
    const a = compile(edl, styleKitFixture, COMPONENT_LIBRARY);
    const b = compile(edl, styleKitFixture, COMPONENT_LIBRARY);
    assert.equal(a.composition.contentHash, b.composition.contentHash);
    const names = a.composition.files.map((file) => file.path).sort();
    assert.ok(names.includes("components/kinetic.type.html"));
    assert.ok(names.includes("components/screen.mock.html"));
    assert.ok(names.includes("components/character.rig.html"));
  });
});
