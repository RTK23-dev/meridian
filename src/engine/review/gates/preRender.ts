// The pre_render gate (Bible 6.10, 12.3). It runs on the composition and the EDL before any money is spent on a render. Pure: every
// input is passed in as data, and the gate never reads a store or the network. It returns the GateResult the orchestrator routes.
//
// What it checks, in order: the style kit the request names, every EDL rule (edit/rules.ts checkEdl: cuts, lengths, captions, safe
// zones, loudness, black frames, shot types, the hook, sources and the compiler's own limits), the composition built from this EDL,
// slideshow risk (review/slideshowRisk.ts), the delivery promise (each script beat is covered, every planned shot reaches the EDL,
// and each product shot uses real imagery), caption legibility (words per caption within configuration), the AI-presenter
// disclosure flag, rights (every media URI has a licence record), and the budget left for the render.
//
// Missing evidence is never a pass (Bible 12): an input the caller did not give fails its check with "not evaluated". Only the
// gold-set rule (gold.ts decideGate) lets a failure block; until a check's gold set meets the target its failure goes to review.

import { z } from "zod";
import { thresholds } from "../../config/thresholds.ts";
import {
  compositionSchema,
  edlSchema,
  scenePlanSchema,
  styleKitSchema,
  takeSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type EditDecisionList,
  type GateCheck,
  type GateResult,
} from "../../contracts/index.ts";
import { checkEdl, shotIdOf, type RuleContext } from "../../edit/rules.ts";
import type { ScriptBody } from "../../script/resolve.ts";
import { check, asShotIds, gateResult, notEvaluated } from "./common.ts";
import { shotUsesProductImagery } from "./plan.ts";
import { slideshowRisk } from "../slideshowRisk.ts";

/** The render budget the request has left, and the render's estimate. A null estimate means the price is not in the table (unknown). */
export type RenderBudgetInput = { remainingUsd: number; renderEstimateUsd: number | null };

export type PreRenderInput = {
  /** The EDL (edl artifact). Parsed here. */
  edl: unknown;
  /** The composition built from the EDL (composition artifact). Parsed here. */
  composition: unknown;
  /** The scene plan the EDL was cut from. Parsed here. */
  plan: unknown;
  /** The validated request: the visual requests and the kit references. Parsed here. */
  validated: unknown;
  /** The words the video speaks: the request's script, or a brief's written script (script/resolve.ts). Its beats are checked here. */
  script: ScriptBody;
  /** The voice track the EDL was timed on. Parsed here. */
  voice: unknown;
  /** The reference's video DNA, for the edit grammar. Parsed here. */
  dna: unknown;
  /** The accepted take of each generated or stock shot. Parsed here. */
  takes: readonly unknown[];
  /** The style kit as loaded, or undefined when it did not load. A kit that is not the one the request names fails the gate. */
  styleKit: unknown | undefined;
  /** Real imagery URIs of the product kit (hero images and cutouts). Undefined when no product kit was resolved. */
  productImageUris: readonly string[] | undefined;
  /** The AI-presenter disclosure the manifest will carry (Bible 6.14). Undefined when it is not known. The wording is open (20.2). */
  disclosures: { aiGeneratedPeople: boolean } | undefined;
  /** The media URIs that have a licence record for commercial social use (Bible 12.3, rights). Undefined when no record source is set. */
  licensedUris: ReadonlySet<string> | undefined;
  /** The budget left for the render, and its estimate. Undefined when the budget is not connected. */
  renderBudget: RenderBudgetInput | undefined;
};

const captionsPropsSchema = z.object({ captions: z.array(z.object({ words: z.array(z.unknown()) })) });

/** Every media URI the EDL draws or plays: clip sources, the voice, the music and each sound effect. */
export function mediaUrisOf(edl: EditDecisionList): string[] {
  const uris: string[] = [];
  for (const track of edl.tracks) {
    for (const clip of track.clips) {
      if (clip.srcUri !== undefined) uris.push(clip.srcUri);
    }
  }
  uris.push(edl.audio.voice.uri);
  if (edl.audio.music !== undefined) uris.push(edl.audio.music.uri);
  for (const sfx of edl.audio.sfx) uris.push(sfx.uri);
  return [...new Set(uris)];
}

