// EDL diffs (Video Engine Bible 6.13). A variant is the master EDL with one change applied, and this file does two things with it:
// it builds the variant EDL from the master (pure transforms, one per attribute), and it checks the result against the master
// with diffEdl: every changed part of the EDL is named by a surface (captions, music, voice, one clip, the timing of one clip, and
// so on), and checkControl refuses a variant whose changes are not the ones its attribute allows. So a caption variant that also
// moved a shot is not built, and the control of every variant is a checked fact, not a label.
//
// The re-render-only attributes (caption and music) are built here in full. Hook, persona and language variants change the voice
// and the takes, so the editor rebuilds their EDL from the new inputs; this file checks the rebuilt EDL against its control the
// same way. The product transform (withVisualSources) swaps the takes of the product shots for a variant whose takes exist.

import { canonicalJson, contentHash, edlSchema, EngineError, encodeUlid, type EditDecisionList, type EdlClip } from "../contracts/index.ts";
import { VARIANT_EDL_PREFIX, type CaptionBand, type VariantAttribute, variantMusicMix } from "./config.ts";
import type { PlannedVariant, VariantMusicTrack } from "./expand.ts";

/** The visual layers, the ones that hold shot clips with media (Bible 4.4). */
const VISUAL_LAYERS = ["base", "cutaway", "presenter", "graphics"] as const;

/**
 * One changed part of an EDL. surface is one of: "captions", "music", "voice", "sfx", "effects", "visual:<clipId>" (the clip's
 * media or props), "timing:<clipId>" (its start or end), "structure:<layer>" (a clip or a track added or removed), "other:<field>".
 */
export type EdlChange = { surface: string; path: string };

const IDENTITY_FIELDS = new Set(["schema", "edlId", "variantOf"]);

function same(a: unknown, b: unknown): boolean {
  return canonicalJson({ value: a }) === canonicalJson({ value: b });
}

/** A clip split into its timing and the rest of it. A change in the first is a timing change; in the second, a visual change. */
function clipKey(clip: EdlClip): { startMs: number; endMs: number; rest: Omit<EdlClip, "startMs" | "endMs"> } {
  const { startMs, endMs, ...rest } = clip;
  return { startMs, endMs, rest };
}

/** The changed parts of `variant` against `master`. An identical EDL gives an empty list. Pure. */
export function diffEdl(master: EditDecisionList, variant: EditDecisionList): EdlChange[] {
  const changes: EdlChange[] = [];
  const add = (surface: string, path: string): void => {
    changes.push({ surface, path });
  };

  const topKeys = new Set([...Object.keys(master), ...Object.keys(variant)]);
  for (const key of [...topKeys].sort()) {
    if (IDENTITY_FIELDS.has(key) || key === "tracks" || key === "audio" || key === "effects") continue;
    if (!same((master as Record<string, unknown>)[key], (variant as Record<string, unknown>)[key])) add(`other:${key}`, key);
  }

  for (const field of ["voice", "music", "sfx", "masterLufs"] as const) {
    const surface = field === "masterLufs" ? "other:audio.masterLufs" : field;
    if (!same(master.audio[field], variant.audio[field])) add(surface, `audio.${field}`);
  }

  if (!same(master.effects, variant.effects)) add("effects", "effects");

  const masterLayers = new Map(master.tracks.map((track) => [track.layer, track]));
  const variantLayers = new Map(variant.tracks.map((track) => [track.layer, track]));
  for (const layer of [...new Set([...masterLayers.keys(), ...variantLayers.keys()])].sort()) {
    const a = masterLayers.get(layer);
    const b = variantLayers.get(layer);
    if (a === undefined || b === undefined) {
      add(`structure:${layer}`, `tracks.${layer}`);
      continue;
    }
    if (layer === "captions") {
      if (!same(a.clips, b.clips)) add("captions", "tracks.captions");
      continue;
    }
    const aClips = new Map(a.clips.map((clip) => [clip.clipId, clip]));
    const bClips = new Map(b.clips.map((clip) => [clip.clipId, clip]));
    for (const id of [...new Set([...aClips.keys(), ...bClips.keys()])].sort()) {
      const x = aClips.get(id);
      const y = bClips.get(id);
      if (x === undefined || y === undefined) {
        add(`structure:${layer}`, `tracks.${layer}.${id}`);
        continue;
      }
      const left = clipKey(x);
      const right = clipKey(y);
      if (left.startMs !== right.startMs || left.endMs !== right.endMs) add(`timing:${id}`, `tracks.${layer}.${id}`);
      if (!same(left.rest, right.rest)) add(`visual:${id}`, `tracks.${layer}.${id}`);
    }
  }
  return changes;
}

