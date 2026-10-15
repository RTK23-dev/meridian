// The manifest writer (Video Engine Bible 4.4 Manifest, v2 with roleCalls; 6.14; 16.3). It builds one delivered video's record from
// the artifacts, the decisions, the ledger, the role calls and the prompt versions of its request. Unknown values stay null or are
// left out: a shot with no take is not listed (it has no provider), a timing with no artifact is left out, and a role call whose
// answer never came back is not listed (the contract has no verdict for it; its cost is in the ledger and the event stream).
// A shot the EDL plays from media no take made is refused, because the manifest could not name its provider. The result is
// parsed against manifestSchema before it is returned, so a manifest that does not match its contract is never written.

import {
  canonicalJson,
  EngineError,
  manifestSchema,
  type CostBreakdown,
  type Decision,
  type EditDecisionList,
  type GateResult,
  type ManifestRoleCall,
  type Manifest,
  type ProductionRequest,
  type ScenePlan,
  type Take,
  type VideoDNA,
} from "../contracts/index.ts";

export type ManifestShot = Manifest["shots"][number];

/** The one video a manifest describes: its edit, its id, and the master it varies (null for the master). */
export type ManifestVideo = {
  videoId: string;
  edl: EditDecisionList;
  /** The master's video id for a variant. Null for the master. */
  variantOfVideoId: string | null;
};

export type ManifestInput = {
  video: ManifestVideo;
  request: ProductionRequest;
  dna: VideoDNA;
  plan: ScenePlan;
  /** Every take of the request. The shots of the video are named from the takes its EDL plays. */
  takes: readonly Take[];
  /** The gate results that belong to this video (see gatesFor). */
  gates: readonly GateResult[];
  /** The plan's decisions and the produce decisions, in order, without duplicates. */
  decisions: readonly Decision[];
  roleCalls: readonly ManifestRoleCall[];
  promptVersions: Record<string, string>;
  cost: CostBreakdown;
  disclosures: Manifest["disclosures"];
  timings: Record<string, number>;
};

const VISUAL_LAYERS = new Set(["base", "cutaway", "presenter", "graphics"]);

/** The shots of a video: one per shot whose take its EDL plays, in plan order. Components have no take and are not listed. */
export function shotsFor(edl: EditDecisionList, plan: ScenePlan, takes: readonly Take[]): ManifestShot[] {
  const takeByUri = new Map(takes.map((take) => [take.uri, take]));
  const attempts = new Map<string, number>();
  for (const take of takes) attempts.set(take.shotId, (attempts.get(take.shotId) ?? 0) + 1);
  const planned = new Map(plan.shots.map((shot) => [shot.shotId, shot]));

  const found = new Map<string, ManifestShot>();
  for (const track of edl.tracks) {
    if (!VISUAL_LAYERS.has(track.layer)) continue;
    for (const clip of track.clips) {
      if (clip.srcUri === undefined) continue;
      const take = takeByUri.get(clip.srcUri);
      if (take === undefined) {
        throw new EngineError(
          "invalid_input",
          `clip ${clip.clipId} plays media that no take of this request made, so the manifest cannot name its provider`,
          { stage: "deliver" },
        );
      }
      if (found.has(take.shotId)) continue;
      const shot = planned.get(take.shotId);
      if (shot === undefined) {
        throw new EngineError("invalid_input", `take ${take.takeId} belongs to shot ${take.shotId}, which the plan does not have`, { stage: "deliver" });
      }
      found.set(take.shotId, {
        shotId: shot.shotId,
        visualType: shot.visualType,
        takeId: take.takeId,
        provider: take.provider,
        model: take.model,
        attempts: attempts.get(take.shotId) ?? 1,
      });
    }
  }
  return plan.shots.flatMap((shot) => {
    const listed = found.get(shot.shotId);
    return listed === undefined ? [] : [listed];
  });
}

