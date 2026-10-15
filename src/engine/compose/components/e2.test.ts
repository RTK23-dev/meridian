// Tests for the five E2 components (Bible 9.2, 19 E2): prop rules, price formatting (L8), escaping through the compiler,
// nested media mapping, determinism of a composition that uses all ten components, and the safe zones of the text boxes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type EditDecisionList } from "../../contracts/index.ts";
import { edlFixture, styleKitFixture } from "../../contracts/fixtures/index.ts";
import { compile } from "../compiler.ts";
import { COMPONENT_LIBRARY } from "./index.ts";
import { propsSchema as chatSchema } from "./chat.thread/props.ts";
import { propsSchema as compareSchema } from "./compare.split/props.ts";
import { formatPrice, propsSchema as priceSchema } from "./price.reveal/props.ts";
import { propsSchema as reactSchema } from "./react.layout/props.ts";
import { propsSchema as tierSchema } from "./list.tierBoard/props.ts";

type Schema = { safeParse: (input: unknown) => { success: boolean } };

/** The props as the compiler sees them: the component's own props plus the reserved durationMs. */
function accepts(schema: Schema, props: Record<string, unknown>, durationMs: number): boolean {
  return schema.safeParse({ ...props, durationMs }).success;
}

function textOf(files: Array<{ path: string; bytes: Uint8Array }>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  assert.ok(file, `composition has no file ${path}`);
  return new TextDecoder().decode(file.bytes);
}

/** An EDL with one graphics track: each clip runs back to back, for its own component and props. */
function clipEdl(clips: Array<{ component: string; props: Record<string, unknown>; durationMs: number }>): EditDecisionList {
  const edl = structuredClone(edlFixture);
  let cursor = 0;
  const graphics = clips.map((clip, index) => {
    const startMs = cursor;
    cursor += clip.durationMs;
    return { clipId: `c_e2_${index}`, startMs, endMs: cursor, component: clip.component, props: clip.props };
  });
  edl.tracks = [{ layer: "graphics", clips: graphics }];
  edl.durationMs = cursor;
  edl.audio.voice.endMs = cursor;
  delete edl.audio.music;
  edl.audio.sfx = [];
  edl.effects = [];
  return edl;
}

describe("price.reveal: a price is data, and code draws its text (L8)", () => {
  it("formats whole and fractional amounts, groups thousands, and drops a zero fraction", () => {
    assert.equal(formatPrice(4900, "USD"), "$49");
    assert.equal(formatPrice(4999, "USD"), "$49.99");
    assert.equal(formatPrice(129900, "USD"), "$1,299");
    assert.equal(formatPrice(5, "USD"), "$0.05");
    assert.equal(formatPrice(100, "GBP"), "£1");
    assert.equal(formatPrice(4999, "EUR"), "€49.99");
    assert.equal(formatPrice(1080000, "JPY"), "¥1,080,000");
    assert.equal(formatPrice(250000, "CAD"), "CA$2,500");
    assert.equal(formatPrice(1234567, "AUD"), "A$12,345.67");
  });

  it("refuses an amount that is zero, negative, fractional or too large, and an unknown currency", () => {
    for (const amount of [0, -5, 1.5, 2_000_000_000]) {
      assert.equal(accepts(priceSchema, { newAmountMinor: amount }, 2000), false, `amount ${amount}`);
    }
    assert.equal(accepts(priceSchema, { newAmountMinor: 100, currency: "XYZ" }, 2000), false);
    assert.throws(() => formatPrice(0, "USD"), RangeError);
  });

  it("hands the component display text only, with the old price struck and the new price revealed", () => {
    const parsed = priceSchema.parse({
      currency: "USD",
      oldAmountMinor: 12900,
      newAmountMinor: 9900,
      revealMs: 800,
      caption: "Today only",
      durationMs: 2400,
    });
    assert.deepEqual(parsed, { durationMs: 2400, revealMs: 800, newText: "$99", oldText: "$129", caption: "Today only" });
  });

  it("omits the old text when there is no old price, and refuses a reveal after the clip", () => {
    const parsed = priceSchema.parse({ newAmountMinor: 4999, durationMs: 1800, revealMs: 500 });
    assert.deepEqual(parsed, { durationMs: 1800, revealMs: 500, newText: "$49.99" });
    assert.equal(accepts(priceSchema, { newAmountMinor: 4999, revealMs: 2000 }, 2000), false);
  });
});