/** The result of checking a variant's changes against its attribute's control. */
export type ControlCheck = { pass: boolean; violations: string[] };

/**
 * The surfaces each attribute may change. caption and music change one surface and nothing else. product changes the takes of the
 * product shots only (visual surfaces for the given clips). hook, persona and language rebuild the EDL from the new voice and takes,
 * so they may change the voice, the captions, the effects, the timing and the structure, and the visual clips of the shots they
 * regenerate. A timing change without a voice change is a violation: nothing else moves the clock.
 */
export function checkControl(attribute: VariantAttribute, changes: readonly EdlChange[], workClipIds: ReadonlySet<string>): ControlCheck {
  const violations: string[] = [];
  const allowed = (change: EdlChange): boolean => {
    const { surface } = change;
    switch (attribute) {
      case "caption":
        return surface === "captions";
      case "music":
        return surface === "music";
      case "product":
        return surface.startsWith("visual:") && workClipIds.has(surface.slice("visual:".length));
      case "hook":
      case "persona":
      case "language":
        if (surface === "voice" || surface === "captions" || surface === "effects" || surface === "sfx") return true;
        if (surface.startsWith("timing:") || surface.startsWith("structure:")) return true;
        return surface.startsWith("visual:") && workClipIds.has(surface.slice("visual:".length));
    }
  };
  for (const change of changes) {
    if (!allowed(change)) violations.push(`${change.surface} (${change.path})`);
  }
  if (attribute === "hook" || attribute === "persona" || attribute === "language") {
    const moved = changes.some((change) => change.surface.startsWith("timing:") || change.surface.startsWith("structure:"));
    const voiceMoved = changes.some((change) => change.surface === "voice");
    if (moved && !voiceMoved) violations.push("timing changed without a voice change");
  }
  return { pass: violations.length === 0, violations };
}

/** The clips of the visual layers whose media is one of the given uris. Used to name the clips a product or a retake may change. */
export function clipIdsForUris(edl: EditDecisionList, uris: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const track of edl.tracks) {
    if (!(VISUAL_LAYERS as readonly string[]).includes(track.layer)) continue;
    for (const clip of track.clips) {
      if (clip.srcUri !== undefined && uris.has(clip.srcUri)) ids.add(clip.clipId);
    }
  }
  return ids;
}

/** The caption band of each caption clip is set to `band`, except a clip that overlaps a presenter clip: it keeps the master's band (the editor's face rule, Bible 8.2 step 9). */
export function withCaptionBand(master: EditDecisionList, band: CaptionBand): { edl: EditDecisionList; changedClips: number; keptClips: number } {
  const presenter = master.tracks.filter((track) => track.layer === "presenter").flatMap((track) => track.clips);
  let changedClips = 0;
  let keptClips = 0;
  const tracks = master.tracks.map((track) => {
    if (track.layer !== "captions") return track;
    const clips = track.clips.map((clip) => {
      const overPresenter = presenter.some((face) => face.startMs < clip.endMs && clip.startMs < face.endMs);
      if (overPresenter) {
        keptClips += 1;
        return clip;
      }
      if (clip.props?.band === band) return clip;
      changedClips += 1;
      return { ...clip, props: { ...(clip.props ?? {}), band } };
    });
    return { ...track, clips };
  });
  return { edl: { ...master, tracks }, changedClips, keptClips };
}

/** The music bed of the variant: the track's uri, under the whole timeline. The master's mix is kept when the master has music. */
export function withMusic(master: EditDecisionList, track: VariantMusicTrack, mix: { gainDb: number; duckDb: number } = variantMusicMix): EditDecisionList {
  if (track.durationMs < master.durationMs) {
    throw new EngineError("invalid_input", `music ${track.trackId} is ${track.durationMs} ms, shorter than the ${master.durationMs} ms timeline`, {
      stage: "variants",
    });
  }
  const current = master.audio.music;
  return {
    ...master,
    audio: {
      ...master.audio,
      music: {
        uri: track.uri,
        startMs: 0,
        endMs: master.durationMs,
        gainDb: current?.gainDb ?? mix.gainDb,
        duckDb: current?.duckDb ?? mix.duckDb,
      },
    },
  };
}

