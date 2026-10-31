// The `plan` gate (Bible 12.1 and 6.10). It runs before any generation is paid for. Pure: it reads the scene plan, the
// voice track, the request and the product imagery, and returns a GateResult. It never reads a store.
// A failing check names the shots at fault in failingShotIds, so only those go back to plan or produce_shot (6.10).

import { thresholds } from "../../config/thresholds.ts";
import {
  chainInputsOf,
  EngineError,
  productionRequestSchema,
  scenePlanSchema,
  voiceTrackSchema,
  type GateCheck,
  type GateResult,
  type ProductionRequest,
  type ScenePlan,
  type ShotSpec,
  type VoiceTrack,
} from "../../contracts/index.ts";
import { estimatePlan, UnknownPriceError } from "../../budget/estimate.ts";
import { usdAtMost, usdUnits } from "../../plan/cost.ts";
import { mustAllowedTypes } from "../../plan/filter.ts";
import { visualPropertySchema } from "../../plan/tables.ts";
import { promptAsksForText } from "./promptText.ts";
import { check, EDL_FPS, gateResult, notEvaluated, stringsIn } from "./common.ts";
import { hookTimingOf } from "./hookTiming.ts";
import type { VisualClassification } from "./request.ts";

export type PlanGateInput = {
  /** The ScenePlan. Parsed here. */
  plan: unknown;
  /** The VoiceTrack the plan tiles. Parsed here. */
  voice: unknown;
  /** The ProductionRequest: its visual requests and its budget. Parsed here. */
  request: unknown;
  /** The classification of every visual request (7.3). */
  classifications: readonly VisualClassification[];
  /** The URIs of the product kit's hero images and cutouts (13). Undefined when no product kit was resolved. */
  productImageUris: readonly string[] | undefined;
  /** Beats the 7.2 flag marks as showing the product, in addition to beats with a real_product request. */
  productBeatIds?: readonly string[];
};

const RULES = [
  "shots_tile_voice_duration",
  "must_classified",
  "must_satisfied",
  "no_text_in_generation_prompts",
  "product_beats_use_real_imagery",
  "generated_shots_have_downgrade",
  "estimate_within_budget",
  "estimated_usd_matches_shots",
] as const;

/** The prompts a shot sends to a generation model: its own prompt, or one per call of a chain (contract v5). */
export function generationPromptsOf(shot: ShotSpec): string[] {
  const source = shot.source;
  if (source.kind === "generate") return [source.prompt];
  if (source.kind === "chain") return source.calls.map((call) => call.prompt);
  return [];
}

/** Does a shot make its pixels with a paid model call: a generate shot, or a chain of them (contract v5)? */
export function isGeneratedShot(shot: ShotSpec): boolean {
  return shot.source.kind === "generate" || shot.source.kind === "chain";
}

/** Does this shot put real product imagery on screen? A generated shot pins or refers to a product URI; a component names one in its props. */
export function shotUsesProductImagery(shot: ShotSpec, uris: readonly string[]): boolean {
  const source = shot.source;
  switch (source.kind) {
    case "generate": {
      const frames = [source.firstFrame, source.lastFrame, ...source.refs].filter(
        (uri): uri is string => uri !== undefined,
      );
      return frames.some((uri) => uris.includes(uri));
    }
    case "component":
      return stringsIn(source.props).some((text) => uris.includes(text));
    case "asset":
      return uris.includes(source.assetUri);
    case "chain":
      return source.calls.some((call) =>
        chainInputsOf(call).some((input) => input.kind === "asset" && uris.includes(input.uri)),
      );
    case "stock":
      return false;
  }
}

/** A classification is usable when it has at least one property and every property is a known one. */
function usableClassification(classification: VisualClassification | undefined): classification is VisualClassification {
  return (
    classification !== undefined &&
    classification.properties.length > 0 &&
    classification.properties.every((property) => visualPropertySchema.safeParse(property).success)
  );
}

/** The beats that show the product: a real_product request on the beat, or a beat the caller marks (7.2 rule 2). */
function productBeatIdsOf(
  request: ProductionRequest,
  classifications: readonly VisualClassification[],
  extra: readonly string[],
): Set<string> {
  const beats = new Set<string>(extra);
  for (const item of request.visualRequests) {
    const classification = classifications.find((entry) => entry.beatId === item.beatId && entry.want === item.want);
    if (classification !== undefined && classification.properties.includes("real_product")) {
      beats.add(item.beatId);
    }
  }
  return beats;
}