/**
 * The disclosure flags (Bible 12.3: "disclosure flags set when AI people appear"). aiGeneratedPeople is set when a generated shot of the
 * video is a presenter, a cinematic shot (which may show a person, so it is treated as one) or an avatar or lip-sync model. The wording
 * of the disclosure is an open owner question (Bible 20.2); this file carries the flags only. paidPartnership has no source in the
 * request, so it is passed in (the ports of the deliver stage), and when no answer is passed it is true: unknown is disclosed.
 */
export function disclosuresFor(
  shots: readonly ManifestShot[],
  plan: ScenePlan,
  paidPartnership: boolean | undefined,
): Manifest["disclosures"] {
  const listed = new Set(shots.map((shot) => shot.shotId));
  const aiGeneratedPeople = plan.shots.some(
    (shot) =>
      listed.has(shot.shotId) &&
      shot.source.kind === "generate" &&
      (shot.visualType === "ugc_presenter" || shot.visualType === "cinematic" || shot.source.modelClass === "avatar" || shot.source.modelClass === "lipsync"),
  );
  return { aiGeneratedPeople, paidPartnership: paidPartnership ?? true };
}

/** Milliseconds from the request to the first artifact of each type, and to the video's passing review (total). Integers, zero or more. */
export function timingsFor(
  artifacts: readonly { type: string; createdAt: string }[],
  requestCreatedAt: string,
  readyAt: string,
): Record<string, number> {
  const base = Date.parse(requestCreatedAt);
  const firstByType = new Map<string, number>();
  for (const artifact of artifacts) {
    const at = Date.parse(artifact.createdAt);
    if (!Number.isFinite(at)) continue;
    const seen = firstByType.get(artifact.type);
    if (seen === undefined || at < seen) firstByType.set(artifact.type, at);
  }
  const timings: Record<string, number> = {};
  for (const [type, at] of [...firstByType.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
    timings[type] = Math.max(0, Math.round(at - base));
  }
  timings.total = Math.max(0, Math.round(Date.parse(readyAt) - base));
  return timings;
}

/**
 * The gate results of one video. A gate about another video (its EDL, its composition or its render) is left out, and every other gate
 * is kept: the request's own gates (intake, DNA, voice, plan, budget, takes) apply to every video.
 */
export function gatesFor(gates: readonly GateResult[], owned: ReadonlySet<string>, ownedByOthers: ReadonlySet<string>): GateResult[] {
  return gates.filter((gate) => owned.has(gate.subjectId) || !ownedByOthers.has(gate.subjectId));
}

/** Builds the manifest of one video. Throws invalid_input or internal when the video cannot be described honestly. */
export function buildManifest(input: ManifestInput): Manifest {
  const shots = shotsFor(input.video.edl, input.plan, input.takes);
  const body = {
    schema: "meridian.manifest/v2",
    videoId: input.video.videoId,
    requestId: input.request.requestId,
    ...(input.video.variantOfVideoId === null ? {} : { variantOf: input.video.variantOfVideoId }),
    formatId: input.request.format.formatId,
    videoDnaId: input.dna.videoDnaId,
    genome: input.dna.genome,
    promptVersions: input.promptVersions,
    shots,
    gates: [...input.gates],
    decisions: [...input.decisions],
    cost: input.cost,
    disclosures: input.disclosures,
    timings: input.timings,
    roleCalls: [...input.roleCalls],
  };
  const parsed = manifestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError(
      "internal",
      `the manifest of ${input.video.videoId} does not match its contract: ${issue ? issue.path.map(String).join(".") || "value" : "unknown"} ${issue?.message ?? ""}`.trim(),
      { stage: "deliver" },
    );
  }
  return parsed.data;
}

/** Keeps the decisions that appear once. Two decisions are the same when every field is (the plan and the produce step can both name one). */
export function uniqueDecisions(decisions: readonly Decision[]): Decision[] {
  const seen = new Set<string>();
  const out: Decision[] = [];
  for (const decision of decisions) {
    const key = canonicalJson(decision);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decision);
  }
  return out;
}
