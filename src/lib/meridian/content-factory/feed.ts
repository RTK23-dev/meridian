/**
 * The decision feed of a Content Factory run: one card per engine step, in order, built from what the engine recorded for the request
 * (src/engine/api engineRequestFeed). Pure: it reads the feed and writes nothing.
 *
 * Nothing is invented. A step with no record says it has not started. A cost is shown as the ledger holds it: the estimate, the amount
 * reserved, and the bill. A bill is a number only when every paid call of the step has one; otherwise it is unknown, never 0. A model
 * is the shot's recorded choice (the shot spec's modelChoice, contract v7) when it exists; until then the card names the route the
 * shot is sent on, and says that it is the route, not a recorded choice.
 */
import type { EngineRequestFeed, EngineRequestStatus, FeedArtifact, FeedGate, FeedLedgerRow } from "../../../engine/api/index.ts";

export const CARD_IDS = ["reference_analysis", "plan", "model_choices", "script", "voice", "visuals", "edit", "render", "gates", "delivery"] as const;
export type CardId = (typeof CARD_IDS)[number];

export type CardStatus = "not_started" | "waiting" | "running" | "done" | "failed" | "needs_review" | "paused";

export type CardCost = {
  /** Paid calls the ledger holds for the step. */
  calls: number;
  /** Calls with no bill and no confirmation yet. */
  unsettled: number;
  estimateUsd: number | null;
  reservedUsd: number | null;
  /** The sum of the bills, or null when any call has none (or there is no call). Never an estimate. */
  billedUsd: number | null;
};

export type CardModel = { label: string; provider: string | null; model: string | null; basis: "chosen" | "route" | "used" };

export type FeedCard = {
  id: CardId;
  title: string;
  status: CardStatus;
  /** Why the step is in its status, in plain words. */
  statusText: string;
  inputs: string[];
  output: string[];
  /** Reasons the engine recorded: decisions and failing checks. */
  reasons: string[];
  models: CardModel[];
  /** Null for a step that is not a paid step of its own (its calls are counted under the step named in costNote). */
  cost: CardCost | null;
  costNote: string | null;
};

export type RunFeed = {
  requestId: string;
  status: EngineRequestStatus;
  /** True while the engine may still change something on its own, so the screen keeps polling. */
  active: boolean;
  headline: string;
  cards: FeedCard[];
  /** Every paid call of the request, including calls the ledger does not tie to one step (for example a Claude role call). */
  total: CardCost;
  unattributedCalls: number;
};

const CARD_TITLES: Record<CardId, string> = {
  reference_analysis: "Reference analysis",
  plan: "Plan",
  model_choices: "Model choices",
  script: "Script",
  voice: "Voice",
  visuals: "Visuals",
  edit: "Edit",
  render: "Render",
  gates: "Quality gates",
  delivery: "Delivery",
};

/** The engine stages each card stands for, and the gates it shows. */
const CARD_STAGES: Record<CardId, { stages: string[]; gates: string[] }> = {
  reference_analysis: { stages: ["analyze_reference"], gates: ["dna"] },
  plan: { stages: ["plan", "estimate_reserve"], gates: ["plan", "budget"] },
  model_choices: { stages: [], gates: [] },
  script: { stages: ["intake"], gates: ["request"] },
  voice: { stages: ["voice"], gates: ["voice"] },
  visuals: { stages: ["produce_shot", "check_take"], gates: ["take"] },
  edit: { stages: ["edit"], gates: ["edit"] },
  render: { stages: ["compose", "render"], gates: ["render_integrity"] },
  gates: { stages: ["pre_render_gate", "post_render_review"], gates: ["pre_render", "post_render"] },
  delivery: { stages: ["deliver", "variants"], gates: [] },
};

const BRANCH_ORDER = ["compose", "pre_render_gate", "render", "post_render_review", "done"];

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The cost of some ledger rows, as the ledger holds it. */
export function costOf(rows: readonly FeedLedgerRow[]): CardCost {
  if (rows.length === 0) return { calls: 0, unsettled: 0, estimateUsd: null, reservedUsd: null, billedUsd: null };
  const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 10_000) / 10_000;
  const unsettled = rows.filter((row) => row.settlement === null || row.actualUsd === null).length;
  return {
    calls: rows.length,
    unsettled,
    estimateUsd: sum(rows.map((row) => row.estimateUsd)),
    reservedUsd: sum(rows.map((row) => row.reservedUsd)),
    billedUsd: unsettled > 0 ? null : sum(rows.map((row) => row.actualUsd ?? 0)),
  };
}