/** The shot tiling check (12.1). Returns the problems, the worst error in ms and the shots at each bad boundary. */
function tilingOf(shots: readonly ShotSpec[], voiceMs: number, toleranceMs: number) {
  const sorted = [...shots].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const problems: string[] = [];
  const bad = new Set<string>();
  if (sorted.length === 0) {
    // A plan with no shots covers nothing: it fails, and there is no shot to name.
    return { problems: [`the plan has no shots for a ${voiceMs} ms voice`], worst: voiceMs, bad };
  }
  let worst = Math.abs(sorted[0].startMs);
  if (Math.abs(sorted[0].startMs) > toleranceMs) {
    problems.push(`the first shot starts at ${sorted[0].startMs} ms, not 0`);
    bad.add(sorted[0].shotId);
  }
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const error = current.startMs - previous.endMs;
    worst = Math.max(worst, Math.abs(error));
    if (Math.abs(error) > toleranceMs) {
      problems.push(
        error > 0 ? `a gap of ${error} ms after ${previous.shotId}` : `an overlap of ${-error} ms at ${current.shotId}`,
      );
      bad.add(previous.shotId);
      bad.add(current.shotId);
    }
  }
  const last = sorted[sorted.length - 1];
  const endError = voiceMs - last.endMs;
  worst = Math.max(worst, Math.abs(endError));
  if (Math.abs(endError) > toleranceMs) {
    problems.push(`the last shot ends at ${last.endMs} ms, the voice at ${voiceMs} ms`);
    bad.add(last.shotId);
  }
  return { problems, worst, bad };
}