/** Words per caption of every caption on the captions track, and the count of caption clips whose props do not read. */
export function captionWordCounts(edl: EditDecisionList): { counts: number[]; unreadable: number } {
  const counts: number[] = [];
  let unreadable = 0;
  for (const track of edl.tracks) {
    if (track.layer !== "captions") continue;
    for (const clip of track.clips) {
      const parsed = captionsPropsSchema.safeParse(clip.props);
      if (!parsed.success) {
        unreadable += 1;
        continue;
      }
      for (const caption of parsed.data.captions) counts.push(caption.words.length);
    }
  }
  return { counts, unreadable };
}

function schemaProblem(name: string, error: z.ZodError): string {
  const issue = error.issues[0];
  return `${name}: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "does not parse"}`;
}

/** The pre_render gate. Returns the GateResult for the orchestrator (gate "pre_render", subject the EDL id). */
export function checkPreRender(input: PreRenderInput): GateResult {
  const edlParsed = edlSchema.safeParse(input.edl);
  const compositionParsed = compositionSchema.safeParse(input.composition);
  const planParsed = scenePlanSchema.safeParse(input.plan);
  const validatedParsed = validatedRequestSchema.safeParse(input.validated);
  const voiceParsed = voiceTrackSchema.safeParse(input.voice);
  const dnaParsed = videoDnaSchema.safeParse(input.dna);
  const takesParsed = z.array(takeSchema).safeParse(input.takes);
  const subjectId = edlParsed.success ? edlParsed.data.edlId : "edl:unparsed";

  if (!edlParsed.success || !compositionParsed.success || !planParsed.success || !validatedParsed.success || !voiceParsed.success || !dnaParsed.success || !takesParsed.success) {
    const problems: string[] = [];
    if (!edlParsed.success) problems.push(schemaProblem("edl", edlParsed.error));
    if (!compositionParsed.success) problems.push(schemaProblem("composition", compositionParsed.error));
    if (!planParsed.success) problems.push(schemaProblem("plan", planParsed.error));
    if (!validatedParsed.success) problems.push(schemaProblem("validated request", validatedParsed.error));
    if (!voiceParsed.success) problems.push(schemaProblem("voice", voiceParsed.error));
    if (!dnaParsed.success) problems.push(schemaProblem("video DNA", dnaParsed.error));
    if (!takesParsed.success) problems.push(schemaProblem("takes", takesParsed.error));
    return gateResult("pre_render", subjectId, [
      check("schema_valid", false, { detail: problems.join("; ") }),
      notEvaluated("edl_rules", "an input does not parse"),
    ]);
  }

  const edl = edlParsed.data;
  const composition = compositionParsed.data;
  const plan = planParsed.data;
  const validated = validatedParsed.data;
  const voice = voiceParsed.data;
  const dna = dnaParsed.data;
  const takes = takesParsed.data;
  const checks: GateCheck[] = [];
  const failing: string[] = [];

  // 1. The style kit: the one the request names, loaded (edit gate's style_kit_loaded, repeated here before any render).
  const kitRef = validated.kits.styleKit;
  let outroMs: number | undefined;
  if (input.styleKit === undefined) {
    checks.push(check("style_kit_matches_request", false, { detail: `style kit ${kitRef.id} version ${kitRef.version} did not load` }));
  } else {
    const kitParsed = styleKitSchema.safeParse(input.styleKit);
    if (!kitParsed.success) {
      checks.push(check("style_kit_matches_request", false, { detail: schemaProblem("style kit", kitParsed.error) }));
    } else if (kitParsed.data.styleKitId !== kitRef.id || kitParsed.data.version !== kitRef.version) {
      checks.push(
        check("style_kit_matches_request", false, {
          detail: `style kit ${kitParsed.data.styleKitId} version ${kitParsed.data.version} is not the one the request names (${kitRef.id} version ${kitRef.version})`,
        }),
      );
    } else {
      checks.push(check("style_kit_matches_request", true));
      outroMs = kitParsed.data.outroMs;
    }
  }

  // 2. Every EDL rule (Bible 8.3, with the checks 8.2 implies). The same function the edit stage runs, so both stages agree.
  const ctx: RuleContext = {
    words: voice.words,
    grammar: dna.editGrammar,
    shots: plan.shots,
    takes,
    voice: { durationMs: voice.durationMs, lufs: voice.lufs },
    ...(outroMs === undefined ? {} : { outroMs }),
  };
  const edlVerdict = checkEdl(edl, ctx);
  for (const rule of edlVerdict.checks) {
    checks.push(check(rule.rule, rule.pass, { value: rule.value, limit: rule.limit, detail: rule.detail }));
  }
  failing.push(...edlVerdict.failingShotIds);

  // 3. The composition is the one built from this EDL, and it carries every media URI the EDL uses (Bible 9.1).
  const uris = mediaUrisOf(edl);
  const composed = new Set(composition.assetUris);
  const notInComposition = uris.filter((uri) => !composed.has(uri));
  const sameEdl = composition.edlId === edl.edlId;
  checks.push(
    check("composition_matches_edl", sameEdl && notInComposition.length === 0, {
      value: notInComposition.length,
      limit: 0,
      detail: !sameEdl
        ? `the composition is for ${composition.edlId}, not ${edl.edlId}`
        : notInComposition.length > 0
          ? `${notInComposition.length} media URI(s) of the EDL are not in the composition`
          : undefined,
    }),
  );

  // 4. Slideshow risk (Bible 12.3): the coded-run rule and the weighted mean, from the plan, the EDL and the script.
  const slide = slideshowRisk({ shots: plan.shots, edl, beats: input.script.beats });
  checks.push(...slide.checks);
  failing.push(...slide.failingShotIds);

  // 5. Delivery promise (Bible 12.3): what the plan promised is in the cut.
  const beats = input.script.beats;
  const shotBeats = new Set(plan.shots.map((shot) => shot.beatId));
  const uncovered = beats.filter((beat) => !shotBeats.has(beat.beatId)).map((beat) => beat.beatId);
  checks.push(
    check("promised_beats_covered", uncovered.length === 0, {
      value: uncovered.length,
      limit: 0,
      detail: uncovered.length === 0 ? undefined : `no shot covers beat(s) ${uncovered.join(", ")}`,
    }),
  );
  const placed = new Set(edl.tracks.flatMap((track) => track.clips.map((clip) => shotIdOf(clip.clipId))));
  const dropped = plan.shots.filter((shot) => !placed.has(shot.shotId)).map((shot) => shot.shotId);
  checks.push(
    check("promised_shots_in_edl", dropped.length === 0, {
      value: dropped.length,
      limit: 0,
      detail: dropped.length === 0 ? undefined : `the EDL has no clip for planned shot(s) ${dropped.join(", ")}`,
    }),
  );
  failing.push(...dropped);
  const productShots = plan.shots.filter((shot) => shot.visualType === "product_hero");
  if (productShots.length === 0) {
    checks.push(check("product_shots_real_imagery", true, { detail: "the plan has no product shot" }));
  } else if (input.productImageUris === undefined) {
    checks.push(notEvaluated("product_shots_real_imagery", "no product kit was resolved, so the product imagery is unknown"));
  } else {
    const real = input.productImageUris;
    const fake = productShots.filter((shot) => !shotUsesProductImagery(shot, real)).map((shot) => shot.shotId);
    checks.push(
      check("product_shots_real_imagery", fake.length === 0, {
        value: fake.length,
        limit: 0,
        detail: fake.length === 0 ? undefined : `product shot(s) ${fake.join(", ")} do not use the product's real imagery`,
      }),
    );
    failing.push(...fake);
  }

  // 6. Caption legibility from configuration: each caption holds as many words as the legibility limit allows (Bible 8.3).
  const captions = captionWordCounts(edl);
  const minWords = thresholds.edit.captionWordsMin;
  const maxWords = thresholds.edit.captionWordsMax;
  const tooFew = captions.counts.filter((count) => count < minWords).length;
  const tooMany = captions.counts.filter((count) => count > maxWords).length;
  checks.push(
    check("caption_words_legible", captions.unreadable === 0 && tooFew + tooMany === 0, {
      value: tooFew + tooMany + captions.unreadable,
      limit: 0,
      detail:
        captions.unreadable > 0
          ? `${captions.unreadable} caption clip(s) have no readable props`
          : tooFew + tooMany === 0
            ? `${captions.counts.length} captions, each ${minWords} to ${maxWords} words`
            : `${tooFew + tooMany} caption(s) outside ${minWords} to ${maxWords} words`,
    }),
  );

  // 7. AI-presenter disclosure (Bible 6.14, 13): an AI presenter on screen needs its flag. The wording is open (Bible 20.2).
  const aiPeople = plan.shots.some((shot) => shot.visualType === "ugc_presenter");
  if (!aiPeople) {
    checks.push(check("disclosure_ai_people", true, { detail: "no AI presenter is in the plan" }));
  } else if (input.disclosures === undefined) {
    checks.push(notEvaluated("disclosure_ai_people", "the disclosure flags are not known"));
  } else {
    checks.push(
      check("disclosure_ai_people", input.disclosures.aiGeneratedPeople === true, {
        detail: input.disclosures.aiGeneratedPeople === true ? undefined : "an AI presenter appears, and the AI-people disclosure flag is not set",
      }),
    );
  }

  // 8. Rights (Bible 12.3): every media URI has a licence record for commercial social use.
  if (input.licensedUris === undefined) {
    checks.push(notEvaluated("rights_licensed", "no licence record source is connected"));
  } else {
    const licensed = input.licensedUris;
    const unlicensed = uris.filter((uri) => !licensed.has(uri));
    checks.push(
      check("rights_licensed", unlicensed.length === 0, {
        value: unlicensed.length,
        limit: 0,
        detail: unlicensed.length === 0 ? undefined : `${unlicensed.length} media URI(s) have no licence record`,
      }),
    );
  }

  // 9. Budget left for the render (Bible 12.3, 14). An unknown price fails: the render cannot be priced.
  if (input.renderBudget === undefined) {
    checks.push(notEvaluated("render_budget_covers_render", "the budget for the render is not connected"));
  } else if (input.renderBudget.renderEstimateUsd === null) {
    checks.push(
      check("render_budget_covers_render", false, {
        value: input.renderBudget.remainingUsd,
        detail: "the render price is not in the table (null), so the render cannot be priced",
      }),
    );
  } else {
    const { remainingUsd, renderEstimateUsd } = input.renderBudget;
    checks.push(
      check("render_budget_covers_render", remainingUsd >= renderEstimateUsd, {
        value: remainingUsd,
        limit: renderEstimateUsd,
        detail: remainingUsd >= renderEstimateUsd ? undefined : `${remainingUsd} USD left, the render needs ${renderEstimateUsd} USD`,
      }),
    );
  }

  return gateResult("pre_render", edl.edlId, checks, asShotIds(failing));
}

/** The rule names this gate reports, for a caller that wants the full list when the input is refused. */
export const PRE_RENDER_RULE_NAMES = [
  "style_kit_matches_request",
  "composition_matches_edl",
  "slideshow_coded_run",
  "slideshow_risk_below_max",
  "promised_beats_covered",
  "promised_shots_in_edl",
  "product_shots_real_imagery",
  "caption_words_legible",
  "disclosure_ai_people",
  "rights_licensed",
  "render_budget_covers_render",
] as const;
