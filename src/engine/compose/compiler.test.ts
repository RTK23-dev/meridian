// Compiler tests (Bible 6.9, 9.1): snapshot on the contracts EDL fixture, determinism, escaping, the EDL rules that
// HyperFrames needs, and refusal of anything the compiler cannot render exactly.

import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { compositionHash, compositionSchema, EngineError, type EditDecisionList } from "../contracts/index.ts";
import { edlFixture, styleKitFixture } from "../contracts/fixtures/index.ts";
import { compile, COMPOSITION_FPS, GSAP_SCRIPT_URL, SUPPORTED_TRANSITIONS } from "./compiler.ts";
import { COMPONENT_LIBRARY } from "./components/index.ts";
import { escapeHtml } from "./html.ts";
import { z } from "zod";
import type { ComponentDefinition } from "./library.ts";

const SNAPSHOT_DIR = fileURLToPath(new URL("./snapshots/edl-fixture/", import.meta.url));
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const decoder = new TextDecoder();

function edlClone(mutate?: (edl: EditDecisionList) => void): EditDecisionList {
  const edl = structuredClone(edlFixture);
  mutate?.(edl);
  return edl;
}

function assertInvalid(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, pattern);
    return true;
  });
}

function textOf(result: ReturnType<typeof compile>, path: string): string {
  const file = result.files.find((candidate) => candidate.path === path);
  assert.ok(file, `composition has no file ${path}`);
  return decoder.decode(file.bytes);
}