/** A cost in plain words: "unknown" when there is no number. */
export function costLabel(value: number | null): string {
  return value === null ? "unknown" : usd(value);
}

function failingChecks(gates: readonly FeedGate[]): string[] {
  return gates.flatMap((gate) =>
    gate.pass ? [] : gate.checks.filter((check) => !check.pass).map((check) => `${gate.gate} gate: ${check.rule}${check.detail ? `: ${check.detail}` : ""}`),
  );
}

function jobState(feed: EngineRequestFeed, stages: readonly string[]): { running: boolean; queued: boolean; dead: boolean; succeeded: boolean } {
  const counts = stages.map((stage) => feed.jobs[stage]).filter((item) => item !== undefined);
  return {
    running: counts.some((item) => item.running > 0 || item.retry > 0),
    queued: counts.some((item) => item.queued > 0),
    dead: counts.some((item) => item.dead > 0),
    succeeded: counts.some((item) => item.succeeded > 0),
  };
}

function masterBranchAt(feed: EngineRequestFeed): number {
  const master = feed.branches.find((branch) => branch.variantOf === null && branch.status !== "superseded");
  return master ? BRANCH_ORDER.indexOf(master.stage) : -1;
}

/** Whether the card's work is complete, from the orchestrator's own state. */
function cardDone(id: CardId, feed: EngineRequestFeed, artifacts: readonly FeedArtifact[]): boolean {
  const passed = (node: string) => feed.nodes[node] === "passed";
  switch (id) {
    case "reference_analysis":
      return passed("analyze_reference");
    case "plan":
      return passed("plan") && passed("estimate_reserve");
    case "model_choices":
      return artifacts.some((artifact) => artifact.type === "scene_plan");
    case "script":
      return passed("intake");
    case "voice":
      return passed("voice");
    case "visuals": {
      const plan = [...artifacts].reverse().find((artifact) => artifact.type === "scene_plan");
      return plan?.type === "scene_plan" && plan.shots.length > 0 && plan.shots.every((shot) => shot.status === "accepted");
    }
    case "edit":
      return passed("edit");
    case "render":
      return masterBranchAt(feed) >= BRANCH_ORDER.indexOf("post_render_review");
    case "gates":
      return masterBranchAt(feed) === BRANCH_ORDER.indexOf("done");
    case "delivery":
      return feed.status.status === "delivered";
  }
}

function statusOf(id: CardId, feed: EngineRequestFeed): { status: CardStatus; text: string } {
  const { stages } = CARD_STAGES[id];
  const status = feed.status;
  if (status.status === "failed" && id === "script") return { status: "failed", text: "The engine refused the request at intake." };
  if (feed.pause && stages.includes(feed.pause.stage)) {
    if (feed.pause.kind === "escalation") return { status: "needs_review", text: `Sent to a person for review: ${feed.pause.reason}` };
    return { status: "paused", text: `Paused (${feed.pause.kind === "budget" ? "waiting on the budget" : "a job failed for good"}): ${feed.pause.reason}` };
  }
  const jobs = jobState(feed, stages);
  if (jobs.dead) return { status: "failed", text: "A job of this step failed after its last attempt." };
  if (cardDone(id, feed, feed.artifacts)) {
    if (id === "reference_analysis" && feed.cachedDna) return { status: "done", text: "The engine reused its stored analysis of this reference." };
    return { status: "done", text: "Done." };
  }
  if (jobs.running) return { status: "running", text: "Working now." };
  if (jobs.queued) return { status: "waiting", text: "Queued. The engine has not picked it up yet." };
  if (status.status === "failed") return { status: "not_started", text: "Not started: the request did not pass intake." };
  return { status: "not_started", text: "Not started yet." };
}

function latest<T extends FeedArtifact["type"]>(artifacts: readonly FeedArtifact[], type: T): Extract<FeedArtifact, { type: T }> | null {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact?.type === type) return artifact as Extract<FeedArtifact, { type: T }>;
  }
  return null;
}