describe("list.tierBoard: tiers, items and drop times", () => {
  const tiers = [
    { label: "S", tone: "accent" },
    { label: "A", tone: "primary" },
  ];

  it("accepts a board, defaults the tone to primary, and takes image URIs only for item images", () => {
    const parsed = tierSchema.parse({
      tiers: [{ label: "S" }, { label: "A", tone: "text" }],
      items: [{ name: "Blender Pro", tier: 0, dropMs: 300, imageUri: "store://items/pro.png" }],
      durationMs: 2000,
    });
    assert.equal(parsed.tiers[0].tone, "primary");
    assert.equal(parsed.tiers[1].tone, "text");
    assert.equal(accepts(tierSchema, { tiers, items: [{ name: "Pro", tier: 0, dropMs: 0, imageUri: "store://x/a.mp4" }] }, 2000), false);
    assert.equal(accepts(tierSchema, { tiers, items: [{ name: "Pro", tier: 0, dropMs: 0, imageUri: "store://x/a.png" }] }, 2000), true);
  });

  it("refuses an item in a tier that does not exist, and more than four items in one tier", () => {
    assert.equal(accepts(tierSchema, { tiers, items: [{ name: "Pro", tier: 2, dropMs: 0 }] }, 2000), false);
    const five = Array.from({ length: 5 }, (_, index) => ({ name: `Item ${index}`, tier: 0, dropMs: 0 }));
    assert.equal(accepts(tierSchema, { tiers, items: five }, 2000), false);
    assert.equal(accepts(tierSchema, { tiers, items: five.slice(0, 4) }, 2000), true);
  });

  it("refuses a drop after the clip, a label of three characters, a name over 24 and more than five tiers", () => {
    assert.equal(accepts(tierSchema, { tiers, items: [{ name: "Pro", tier: 0, dropMs: 2000 }] }, 2000), false);
    assert.equal(accepts(tierSchema, { tiers: [{ label: "TOP" }] }, 2000), false);
    assert.equal(accepts(tierSchema, { tiers, items: [{ name: "x".repeat(25), tier: 0, dropMs: 0 }] }, 2000), false);
    const six = Array.from({ length: 6 }, () => ({ label: "A" }));
    assert.equal(accepts(tierSchema, { tiers: six }, 2000), false);
  });
});

describe("react.layout: a base clip and a presenter in a picture-in-picture box", () => {
  it("accepts an image or a video for each clip, and refuses audio", () => {
    const base = { baseUri: "store://golden/base.png", presenterUri: "store://golden/presenter.webm" };
    assert.equal(accepts(reactSchema, base, 2000), true);
    assert.equal(accepts(reactSchema, { ...base, baseUri: "store://golden/base.mp4" }, 2000), true);
    assert.equal(accepts(reactSchema, { ...base, presenterUri: "store://golden/voice.wav" }, 2000), false);
  });

  it("defaults the position to bottom right at 34% width, and bounds the width and the entrance", () => {
    const parsed = reactSchema.parse({ baseUri: "store://a.png", presenterUri: "store://b.png", durationMs: 2000 });
    assert.equal(parsed.pip, "bottom-right");
    assert.equal(parsed.pipWidthPct, 34);
    assert.equal(parsed.pipInMs, 0);
    assert.equal(accepts(reactSchema, { baseUri: "store://a.png", presenterUri: "store://b.png", pipWidthPct: 41 }, 2000), false);
    assert.equal(accepts(reactSchema, { baseUri: "store://a.png", presenterUri: "store://b.png", pipInMs: 2000 }, 2000), false);
    assert.equal(accepts(reactSchema, { baseUri: "store://a.png", presenterUri: "store://b.png", pip: "centre" }, 2000), false);
  });
});