export function checkPlan(input: PlanGateInput): GateResult {
  const parsedPlan = scenePlanSchema.safeParse(input.plan);
  const parsedVoice = voiceTrackSchema.safeParse(input.voice);
  const parsedRequest = productionRequestSchema.safeParse(input.request);
  const subjectId = parsedPlan.success ? parsedPlan.data.planId : "plan:unparsed";

  if (!parsedPlan.success || !parsedVoice.success || !parsedRequest.success) {
    const parts: string[] = [];
    if (!parsedPlan.success) {
      parts.push(`plan: ${parsedPlan.error.message}`);
    }
    if (!parsedVoice.success) {
      parts.push(`voice: ${parsedVoice.error.message}`);
    }
    if (!parsedRequest.success) {
      parts.push(`request: ${parsedRequest.error.message}`);
    }
    const checks: GateCheck[] = [check("schema_valid", false, { detail: parts.join("; ") })];
    for (const rule of RULES) {
      checks.push(notEvaluated(rule, "an input does not parse"));
    }
    return gateResult("plan", subjectId, checks);
  }

  const plan: ScenePlan = parsedPlan.data;
  const voice: VoiceTrack = parsedVoice.data;
  const request = parsedRequest.data;
  const shots = plan.shots;
  const failing = new Set<string>();
  const checks: GateCheck[] = [check("schema_valid", true)];

  // Tiling (12.1): shots cover the voice from 0 to its end, with no gap or overlap of more than one frame.
  const toleranceMs = thresholds.plan.shotTilingToleranceFrames * (1000 / EDL_FPS);
  const tiling = tilingOf(shots, voice.durationMs, toleranceMs);
  checks.push(
    check("shots_tile_voice_duration", tiling.problems.length === 0, {
      value: tiling.worst,
      limit: toleranceMs,
      detail:
        tiling.problems.length === 0
          ? "shots tile the voice with no gap or overlap over one frame"
          : tiling.problems.join("; "),
    }),
  );
  tiling.bad.forEach((id) => failing.add(id));

  // Must requests (7.3): each must is classified, and every shot of its beat is one the must allows and says it satisfies.
  const musts = request.visualRequests.filter((item) => item.strength === "must");
  const classificationProblems: string[] = [];
  const mustProblems: string[] = [];
  for (const must of musts) {
    const classification = input.classifications.find(
      (entry) => entry.beatId === must.beatId && entry.want === must.want,
    );
    if (!usableClassification(classification)) {
      classificationProblems.push(`must "${must.want}" has no usable classification`);
      mustProblems.push(`must "${must.want}" cannot be checked`);
      continue;
    }
    const allowed = mustAllowedTypes([{ strength: "must", want: must.want, properties: classification.properties }]) ?? [];
    const beatShots = shots.filter((shot) => shot.beatId === must.beatId);
    if (beatShots.length === 0) {
      mustProblems.push(`no shot covers beat ${must.beatId} for must "${must.want}"`);
    }
    for (const shot of beatShots) {
      const satisfied = allowed.includes(shot.visualType) && (shot.mustSatisfy ?? "").includes(must.want);
      if (!satisfied) {
        failing.add(shot.shotId);
        mustProblems.push(`${shot.shotId} (${shot.visualType}) does not satisfy must "${must.want}"`);
      }
    }
  }
  const mustCount = `${musts.length} must requests`;
  checks.push(
    check("must_classified", classificationProblems.length === 0, {
      detail: classificationProblems.length === 0 ? `${mustCount} classified` : classificationProblems.join("; "),
    }),
  );
  checks.push(
    check("must_satisfied", mustProblems.length === 0, {
      detail: mustProblems.length === 0 ? `${mustCount} satisfied` : mustProblems.join("; "),
    }),
  );

  // No text to render in a generation prompt (12.1, 7.2 rule 3). Every call of a chain (contract v5) is a generation prompt.
  const textProblems: string[] = [];
  for (const shot of shots) {
    for (const prompt of generationPromptsOf(shot)) {
      const finding = promptAsksForText(prompt);
      if (finding.asksForText) {
        failing.add(shot.shotId);
        textProblems.push(`${shot.shotId} asks for text (${finding.cues.join(", ")})`);
        break;
      }
    }
  }
  checks.push(
    check("no_text_in_generation_prompts", textProblems.length === 0, {
      detail: textProblems.length === 0 ? "no generation prompt asks for rendered text" : textProblems.join("; "),
    }),
  );

  // Product beats use real imagery (12.1): each product beat has at least one shot that shows a product URI.
  const productBeats = productBeatIdsOf(request, input.classifications, input.productBeatIds ?? []);
  const imageProblems: string[] = [];
  if (productBeats.size > 0 && input.productImageUris === undefined) {
    imageProblems.push("the product kit is missing, so real imagery cannot be checked");
  } else {
    const uris = input.productImageUris ?? [];
    for (const beatId of [...productBeats].sort()) {
      const beatShots = shots.filter((shot) => shot.beatId === beatId);
      if (beatShots.length === 0) {
        imageProblems.push(`product beat ${beatId} has no shot`);
      } else if (!beatShots.some((shot) => shotUsesProductImagery(shot, uris))) {
        imageProblems.push(`product beat ${beatId} uses no real product imagery`);
        beatShots.forEach((shot) => failing.add(shot.shotId));
      }
    }
  }
  checks.push(
    check("product_beats_use_real_imagery", imageProblems.length === 0, {
      detail:
        imageProblems.length > 0
          ? imageProblems.join("; ")
          : `${productBeats.size} product beats checked`,
    }),
  );

  // Every generated shot names its fallback (6.4 step 5). A chain (contract v5) is generated.
  const withoutDowngrade = shots.filter((shot) => isGeneratedShot(shot) && shot.downgradeTo === undefined);
  withoutDowngrade.forEach((shot) => failing.add(shot.shotId));
  checks.push(
    check("generated_shots_have_downgrade", withoutDowngrade.length === 0, {
      detail:
        withoutDowngrade.length === 0
          ? "every generated shot has a downgrade"
          : `no downgradeTo on ${withoutDowngrade.map((shot) => shot.shotId).join(", ")}`,
    }),
  );

  // Budget (12.1, 14.1): the reservation this plan would make must fit the request budget.
  const budgetUsd = request.constraints.budgetUsd;
  let estimate: ReturnType<typeof estimatePlan> | undefined;
  try {
    estimate = estimatePlan(plan);
  } catch (error) {
    if (!(error instanceof EngineError)) {
      throw error;
    }
    if (error instanceof UnknownPriceError) {
      failing.add(error.shotId);
    }
    checks.push(check("estimate_within_budget", false, { detail: `the estimate refused: ${error.message}` }));
    checks.push(notEvaluated("estimated_usd_matches_shots", "the estimate refused"));
  }
  if (estimate !== undefined) {
    const fits = usdAtMost(estimate.reservedUsd, budgetUsd);
    checks.push(
      check("estimate_within_budget", fits, {
        value: estimate.reservedUsd,
        limit: budgetUsd,
        detail: fits ? undefined : `the plan reserves ${estimate.reservedUsd} USD, above the budget ${budgetUsd} USD`,
      }),
    );
    const matches = usdUnits(plan.estimatedUsd) === usdUnits(estimate.shotsUsd);
    checks.push(
      check("estimated_usd_matches_shots", matches, {
        value: plan.estimatedUsd,
        limit: estimate.shotsUsd,
        detail: matches ? undefined : `estimatedUsd ${plan.estimatedUsd} differs from the shots' ${estimate.shotsUsd}`,
      }),
    );
  }

  // Hook timing (research note, section 4): the proposition by the window, and a hook by the latest time.
  const hook = hookTimingOf(plan, request);
  checks.push(...hook.checks);
  hook.failingShotIds.forEach((id) => failing.add(id));

  const failingShotIds = shots.map((shot) => shot.shotId).filter((id) => failing.has(id));
  return gateResult("plan", plan.planId, checks, failingShotIds);
}