/** The data-variable-values attribute of the host with the given clip id, parsed back to its JSON value. */
function hostValues(html: string, clipId: string): Record<string, unknown> {
  const pattern = new RegExp(`data-composition-id="${clipId}"[^>]*data-variable-values='([^']*)'`);
  const match = pattern.exec(html);
  assert.ok(match, `no component host for ${clipId}`);
  const json = match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("compile: the contracts EDL fixture", () => {
  const result = compile(edlFixture, styleKitFixture);

  it("matches the stored snapshot of index.html and of the file list", () => {
    const indexHtml = textOf(result, "index.html");
    const listing = {
      contentHash: result.composition.contentHash,
      files: result.composition.files,
      assets: result.assets,
    };
    const snapshotIndex = `${SNAPSHOT_DIR}index.html`;
    const snapshotListing = `${SNAPSHOT_DIR}composition.json`;
    if (UPDATE) {
      mkdirSync(SNAPSHOT_DIR, { recursive: true });
      writeFileSync(snapshotIndex, indexHtml);
      writeFileSync(snapshotListing, `${JSON.stringify(listing, null, 2)}\n`);
    }
    assert.ok(existsSync(snapshotIndex) && existsSync(snapshotListing), "snapshot missing; run UPDATE_SNAPSHOTS=1");
    assert.equal(indexHtml, readFileSync(snapshotIndex, "utf8"));
    assert.deepEqual(listing, JSON.parse(readFileSync(snapshotListing, "utf8")));
  });

  it("writes one root composition at 1080 x 1920 and 30 fps, with the tracks in stack order", () => {
    const html = textOf(result, "index.html");
    assert.match(html, /data-composition-id="root" data-start="0" data-duration="24\.000" data-width="1080" data-height="1920"/);
    assert.equal(COMPOSITION_FPS, 30);
    const order = [...html.matchAll(/data-track-index="(\d+)"/g)].map((match) => Number(match[1]));
    const picture = order.filter((track) => track < 10);
    assert.deepEqual(picture, [...picture].sort((a, b) => a - b), "picture tracks follow stack order");
    assert.ok(html.includes(`src="${GSAP_SCRIPT_URL}"`), "GSAP is loaded from the pinned CDN URL");
  });

  it("uses each component clip as a sub-composition with its props as variable values", () => {
    const html = textOf(result, "index.html");
    assert.match(html, /data-composition-src="components\/product\.card\.html"/);
    assert.match(html, /data-composition-src="components\/cta\.card\.html"/);
    assert.match(html, /data-composition-src="components\/captions\.karaoke\.html"/);
    const card = hostValues(html, "c_gfx_4");
    assert.equal(card.name, "Fixture Blender");
    assert.equal(card.durationMs, 6000, "the reserved durationMs comes from the clip span");
    assert.deepEqual(card.bullets, [], "defaults fill the props the EDL leaves out");
  });

  it("copies each used component template byte for byte and writes the style kit once", () => {
    for (const name of ["captions.karaoke", "cta.card", "product.card"]) {
      assert.equal(textOf(result, `components/${name}.html`), COMPONENT_LIBRARY[name].template);
    }
    const css = textOf(result, "style.css");
    assert.equal(css.split(":root").length - 1, 1, "one :root block");
    assert.match(css, /--kit-caption-highlight: #FFD60A;/);
    assert.match(css, /--kit-font-display: "Fraunces";/);
    assert.match(css, /--kit-caption-case: uppercase;/);
  });

  it("keeps every media URI out of the HTML: clips point at local asset paths", () => {
    const html = textOf(result, "index.html");
    assert.equal(html.includes("store://"), false);
    for (const asset of result.assets) {
      assert.match(asset.path, /^assets\/[0-9a-f]{16}\.(mp4|wav|png)$/);
    }
    assert.deepEqual(result.composition.assetUris, [...new Set(result.assets.map((asset) => asset.uri))].sort());
  });

  it("lists the files with the hashes of their bytes, sorted, and the composition hash is their hash", () => {
    const paths = result.composition.files.map((file) => file.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.equal(result.composition.rootFile, "index.html");
    assert.equal(result.composition.contentHash, compositionHash(result.composition.files));
    assert.equal(compositionSchema.safeParse(result.composition).success, true);
    for (const file of result.files) {
      assert.ok(!file.path.startsWith("/") && !file.path.split("/").includes(".."));
    }
  });
});

describe("compile: determinism (same inputs, same bytes, same hash)", () => {
  it("compiles twice to byte-identical files and the same contentHash", () => {
    const first = compile(edlFixture, styleKitFixture);
    const second = compile(edlFixture, styleKitFixture);
    assert.equal(first.composition.contentHash, second.composition.contentHash);
    assert.deepEqual(
      first.files.map((file) => [file.path, Buffer.from(file.bytes).toString("hex")]),
      second.files.map((file) => [file.path, Buffer.from(file.bytes).toString("hex")]),
    );
  });

  it("does not depend on the order of the tracks in the EDL", () => {
    const reversed = edlClone((edl) => {
      edl.tracks.reverse();
    });
    assert.equal(compile(reversed, styleKitFixture).composition.contentHash, compile(edlFixture, styleKitFixture).composition.contentHash);
  });

  it("changes the hash when the content changes", () => {
    const changed = edlClone((edl) => {
      edl.effects[0].params.scale = 1.2;
    });
    assert.notEqual(compile(changed, styleKitFixture).composition.contentHash, compile(edlFixture, styleKitFixture).composition.contentHash);
  });
});

describe("compile: escaping (ad and script text is untrusted)", () => {
  it("escapes markup in component text and keeps it out of the HTML as tags", () => {
    const hostile = `</script><img src=x onerror="alert(1)"> & 'quotes'`;
    const edl = edlClone((draft) => {
      draft.tracks.push({
        layer: "stickers",
        clips: [
          {
            clipId: "c_cta_hostile",
            startMs: 0,
            endMs: 2000,
            component: "cta.card",
            props: { text: hostile },
          },
        ],
      });
    });
    const result = compile(edl, styleKitFixture);
    const html = textOf(result, "index.html");
    assert.equal(html.includes("<img src=x"), false, "no raw tag from the text");
    assert.equal(html.includes("</script><img"), false);
    assert.equal(hostValues(html, "c_cta_hostile").text, hostile, "the JSON round-trips the text exactly");
  });

  it("escapes HTML special characters in the title and in media paths", () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("compile: the EDL rules HyperFrames needs", () => {
  it("refuses two clips that overlap on one layer", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[1].clips[1].startMs = 8000;
          }),
          styleKitFixture,
        ),
      /overlap/,
    );
  });

  it("refuses a clip that runs past the timeline", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[0].clips[0].endMs = edl.durationMs + 1;
          }),
          styleKitFixture,
        ),
      /after the 24000 ms timeline/,
    );
  });

  it("refuses a layer listed twice and a clip with both or neither of a source and a component", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks.push({ layer: "base", clips: [] });
          }),
          styleKitFixture,
        ),
      /appears more than once/,
    );
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[0].clips[0].component = "cta.card";
          }),
          styleKitFixture,
        ),
      /cannot have both/,
    );
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            delete edl.tracks[0].clips[0].srcUri;
          }),
          styleKitFixture,
        ),
      /needs a srcUri or a component/,
    );
  });

  it("refuses a clip id with characters HyperFrames ids do not take, and a duplicate id", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[0].clips[0].clipId = "bad.id";
          }),
          styleKitFixture,
        ),
      /clip id/,
    );
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[1].clips[0].clipId = edl.tracks[0].clips[0].clipId;
          }),
          styleKitFixture,
        ),
      /must be unique/,
    );
  });

  it("refuses an unknown component, and props that fail the component's schema, naming the clip", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[3].clips[0].component = "not.a.component";
          }),
          styleKitFixture,
        ),
      /not in the library/,
    );
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[2].clips[1].props = { text: "" };
          }),
          styleKitFixture,
        ),
      /clip c_gfx_5 props for cta\.card are invalid/,
    );
  });

  it("refuses media of an unsupported kind or for a slot that cannot take it", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[0].clips[0].srcUri = "store://takes/take1.gif";
          }),
          styleKitFixture,
        ),
      /no supported extension/,
    );
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[0].clips[0].srcUri = "store://voice/vt.wav";
          }),
          styleKitFixture,
        ),
      /needs a video or image/,
    );
  });

  it("refuses an audio gain HyperFrames cannot play", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.audio.voice.gainDb = 20;
          }),
          styleKitFixture,
        ),
      /outside what HyperFrames plays/,
    );
  });

  it("refuses an unknown transition, and draws the supported ones", () => {
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[1].clips[1].transitionIn = "zoom";
          }),
          styleKitFixture,
        ),
      /does not draw/,
    );
    assert.deepEqual([...SUPPORTED_TRANSITIONS], ["hard", "fade", "whip"]);
    const result = compile(
      edlClone((edl) => {
        edl.tracks[1].clips[0].transitionIn = "fade";
        edl.tracks[1].clips[1].transitionIn = "whip";
      }),
      styleKitFixture,
    );
    const html = textOf(result, "index.html");
    assert.match(html, /tl\.fromTo\(document\.getElementById\("clip-c_base_2"\), \{ opacity: 0 \}/);
    assert.match(html, /tl\.fromTo\(document\.getElementById\("clip-c_base_3"\), \{ x: 120 \}/);
  });

  it("draws punch-ins, shakes and flashes on the composition clock, and refuses what it cannot draw", () => {
    const result = compile(
      edlClone((edl) => {
        edl.effects.push({ atMs: 5000, kind: "shake", params: { amplitude: 8, durationMs: 300 } });
        edl.effects.push({ atMs: 9000, kind: "flash", params: { opacity: 0.6 } });
      }),
      styleKitFixture,
    );
    const html = textOf(result, "index.html");
    assert.match(html, /tl\.to\(document\.getElementById\("stage"\), \{ scale: 1\.1/);
    assert.match(html, /tl\.to\(document\.getElementById\("stage"\), \{ x: 8/);
    assert.match(html, /tl\.fromTo\(document\.getElementById\("fx-flash"\), \{ opacity: 0 \}, \{ opacity: 0\.6/);
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.effects[0].kind = "speed_ramp";
          }),
          styleKitFixture,
        ),
      /not supported by the compiler yet/,
    );
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.effects[0].params = { scale: 1.1, unknown: 2 };
          }),
          styleKitFixture,
        ),
      /does not take the parameter unknown/,
    );
  });

  it("places a boxed clip with its box and stacks layers in order", () => {
    const html = textOf(compile(edlFixture, styleKitFixture), "index.html");
    assert.match(html, /id="clip-c_gfx_4"[^>]*style="z-index:4;left:60px;top:900px;width:960px;height:700px;"/);
    assert.match(html, /id="clip-c_presenter_1"[^>]*style="z-index:3;"/);
  });

  it("draws a still image as an img element and a video as a muted video element", () => {
    const result = compile(
      edlClone((edl) => {
        edl.tracks[1].clips.push({ clipId: "c_still", startMs: 0, endMs: 1000, srcUri: "store://img/still.png" });
      }),
      styleKitFixture,
    );
    const html = textOf(result, "index.html");
    assert.match(html, /<img class="clip" id="clip-c_still"/);
    assert.match(html, /<video class="clip" id="clip-c_base_2"[^>]* muted /);
  });

  it("maps a *Uri prop to a local asset and refuses a non-image for it", () => {
    const result = compile(
      edlClone((edl) => {
        edl.tracks[2].clips[0].props = { name: "Fixture Blender", heroUri: "store://products/blender.png" };
      }),
      styleKitFixture,
    );
    const html = textOf(result, "index.html");
    const values = hostValues(html, "c_gfx_4");
    assert.match(String(values.heroUri), /^assets\/[0-9a-f]{16}\.png$/);
    assert.ok(result.assets.some((asset) => asset.uri === "store://products/blender.png" && asset.kind === "image"));
    assertInvalid(
      () =>
        compile(
          edlClone((edl) => {
            edl.tracks[2].clips[0].props = { name: "X", heroUri: "store://products/blender.wav" };
          }),
          styleKitFixture,
        ),
      /is audio, but this slot takes image or video/,
    );
  });

  it("maps a *Uri or *Uris value at any depth (inside list items too), and refuses audio for it", () => {
    const probe: ComponentDefinition = {
      name: "test.mediaProbe",
      template:
        '<!DOCTYPE html>\n<html data-composition-variables=\'[]\'>\n<head></head>\n<body>\n<div data-composition-id="test.mediaProbe" data-width="1080" data-height="1920"></div>\n</body>\n</html>\n',
      propsSchema: z.object({
        shots: z.array(z.object({ imageUri: z.string() })),
        frameUris: z.array(z.string()),
        durationMs: z.int().positive(),
      }),
      declaredVariables: [],
      fixtures: [],
    };
    const edl = (frameUris: string[]) =>
      edlClone((draft) => {
        draft.tracks[2].clips[0].component = "test.mediaProbe";
        draft.tracks[2].clips[0].props = { shots: [{ imageUri: "store://a/one.png" }], frameUris };
      });
    const library = { ...COMPONENT_LIBRARY, "test.mediaProbe": probe };
    const result = compile(edl(["store://b/two.webm"]), styleKitFixture, library);
    const html = textOf(result, "index.html");
    const values = hostValues(html, "c_gfx_4");
    const shots = values.shots as Array<{ imageUri: string }>;
    assert.match(shots[0].imageUri, /^assets\/[0-9a-f]{16}\.png$/);
    assert.match((values.frameUris as string[])[0], /^assets\/[0-9a-f]{16}\.webm$/);
    assert.equal(html.includes("store://"), false, "no EDL URI reaches the composition");
    assertInvalid(
      () => compile(edl(["store://b/voice.wav"]), styleKitFixture, library),
      /is audio, but this slot takes image or video/,
    );
  });

  it("refuses a style kit whose font name could break the CSS", () => {
    assertInvalid(
      () =>
        compile(edlFixture, {
          ...styleKitFixture,
          fonts: { display: 'Fraunces"; x: y', body: "Inter", captions: "Inter" },
        }),
      /not a plain family name/,
    );
  });
});