describe("compare.split: two labelled panels", () => {
  it("requires both labels of 12 characters or fewer, and takes media only as an option", () => {
    assert.equal(accepts(compareSchema, { leftLabel: "Before", rightLabel: "After" }, 2000), true);
    assert.equal(accepts(compareSchema, { leftLabel: "Before" }, 2000), false);
    assert.equal(accepts(compareSchema, { leftLabel: "x".repeat(13), rightLabel: "After" }, 2000), false);
    assert.equal(accepts(compareSchema, { leftLabel: "A", rightLabel: "B", revealMs: 2000 }, 2000), false);
  });
});

describe("chat.thread: messages as data, in time order", () => {
  const exchange = (messages: Array<Record<string, unknown>>) => ({ messages });

  it("accepts an exchange whose typing lead-ins start after the message before", () => {
    const props = exchange([
      { side: "left", text: "Hi", atMs: 600 },
      { side: "right", text: "Hello", atMs: 1900, typingMs: 900 },
    ]);
    assert.equal(accepts(chatSchema, props, 4000), true);
    assert.equal(chatSchema.parse({ ...props, durationMs: 4000 }).messages[1].typingMs, 900);
  });

  it("refuses messages out of order, a typing lead-in that starts before the message before it, and a message after the clip", () => {
    assert.equal(
      accepts(chatSchema, exchange([{ side: "left", text: "B", atMs: 900 }, { side: "right", text: "A", atMs: 500 }]), 4000),
      false,
    );
    assert.equal(
      accepts(
        chatSchema,
        exchange([{ side: "left", text: "A", atMs: 1000 }, { side: "right", text: "B", atMs: 1200, typingMs: 500 }]),
        4000,
      ),
      false,
    );
    assert.equal(accepts(chatSchema, exchange([{ side: "left", text: "A", atMs: 4000 }]), 4000), false);
  });

  it("refuses a side other than left or right, empty text, text over 200 characters, and more than ten messages", () => {
    assert.equal(accepts(chatSchema, exchange([{ side: "centre", text: "A", atMs: 0 }]), 4000), false);
    assert.equal(accepts(chatSchema, exchange([{ side: "left", text: "", atMs: 0 }]), 4000), false);
    assert.equal(accepts(chatSchema, exchange([{ side: "left", text: "x".repeat(201), atMs: 0 }]), 4000), false);
    const eleven = Array.from({ length: 11 }, (_, index) => ({ side: "left", text: "A", atMs: index * 100 }));
    assert.equal(accepts(chatSchema, exchange(eleven), 4000), false);
  });

  it("refuses a typing lead-in longer than three seconds", () => {
    assert.equal(accepts(chatSchema, exchange([{ side: "left", text: "A", atMs: 3500, typingMs: 3100 }]), 4000), false);
  });
});

describe("text reaches the HTML as escaped data (L8, Bible 9.1)", () => {
  it("escapes markup in a chat message, so it shows as text and never as a tag", () => {
    const result = compile(
      clipEdl([
        {
          component: "chat.thread",
          props: { messages: [{ side: "left", text: "<b>Bold?</b> <img src=x onerror=alert(1)>", atMs: 200 }] },
          durationMs: 1000,
        },
      ]),
      styleKitFixture,
    );
    const html = textOf(result.files, "index.html");
    assert.equal(html.includes("<img src=x"), false, "no raw tag in the composition");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the message is carried escaped");
  });

  it("escapes markup in a tier item name and in a compare label", () => {
    const result = compile(
      clipEdl([
        {
          component: "list.tierBoard",
          props: { tiers: [{ label: "S" }], items: [{ name: "<img src=x>", tier: 0, dropMs: 0 }] },
          durationMs: 1000,
        },
        { component: "compare.split", props: { leftLabel: "<b>x", rightLabel: "After" }, durationMs: 1000 },
      ]),
      styleKitFixture,
    );
    const html = textOf(result.files, "index.html");
    assert.equal(html.includes("<img src=x>"), false);
    assert.equal(html.includes("<b>x"), false);
  });
});