export type SourceReplacement = { fromUri: string; toUri: string; toDurationMs: number };

/**
 * Swaps the media of the visual clips that play `fromUri` for `toUri` (a retaken product shot, for example). A clip must fit in the new
 * take: its source offset plus its length may not pass the take's duration. Returns the uris of `fromUri` that no clip plays, so the
 * caller can refuse a replacement that did not land.
 */
export function withVisualSources(master: EditDecisionList, replacements: readonly SourceReplacement[]): { edl: EditDecisionList; unmatched: string[] } {
  const byFrom = new Map(replacements.map((replacement) => [replacement.fromUri, replacement]));
  const played = new Set<string>();
  const tracks = master.tracks.map((track) => {
    if (!(VISUAL_LAYERS as readonly string[]).includes(track.layer)) return track;
    const clips = track.clips.map((clip) => {
      const replacement = clip.srcUri === undefined ? undefined : byFrom.get(clip.srcUri);
      if (clip.srcUri === undefined || replacement === undefined) return clip;
      played.add(replacement.fromUri);
      const needed = (clip.srcInMs ?? 0) + (clip.endMs - clip.startMs);
      if (needed > replacement.toDurationMs) {
        throw new EngineError(
          "invalid_input",
          `the take ${replacement.toUri} is ${replacement.toDurationMs} ms, too short for clip ${clip.clipId} (needs ${needed} ms)`,
          { stage: "variants" },
        );
      }
      return { ...clip, srcUri: replacement.toUri };
    });
    return { ...track, clips };
  });
  const unmatched = replacements.map((replacement) => replacement.fromUri).filter((uri) => !played.has(uri));
  return { edl: { ...master, tracks }, unmatched };
}

/** The EDL id of a variant: a hash of the master EDL and the variant key, so a retried job names the same EDL (Bible 5.1). */
export function variantEdlId(masterEdlId: string, key: string): string {
  const hex = contentHash({ variantOf: masterEdlId, key }).slice("sha256:".length, "sha256:".length + 20);
  return `${VARIANT_EDL_PREFIX}${encodeUlid(0, BigInt(`0x${hex}`))}`;
}

/** The variant EDL: the transformed EDL with its own id and variantOf set to the master, checked against the EDL contract. */
export function asVariant(master: EditDecisionList, edl: EditDecisionList, key: string): { ok: true; edl: EditDecisionList } | { ok: false; reason: string } {
  const candidate = { ...edl, edlId: variantEdlId(master.edlId, key), variantOf: master.edlId };
  const parsed = edlSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the variant EDL is not valid: ${issue ? issue.path.join(".") || "value" : "unknown"} ${issue?.message ?? ""}`.trim() };
  }
  return { ok: true, edl: parsed.data };
}

export type RerenderBuild =
  | { status: "built"; edl: EditDecisionList; changes: EdlChange[] }
  | { status: "not_built"; reason: string };

/**
 * Builds the EDL of a re-render-only variant (caption or music) from the master, then checks it: the variant EDL must be valid, must
 * differ from the master (a no-op variant is not built), and must change only the surface its attribute allows. Pure.
 */
export function buildRerenderVariant(master: EditDecisionList, variant: PlannedVariant, mix: { gainDb: number; duckDb: number } = variantMusicMix): RerenderBuild {
  if (variant.build !== "rerender") return { status: "not_built", reason: "needs_generation" };
  let edl: EditDecisionList;
  if (variant.change.kind === "caption") {
    const applied = withCaptionBand(master, variant.change.band);
    if (applied.changedClips === 0) return { status: "not_built", reason: "no_change" };
    edl = applied.edl;
  } else if (variant.change.kind === "music") {
    try {
      edl = withMusic(master, variant.change.track, mix);
    } catch (error) {
      return { status: "not_built", reason: error instanceof Error ? error.message : "the music could not be placed" };
    }
  } else {
    return { status: "not_built", reason: "not_a_rerender_attribute" };
  }
  const asVariantResult = asVariant(master, edl, variant.key);
  if (!asVariantResult.ok) return { status: "not_built", reason: asVariantResult.reason };
  const changes = diffEdl(master, asVariantResult.edl);
  const control = checkControl(variant.attribute, changes, new Set<string>());
  if (!control.pass) return { status: "not_built", reason: `the variant changes more than its control: ${control.violations.join("; ")}` };
  if (changes.length === 0) return { status: "not_built", reason: "no_change" };
  return { status: "built", edl: asVariantResult.edl, changes };
}