function cardDetail(id: CardId, feed: EngineRequestFeed): Pick<FeedCard, "inputs" | "output" | "reasons" | "models"> {
  const artifacts = feed.artifacts;
  const request = latest(artifacts, "production_request");
  const plan = latest(artifacts, "scene_plan");
  const out: Pick<FeedCard, "inputs" | "output" | "reasons" | "models"> = { inputs: [], output: [], reasons: [], models: [] };
  switch (id) {
    case "reference_analysis": {
      if (request) out.inputs.push("The reference video you attached");
      const dna = latest(artifacts, "video_dna");
      if (dna) {
        out.output.push(`${dna.segments} segments over ${seconds(dna.durationMs)}, ${dna.transcriptWords} transcript words`);
        if (dna.genes.length > 0) out.output.push(`Genes named: ${dna.genes.join(", ")}`);
        if (dna.transferable.length > 0) out.output.push(`Transferable: ${dna.transferable.join(", ")}`);
        out.output.push(
          dna.sourceDeletedAt
            ? `The source media was deleted at ${dna.sourceDeletedAt}.`
            : "The engine has not recorded the deletion of the source media for this analysis.",
        );
      }
      break;
    }
    case "plan": {
      const scriptLines = latest(artifacts, "written_script")?.beats.length ?? request?.beats.length ?? 0;
      if (request) out.inputs.push(`${scriptLines} script lines, a budget of ${usd(request.budgetUsd)}, up to ${seconds(request.maxMs)}`);
      if (plan) {
        out.output.push(`${plan.shots.length} shots, estimated at ${usd(plan.estimatedUsd)}`);
        for (const shot of plan.shots) out.output.push(`${shot.beatId}: ${shot.visualType} (${shot.sourceKind}), ${seconds(shot.startMs)} to ${seconds(shot.endMs)}`);
        for (const decision of plan.decisions) out.reasons.push(`${decision.at}: chose ${decision.chose} (${decision.by}). ${decision.reason}`);
      }
      if (feed.reservation) {
        out.output.push(`Reservation ${feed.reservation.state}: estimate ${usd(feed.reservation.estimateUsd)}, held ${usd(feed.reservation.reservedUsd)}`);
        if (feed.reservation.pausedReason) out.reasons.push(feed.reservation.pausedReason);
      }
      for (const decision of feed.decisions) out.reasons.push(`${decision.at}: chose ${decision.chose} (${decision.by}). ${decision.reason}`);
      break;
    }
    case "model_choices": {
      if (!plan) break;
      for (const shot of plan.shots) {
        if (shot.modelChoice) {
          out.models.push({ label: `${shot.beatId} ${shot.visualType}`, provider: shot.modelChoice.provider, model: shot.modelChoice.model, basis: "chosen" });
          if (shot.modelChoice.reason) out.reasons.push(`${shot.beatId}: ${shot.modelChoice.reason}`);
        } else if (shot.modelClasses.length > 0) {
          const target = shot.routeTargets.find((item) => item.model !== null) ?? shot.routeTargets[0] ?? null;
          out.models.push({ label: `${shot.beatId} ${shot.visualType} (${shot.modelClasses.join(", ")})`, provider: target?.provider ?? null, model: target?.model ?? null, basis: "route" });
        } else {
          out.output.push(`${shot.beatId} ${shot.visualType}: ${shot.sourceKind === "component" ? "drawn by code" : shot.sourceKind === "stock" ? "stock footage" : "an existing asset"}, no generation model`);
        }
      }
      for (const take of artifacts) {
        if (take.type === "take") out.models.push({ label: `Take ${take.attempt} of ${take.shotId}`, provider: take.provider, model: take.model, basis: "used" });
      }
      break;
    }
    case "script": {
      if (request) {
        if (request.brief) out.inputs.push(`Brief: ${request.brief}`);
        out.inputs.push(`Language ${request.language ?? "chosen by the script writer"}; keep: ${request.keep.length > 0 ? request.keep.join(", ") : "nothing chosen"}`);
        for (const change of request.change) out.inputs.push(change);
        for (const beat of request.beats) out.output.push(`${beat.role}: ${beat.text}`);
      }
      const written = latest(artifacts, "written_script");
      if (written) {
        out.output.push(`Written by the engine (${written.language}):`);
        for (const beat of written.beats) out.output.push(`${beat.role}: ${beat.text}`);
        out.reasons.push(written.rationale);
      }
      const validated = latest(artifacts, "validated_request");
      if (validated) out.output.push(`Estimated speech: ${seconds(validated.estimatedSpeechMs)}`);
      if (feed.status.status === "failed") out.reasons.push(...feed.status.reasons);
      break;
    }
    case "voice": {
      const voice = latest(artifacts, "voice_track");
      if (voice) {
        out.output.push(`${seconds(voice.durationMs)} of narration, ${voice.words} words, ${voice.lufs} LUFS`);
        out.models.push({ label: `Voice ${voice.voiceId}`, provider: voice.provider, model: null, basis: "used" });
      }
      break;
    }
    case "visuals": {
      for (const artifact of artifacts) {
        if (artifact.type === "take") out.output.push(`Take ${artifact.attempt} of ${artifact.shotId}: ${seconds(artifact.durationMs)} from ${artifact.provider} ${artifact.model}`);
        if (artifact.type === "take_verdict") {
          out.output.push(`Check of ${artifact.takeId}: ${artifact.pass ? "passed" : "failed"}, ${artifact.action}, confidence ${artifact.confidence}`);
          if (!artifact.pass && artifact.failing.length > 0) out.reasons.push(`${artifact.takeId}: ${artifact.failing.join(", ")}`);
        }
      }
      break;
    }
    case "edit": {
      const edl = latest(artifacts, "edl");
      if (edl) out.output.push(`${edl.clips} clips over ${seconds(edl.durationMs)}`);
      break;
    }
    case "render": {
      const video = latest(artifacts, "rendered_video");
      if (video) {
        out.output.push(`${seconds(video.durationMs)} rendered by ${video.renderer}, ${Math.round(video.bytes / 1000)} KB`);
        out.output.push(`Render estimate ${usd(video.estimateUsd)}; bill ${costLabel(video.costUsd)}`);
      }
      break;
    }
    case "gates": {
      const passed = feed.gates.filter((gate) => gate.pass).length;
      if (feed.gates.length > 0) out.output.push(`${passed} of ${feed.gates.length} gate results passed across the request`);
      for (const gate of feed.gates.filter((item) => item.gate === "pre_render" || item.gate === "post_render")) {
        out.output.push(`${gate.gate === "pre_render" ? "Before render" : "After render"}: ${gate.pass ? "passed" : "failed"} (${gate.checks.length} checks)`);
      }
      break;
    }
    case "delivery": {
      const manifest = latest(artifacts, "manifest");
      if (manifest) out.output.push(`Video ${manifest.videoId}, ${manifest.shots.length} shots in the manifest`);
      if (feed.status.status === "needs_review") out.reasons.push(`${feed.status.openItems} open review items.`);
      break;
    }
  }
  const gates = feed.gates.filter((gate) => CARD_STAGES[id].gates.includes(gate.gate));
  out.reasons.push(...failingChecks(gates));
  out.reasons = [...new Set(out.reasons)];
  return out;
}

