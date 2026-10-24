// EditDecisionList to HyperFrames composition (Bible 9.1). Pure: the same EDL, style kit and library give the same
// files, byte for byte, and therefore the same contentHash. The contentHash is the render idempotency key (6.11).
//
// What the compiler does, in order: validate the inputs; check the layer and span rules that HyperFrames needs
// (no overlaps on one track, nothing past the end); map every media URI to a local asset path; validate every
// component's props with its schema; write the HTML with every text value escaped; and list the files with their hashes.
// Claude never sees this code: it selects components and fills props (L6).

import { createHash } from "node:crypto";
import {
  compositionHash,
  compositionSchema,
  contentHash,
  EDL_LAYERS,
  edlSchema,
  EngineError,
  encodeUlid,
  type Composition,
  type CompositionFile,
  type EdlClip,
  type EditDecisionList,
  type EdlLayer,
  type LookPreset,
  type VisualTreatment,
} from "../contracts/index.ts";
import { attributeJson, escapeHtml } from "./html.ts";
import { COMPONENT_LIBRARY } from "./components/index.ts";
import { RESERVED_PROP_DURATION, type ComponentDefinition, type ComponentLibrary } from "./library.ts";
import { parseStyleKit, styleKitCss } from "./styleKit.ts";

export const COMPOSITION_WIDTH = 1080;
export const COMPOSITION_HEIGHT = 1920;
export const COMPOSITION_FPS = 30;

/** GSAP is loaded from the CDN at the version HyperFrames' own default uses (core gsapCdn.js, 3.15.0). */
export const GSAP_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js";

/** Audio gain is set with data-volume, which HyperFrames caps at +12 dB (3.98). */
const MAX_VOLUME = 3.98;

/** The layers a visual treatment changes: the footage. Captions, graphics and stickers are never mirrored, framed or tinted (contract v11). */
const FOOTAGE_LAYERS: ReadonlySet<EdlLayer> = new Set<EdlLayer>(["base", "cutaway", "presenter"]);

/**
 * The Meridian-owned overlay of each look (contract v11): its colour, its blend mode and its opacity at full strength. A look is a preset
 * name, so the composition never receives CSS from the EDL.
 */
const LOOK_OVERLAY: Record<LookPreset, { color: string; blend: string; opacity: number }> = {
  warm: { color: "#ff8c42", blend: "overlay", opacity: 0.45 },
  cool: { color: "#3d7bd9", blend: "overlay", opacity: 0.4 },
  faded: { color: "#d8cfc4", blend: "screen", opacity: 0.25 },
  mono: { color: "#808080", blend: "saturation", opacity: 1 },
};

/** Grain is a fractal-noise tile drawn in the composition itself (no asset to register). Every special character is percent-encoded. */
const GRAIN_URL =
  "data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27160%27%20height=%27160%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%270.85%27%20numOctaves=%272%27%20stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect%20width=%27100%25%27%20height=%27100%25%27%20filter=%27url%28%23n%29%27/%3E%3C/svg%3E";
const GRAIN_OPACITY = 0.2;
const VIGNETTE_EDGE_OPACITY = 0.75;

/** Track index for each layer, in stack order (back to front). Audio sits on its own tracks above the picture. */
const LAYER_TRACK: Record<EdlLayer, number> = {
  base: 0,
  cutaway: 1,
  presenter: 2,
  graphics: 3,
  captions: 4,
  stickers: 5,
};
const VOICE_TRACK = 10;
const MUSIC_TRACK = 11;
const SFX_TRACK_BASE = 12;

const MEDIA_KINDS = {
  mp4: "video",
  webm: "video",
  mov: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  wav: "audio",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
} as const;

export type AssetKind = "video" | "image" | "audio";

export type CompiledAsset = {
  /** Path inside the composition, e.g. assets/0123456789abcdef.mp4. */
  path: string;
  /** The EDL URI the path stands for. The render step resolves it to bytes. */
  uri: string;
  kind: AssetKind;
};

export type CompiledFile = { path: string; bytes: Uint8Array };

export type CompileResult = {
  files: CompiledFile[];
  composition: Composition;
  assets: CompiledAsset[];
};