describe("nested media: a list item's image is mapped to a local asset (L8)", () => {
  it("maps the item image URI to assets/<hash>.png and keeps the EDL URI out of the HTML", () => {
    const result = compile(
      clipEdl([
        {
          component: "list.tierBoard",
          props: {
            tiers: [{ label: "S" }],
            items: [{ name: "Blender Pro", tier: 0, dropMs: 0, imageUri: "store://items/blender-pro.png" }],
          },
          durationMs: 1500,
        },
      ]),
      styleKitFixture,
    );
    const html = textOf(result.files, "index.html");
    assert.match(html, /assets\/[0-9a-f]{16}\.png/);
    assert.equal(html.includes("store://"), false, "no EDL URI in the composition");
    assert.ok(result.assets.some((asset) => asset.uri === "store://items/blender-pro.png" && asset.kind === "image"));
  });

  it("refuses a video where an item image belongs", () => {
    assert.throws(
      () =>
        compile(
          clipEdl([
            {
              component: "list.tierBoard",
              props: { tiers: [{ label: "S" }], items: [{ name: "Pro", tier: 0, dropMs: 0, imageUri: "store://items/a.mp4" }] },
              durationMs: 1000,
            },
          ]),
          styleKitFixture,
        ),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("a composition with every component in the library is deterministic and self-contained", () => {
  const names = Object.keys(COMPONENT_LIBRARY).sort();
  const clips = names.map((name) => {
    const fixture = COMPONENT_LIBRARY[name].fixtures[0];
    return { component: name, props: fixture.props, durationMs: fixture.durationMs };
  });
  // A sourceBound component (stopmotion.player) draws only its own shot's media, so its clip gets that shot's list.
  const sources = new Map(
    names.flatMap((name, index) =>
      COMPONENT_LIBRARY[name].sourceBound === true ? [[`c_e2_${index}`, COMPONENT_LIBRARY[name].fixtures[0].sourceUris ?? []] as const] : [],
    ),
  );

  it("compiles to the same bytes and hash twice, with one host and one template per component", () => {
    const first = compile(clipEdl(clips), styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: sources });
    const second = compile(clipEdl(clips), styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: sources });
    assert.equal(first.composition.contentHash, second.composition.contentHash);
    for (const name of names) {
      assert.ok(textOf(first.files, "index.html").includes(`data-composition-src="components/${name}.html"`), name);
      assert.ok(first.files.some((file) => file.path === `components/${name}.html`), `template for ${name}`);
    }
    assert.equal(textOf(first.files, "index.html").includes("store://"), false);
  });
});

describe("safe zones (Bible 8.3) for the E2 text boxes", () => {
  it("keeps the chat list between 6% and 88% of the width and clear of the top and bottom 20%", () => {
    const template = COMPONENT_LIBRARY["chat.thread"].template;
    assert.match(template, /\.ct-list \{\s*position: absolute;\s*left: 6%;\s*width: 82%;\s*top: 20%;\s*bottom: 20%;/);
    assert.match(template, /\.ct-header \{[^}]*top: 10%;/);
  });

  it("keeps the price stack and the tier board between 6% and 88% of the width", () => {
    assert.match(COMPONENT_LIBRARY["price.reveal"].template, /\.pr-stack \{\s*position: absolute;\s*left: 6%;\s*width: 82%;/);
    assert.match(COMPONENT_LIBRARY["list.tierBoard"].template, /\.tb-root \{\s*position: absolute;\s*left: 6%;\s*top: 10%;\s*width: 82%;\s*height: 70%;/);
  });

  it("keeps each compare label inside its half, ending before 88% of the frame", () => {
    const template = COMPONENT_LIBRARY["compare.split"].template;
    assert.match(template, /\.cs-label \{[^}]*left: 6%;[^}]*max-width: 70%;/);
  });

  it("keeps the picture-in-picture box clear of the right 12% for its right-hand positions", () => {
    const template = COMPONENT_LIBRARY["react.layout"].template;
    assert.match(template, /\.rl-pip-top-right \{ right: 12%; top: 10%; \}/);
    assert.match(template, /\.rl-pip-bottom-right \{ right: 12%; bottom: 20%; \}/);
  });
});