function headlineOf(status: EngineRequestStatus): string {
  switch (status.status) {
    case "queued":
      return "The engine accepted the request and has not started it yet.";
    case "running":
      return `The engine is working${status.stage ? ` (at ${status.stage})` : ""}.`;
    case "paused":
      return `The engine paused the request at ${status.stage}: ${status.reason}`;
    case "needs_review":
      return `The engine sent the request to review at ${status.stage}: ${status.reason}`;
    case "delivered":
      return "The engine delivered the video.";
    case "failed":
      return `The engine did not deliver the video: ${status.reasons.join(" ")}`;
  }
}

/** The cards of one run, in the order of the engine's steps. */
export function feedCards(feed: EngineRequestFeed): RunFeed {
  const attributed = new Set(Object.values(CARD_STAGES).flatMap((item) => item.stages));
  const cards = CARD_IDS.map((id): FeedCard => {
    const { status, text } = statusOf(id, feed);
    const stages = CARD_STAGES[id].stages;
    const rows = feed.ledger.filter((row) => stages.includes(row.stage));
    const cost = id === "model_choices" ? null : costOf(rows);
    return {
      id,
      title: CARD_TITLES[id],
      status,
      statusText: text,
      ...cardDetail(id, feed),
      cost,
      costNote: id === "model_choices" ? "Choosing a model is part of the plan; the calls each model makes are counted under Visuals." : null,
    };
  });
  return {
    requestId: feed.requestId,
    status: feed.status,
    active: feed.status.status === "queued" || feed.status.status === "running",
    headline: headlineOf(feed.status),
    cards,
    total: costOf(feed.ledger),
    unattributedCalls: feed.ledger.filter((row) => !attributed.has(row.stage)).length,
  };
}