/**
 * What the caller knows about a clip beyond the EDL. clipSourceUris maps a clip id to the media URIs the clip's shot
 * produced (its takes). A sourceBound component (stopmotion.player) needs its entry; other components ignore it.
 */
export type CompileOptions = {
  clipSourceUris?: ReadonlyMap<string, readonly string[]>;
};

/** Transitions the compiler knows how to draw. Anything else is refused, so nothing is silently dropped. */
export const SUPPORTED_TRANSITIONS = ["hard", "fade", "whip"] as const;

const CLIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: "compose" });
}

/** Seconds with three decimals: exact for integer milliseconds, so the text is stable. */
function secs(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function num(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function extensionOf(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? "";
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** Maps every media URI to a stable local path, and checks that each use gets the kind it needs. */
class AssetRegistry {
  private readonly byUri = new Map<string, CompiledAsset>();

  register(uri: string, allowed: readonly AssetKind[]): string {
    if (uri.length === 0 || /\s/.test(uri)) {
      throw invalid(`media URI "${uri}" must be a non-empty URI without spaces`);
    }
    const ext = extensionOf(uri);
    const kind = (MEDIA_KINDS as Record<string, AssetKind | undefined>)[ext];
    if (!kind) {
      throw invalid(`media URI "${uri}" has no supported extension`);
    }
    if (!allowed.includes(kind)) {
      throw invalid(`media URI "${uri}" is ${kind}, but this slot takes ${allowed.join(" or ")}`);
    }
    const existing = this.byUri.get(uri);
    if (existing) {
      return existing.path;
    }
    const path = `assets/${sha256Hex(uri).slice(0, 16)}.${ext}`;
    this.byUri.set(uri, { path, uri, kind });
    return path;
  }

  list(): CompiledAsset[] {
    return [...this.byUri.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

function parseEdl(input: unknown): EditDecisionList {
  const parsed = edlSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(`edit decision list is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Checks the EDL rules that HyperFrames needs and returns each layer's clips in time order. */
function checkTracks(edl: EditDecisionList): Map<EdlLayer, EdlClip[]> {
  const seenLayers = new Set<string>();
  const seenClips = new Set<string>();
  const byLayer = new Map<EdlLayer, EdlClip[]>();
  for (const track of edl.tracks) {
    if (seenLayers.has(track.layer)) {
      throw invalid(`layer ${track.layer} appears more than once`);
    }
    seenLayers.add(track.layer);
    const clips = [...track.clips].sort((a, b) => a.startMs - b.startMs || (a.clipId < b.clipId ? -1 : 1));
    clips.forEach((clip, index) => {
      if (!CLIP_ID.test(clip.clipId)) {
        throw invalid(`clip id "${clip.clipId}" must use letters, digits, _ or - (1 to 64 characters)`);
      }
      if (clip.clipId === "root" || seenClips.has(clip.clipId)) {
        throw invalid(`clip id "${clip.clipId}" must be unique in the composition and not be "root"`);
      }
      seenClips.add(clip.clipId);
      if (clip.endMs > edl.durationMs) {
        throw invalid(`clip ${clip.clipId} ends at ${clip.endMs} ms, after the ${edl.durationMs} ms timeline`);
      }
      if (index > 0 && clip.startMs < clips[index - 1].endMs) {
        throw invalid(`clips ${clips[index - 1].clipId} and ${clip.clipId} overlap on layer ${track.layer}`);
      }
      if (clip.srcUri === undefined && clip.component === undefined) {
        throw invalid(`clip ${clip.clipId} needs a srcUri or a component`);
      }
      if (clip.srcUri !== undefined && clip.component !== undefined) {
        throw invalid(`clip ${clip.clipId} cannot have both a srcUri and a component`);
      }
      if (clip.transitionIn !== undefined && !(SUPPORTED_TRANSITIONS as readonly string[]).includes(clip.transitionIn)) {
        throw invalid(`clip ${clip.clipId} uses transition "${clip.transitionIn}", which the compiler does not draw`);
      }
    });
    byLayer.set(track.layer, clips);
  }
  return byLayer;
}

function boxStyle(clip: EdlClip): string {
  if (!clip.box) {
    return "";
  }
  const { x, y, w, h } = clip.box;
  return `left:${num(x)}px;top:${num(y)}px;width:${num(w)}px;height:${num(h)}px;`;
}

/** A prop named *Uri holds one media URI, and a prop named *Uris holds a list of them. */
const MEDIA_KEY = /Uris?$/;

/**
 * Maps every media URI in a props tree to a local asset path. The walk goes into objects and arrays, so a URI inside a
 * list item (for example a tier board's item image) is mapped too, and no EDL URI reaches the HTML. Every mapped
 * value must be an image or a video, which the registry checks.
 */
function mapMediaUris(value: unknown, assets: AssetRegistry, key = ""): unknown {
  if (typeof value === "string" && MEDIA_KEY.test(key)) {
    return assets.register(value, ["image", "video"]);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapMediaUris(item, assets, key));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = mapMediaUris(child, assets, childKey);
    }
    return out;
  }
  return value;
}

/** Every media URI in a props tree, in the order it appears (the same walk as mapMediaUris). */
function collectMediaUris(value: unknown, out: string[], key = ""): void {
  if (typeof value === "string" && MEDIA_KEY.test(key)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaUris(item, out, key);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      collectMediaUris(child, out, childKey);
    }
  }
}

/**
 * A sourceBound component draws only the media its own shot produced (Bible 7.1, 9.2). The caller must say which URIs
 * those are for this clip. Without that list, or with a URI outside it, the clip is refused.
 */
function checkOwnSources(clip: EdlClip, definition: ComponentDefinition, props: unknown, options: CompileOptions): void {
  const allowed = options.clipSourceUris?.get(clip.clipId);
  if (allowed === undefined) {
    throw invalid(
      `clip ${clip.clipId} uses ${definition.name}, which draws only its own shot's media: pass the URIs that shot produced for this clip`,
    );
  }
  const used: string[] = [];
  collectMediaUris(props, used);
  for (const uri of used) {
    if (!allowed.includes(uri)) {
      throw invalid(`clip ${clip.clipId} ${definition.name} uses ${uri}, which is not one of the shot's own sources`);
    }
  }
}

/** Validates a component clip's props, then maps every media URI in them to a local asset. */
function componentValues(
  clip: EdlClip,
  definition: ComponentDefinition,
  durationMs: number,
  assets: AssetRegistry,
  options: CompileOptions,
): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...(clip.props ?? {}), [RESERVED_PROP_DURATION]: durationMs };
  const parsed = definition.propsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "props"}: ${issue.message}`);
    throw invalid(`clip ${clip.clipId} props for ${definition.name} are invalid: ${issues.join("; ")}`);
  }
  if (definition.sourceBound === true) {
    checkOwnSources(clip, definition, parsed.data, options);
  }
  return mapMediaUris(parsed.data, assets) as Record<string, unknown>;
}

/** A footage clip's treatment as a CSS transform: the mirror first, then the framing. Empty when the cut has neither. */
function footageTransform(visual: VisualTreatment): string {
  const parts: string[] = [];
  if (visual.mirror === true) parts.push("scaleX(-1)");
  if (visual.framing !== undefined) {
    const framing = visual.framing;
    parts.push(`scale(${num(framing.zoom)})`, `rotate(${num(framing.rotationDeg)}deg)`, `translate(${num(framing.offsetXPct)}%, ${num(framing.offsetYPct)}%)`);
  }
  return parts.length === 0 ? "" : `transform:${parts.join(" ")};`;
}

/**
 * The overlays of a cut's look, grain and vignette: over the footage, under the graphics, captions and stickers. Empty when none is set. The
 * geometry is inline, so a composition without treatments keeps its style.css and its contentHash.
 */
function overlayElements(visual: VisualTreatment): string[] {
  const z = LAYER_TRACK.presenter + 1;
  const box = `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:${z};`;
  const overlays: string[] = [];
  if (visual.look !== undefined && visual.look.strength > 0) {
    const look = LOOK_OVERLAY[visual.look.preset];
    overlays.push(
      `<div id="fx-look" class="fx-overlay" style="${box}background:${look.color};mix-blend-mode:${look.blend};opacity:${num(look.opacity * visual.look.strength)};"></div>`,
    );
  }
  if (visual.grain !== undefined && visual.grain.strength > 0) {
    overlays.push(`<div id="fx-grain" class="fx-overlay" style="${box}background-image:url(${GRAIN_URL});opacity:${num(GRAIN_OPACITY * visual.grain.strength)};"></div>`);
  }
  if (visual.vignette !== undefined && visual.vignette.strength > 0) {
    overlays.push(
      `<div id="fx-vignette" class="fx-overlay" style="${box}background:radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,1) 100%);opacity:${num(VIGNETTE_EDGE_OPACITY * visual.vignette.strength)};"></div>`,
    );
  }
  return overlays;
}

function mediaElement(clip: EdlClip, layer: EdlLayer, src: string, kind: AssetKind, treatment = ""): string {
  const start = secs(clip.startMs);
  const duration = secs(clip.endMs - clip.startMs);
  const mediaStart = secs(clip.srcInMs ?? 0);
  const style = `z-index:${LAYER_TRACK[layer] + 1};${boxStyle(clip)}${treatment}`;
  if (kind === "video") {
    return `<video class="clip" id="clip-${clip.clipId}" src="${escapeHtml(src)}" data-start="${start}" data-duration="${duration}" data-track-index="${LAYER_TRACK[layer]}" data-media-start="${mediaStart}" muted playsinline preload="auto" style="${style}"></video>`;
  }
  return `<img class="clip" id="clip-${clip.clipId}" src="${escapeHtml(src)}" alt="" data-start="${start}" data-duration="${duration}" data-track-index="${LAYER_TRACK[layer]}" style="${style}">`;
}

function componentElement(clip: EdlClip, layer: EdlLayer, definition: ComponentDefinition, values: Record<string, unknown>): string {
  const start = secs(clip.startMs);
  const duration = secs(clip.endMs - clip.startMs);
  const style = `z-index:${LAYER_TRACK[layer] + 1};${boxStyle(clip)}`;
  return `<div class="clip" id="clip-${clip.clipId}" data-composition-id="${clip.clipId}" data-composition-src="components/${definition.name}.html" data-start="${start}" data-duration="${duration}" data-track-index="${LAYER_TRACK[layer]}" data-variable-values='${attributeJson(values)}' style="${style}"></div>`;
}

function audioElement(id: string, src: string, startMs: number, endMs: number, gainDb: number, track: number): string {
  const volume = 10 ** (gainDb / 20);
  if (!(volume > 0 && volume <= MAX_VOLUME)) {
    throw invalid(`audio gain ${gainDb} dB is outside what HyperFrames plays (up to +12 dB)`);
  }
  return `<audio class="clip" id="${id}" src="${escapeHtml(src)}" data-start="${secs(startMs)}" data-duration="${secs(endMs - startMs)}" data-track-index="${track}" data-volume="${num(volume)}"></audio>`;
}

/** Transitions and effects, drawn with GSAP on the composition clock. Every number here comes from validated input. */
function timelineLines(edl: EditDecisionList): string[] {
  const lines: string[] = [];
  const stage = 'document.getElementById("stage")';
  const flash = 'document.getElementById("fx-flash")';
  for (const track of edl.tracks) {
    for (const clip of track.clips) {
      const at = clip.startMs / 1000;
      const el = `document.getElementById("clip-${clip.clipId}")`;
      if (clip.transitionIn === "fade") {
        lines.push(`tl.fromTo(${el}, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "none" }, ${num(at)});`);
      } else if (clip.transitionIn === "whip") {
        lines.push(`tl.fromTo(${el}, { x: 120 }, { x: 0, duration: 0.15, ease: "power3.out" }, ${num(at)});`);
      }
    }
  }
  for (const effect of edl.effects) {
    const at = effect.atMs / 1000;
    const params = effect.params;
    const known = (names: string[]) => {
      for (const key of Object.keys(params)) {
        if (!names.includes(key)) {
          throw invalid(`effect ${effect.kind} does not take the parameter ${key}`);
        }
      }
    };
    if (effect.kind === "punch_in") {
      known(["scale"]);
      const scale = params.scale ?? 1.1;
      if (!(scale > 1 && scale <= 1.5)) {
        throw invalid("punch_in scale must be above 1 and at most 1.5");
      }
      lines.push(`tl.to(${stage}, { scale: ${num(scale)}, duration: 0.1, ease: "power2.out" }, ${num(at)});`);
      lines.push(`tl.to(${stage}, { scale: 1, duration: 0.2, ease: "power2.in" }, ${num(at + 0.1)});`);
    } else if (effect.kind === "shake") {
      known(["amplitude", "durationMs"]);
      const amplitude = params.amplitude ?? 10;
      const durationMs = params.durationMs ?? 300;
      if (!(amplitude > 0 && amplitude <= 60)) {
        throw invalid("shake amplitude must be above 0 and at most 60 px");
      }
      if (!(durationMs >= 100 && durationMs <= 2000)) {
        throw invalid("shake durationMs must be between 100 and 2000");
      }
      const steps = [1, -1, 0.8, -0.8, 0.4, 0];
      const step = durationMs / 1000 / steps.length;
      steps.forEach((factor, index) => {
        lines.push(`tl.to(${stage}, { x: ${num(amplitude * factor)}, duration: ${num(step)}, ease: "none" }, ${num(at + index * step)});`);
      });
    } else if (effect.kind === "flash") {
      known(["opacity"]);
      const opacity = params.opacity ?? 0.8;
      if (!(opacity > 0 && opacity <= 1)) {
        throw invalid("flash opacity must be above 0 and at most 1");
      }
      lines.push(`tl.fromTo(${flash}, { opacity: 0 }, { opacity: ${num(opacity)}, duration: 0.05, ease: "none" }, ${num(at)});`);
      lines.push(`tl.to(${flash}, { opacity: 0, duration: 0.15, ease: "none" }, ${num(at + 0.05)});`);
    } else {
      throw invalid(`effect ${effect.kind} is not supported by the compiler yet`);
    }
  }
  return lines;
}

/** The layout CSS that every composition shares, after the kit's custom properties. */
const LAYOUT_CSS = `html, body {
  margin: 0;
  width: ${COMPOSITION_WIDTH}px;
  height: ${COMPOSITION_HEIGHT}px;
  overflow: hidden;
  background: var(--kit-background);
}
#root {
  position: relative;
  width: ${COMPOSITION_WIDTH}px;
  height: ${COMPOSITION_HEIGHT}px;
  overflow: hidden;
  background: var(--kit-background);
}
#stage {
  position: absolute;
  left: 0;
  top: 0;
  width: ${COMPOSITION_WIDTH}px;
  height: ${COMPOSITION_HEIGHT}px;
  transform-origin: 50% 50%;
}
.clip {
  position: absolute;
  left: 0;
  top: 0;
  width: ${COMPOSITION_WIDTH}px;
  height: ${COMPOSITION_HEIGHT}px;
}
.clip video,
.clip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
#fx-flash {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background: #ffffff;
  opacity: 0;
  pointer-events: none;
  z-index: 1000;
}
`;

/**
 * Compile an EDL into a HyperFrames composition.
 * Throws EngineError(invalid_input) for an EDL, kit or props the compiler cannot render exactly, including a
 * sourceBound component whose clip has no source list or a media URI outside it.
 */
export function compile(
  edlInput: unknown,
  styleKitInput: unknown,
  components: ComponentLibrary = COMPONENT_LIBRARY,
  options: CompileOptions = {},
): CompileResult {
  const edl = parseEdl(edlInput);
  const kit = parseStyleKit(styleKitInput);
  const byLayer = checkTracks(edl);
  const assets = new AssetRegistry();
  const usedComponents = new Map<string, ComponentDefinition>();

  const picture: string[] = [];
  for (const layer of EDL_LAYERS) {
    for (const clip of byLayer.get(layer) ?? []) {
      const start = clip.startMs;
      if (clip.component !== undefined) {
        const definition = components[clip.component];
        if (!definition) {
          throw invalid(`clip ${clip.clipId} uses component ${clip.component}, which is not in the library`);
        }
        usedComponents.set(definition.name, definition);
        const values = componentValues(clip, definition, clip.endMs - start, assets, options);
        picture.push(componentElement(clip, layer, definition, values));
      } else {
        const src = clip.srcUri as string;
        const kind = (MEDIA_KINDS as Record<string, AssetKind | undefined>)[extensionOf(src)];
        if (kind === undefined) {
          throw invalid(`media URI "${src}" has no supported extension`);
        }
        if (kind !== "video" && kind !== "image") {
          throw invalid(`clip ${clip.clipId} needs a video or image, got ${src}`);
        }
        const path = assets.register(src, [kind]);
        const treatment = edl.visual !== undefined && FOOTAGE_LAYERS.has(layer) ? footageTransform(edl.visual) : "";
        picture.push(mediaElement(clip, layer, path, kind, treatment));
      }
    }
  }
  // The look, grain and vignette sit over the footage and under the graphics, captions and stickers (contract v11).
  if (edl.visual !== undefined) picture.push(...overlayElements(edl.visual));

  const audio: string[] = [];
  const voiceSrc = assets.register(edl.audio.voice.uri, ["audio"]);
  audio.push(audioElement("audio-voice", voiceSrc, edl.audio.voice.startMs, edl.audio.voice.endMs, edl.audio.voice.gainDb, VOICE_TRACK));
  if (edl.audio.music) {
    const musicSrc = assets.register(edl.audio.music.uri, ["audio"]);
    audio.push(audioElement("audio-music", musicSrc, edl.audio.music.startMs, edl.audio.music.endMs, edl.audio.music.gainDb, MUSIC_TRACK));
  }
  edl.audio.sfx.forEach((sfx, index) => {
    const sfxSrc = assets.register(sfx.uri, ["audio"]);
    audio.push(audioElement(`audio-sfx-${index}`, sfxSrc, sfx.startMs, sfx.endMs, sfx.gainDb, SFX_TRACK_BASE + index));
  });

  const componentNames = [...usedComponents.keys()].sort();
  const indexHtml = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    `<meta name="viewport" content="width=${COMPOSITION_WIDTH}, height=${COMPOSITION_HEIGHT}">`,
    `<title>${escapeHtml(edl.edlId)}</title>`,
    '<link rel="stylesheet" href="style.css">',
    `<script src="${GSAP_SCRIPT_URL}"></script>`,
    "</head>",
    "<body>",
    `<div id="root" data-composition-id="root" data-start="0" data-duration="${secs(edl.durationMs)}" data-width="${COMPOSITION_WIDTH}" data-height="${COMPOSITION_HEIGHT}">`,
    '<div id="stage">',
    ...picture,
    '<div id="fx-flash"></div>',
    "</div>",
    ...audio,
    "<script>",
    "window.__timelines = window.__timelines || {};",
    "var tl = gsap.timeline({ paused: true });",
    ...timelineLines(edl),
    `tl.set({}, {}, ${secs(edl.durationMs)});`,
    'window.__timelines["root"] = tl;',
    "</script>",
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  const styleCss = `${styleKitCss(kit)}\n${LAYOUT_CSS}`;

  const assetList = assets.list();
  const assetsJson = `${JSON.stringify(assetList.map((asset) => ({ kind: asset.kind, path: asset.path, uri: asset.uri })), null, 2)}\n`;

  const texts = new Map<string, string>([
    ["index.html", indexHtml],
    ["style.css", styleCss],
    ["assets.json", assetsJson],
  ]);
  for (const name of componentNames) {
    texts.set(`components/${name}.html`, (usedComponents.get(name) as ComponentDefinition).template);
  }

  const files: CompiledFile[] = [...texts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) }));

  const compositionFiles: CompositionFile[] = files.map((file) => ({
    path: file.path,
    contentHash: contentHash(file.bytes),
    bytes: file.bytes.byteLength,
  }));
  const hash = compositionHash(compositionFiles);
  const composition = compositionSchema.parse({
    schema: "meridian.composition/v1",
    compositionId: `cmp_${encodeUlid(0, BigInt(`0x${hash.slice("sha256:".length, "sha256:".length + 20)}`))}`,
    edlId: edl.edlId,
    rootFile: "index.html",
    files: compositionFiles,
    assetUris: [...new Set(assetList.map((asset) => asset.uri))].sort(),
    contentHash: hash,
  });

  return { files, composition, assets: assetList };
}
