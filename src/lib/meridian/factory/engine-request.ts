/**
 * The mapping from a Factory video to the engine's production request (engine contract request.ts, Bible section 6.1). A Factory plan
 * carries the workspace, the video's aspect ratio and duration, and the cost of its master. The engine request needs more than that: a
 * format and its reference video, a script language and beats, a page with its kits, a priority. A plan does not carry those, and they
 * are not defaulted here. The caller supplies only what it knows, and any field still absent is reported by the engine's own schema.
 *
 * The mapper is pure. It reads the plan, calls no provider, reads no key and writes nothing. Nothing it returns is sent.
 */
import { createHash } from "node:crypto";
import { encodeUlid } from "../../../engine/contracts/ids.ts";
import {
  productionRequestSchema,
  type GeneId,
  type ProductionRequest,
  type ScriptBeat,
  type VariantMatrix,
} from "../../../engine/contracts/request.ts";
import type { CreativePlan } from "../creative/plan.ts";
import type { PageRequestKits } from "../pages/model.ts";

type VisualRequest = ProductionRequest["visualRequests"][number];
type Priority = ProductionRequest["constraints"]["priority"];
type Product = NonNullable<ProductionRequest["product"]>;

/**
 * What the engine needs that a Factory plan does not carry. A caller sets a field only when it knows the value. Nothing here has a
 * default, so an unset field is reported as missing.
 */
export type EngineOnlyFields = {
  formatId?: string;
  referenceVideo?: string;
  videoDnaId?: string;
  keep?: GeneId[];
  change?: string[];
  language?: string;
  beats?: ScriptBeat[];
  visualRequests?: VisualRequest[];
  product?: Product;
  pageId?: string;
  styleKitId?: string;
  personaId?: string;
  voiceId?: string;
  characterIds?: string[];
  priority?: Priority;
  deadline?: string;
  variants?: VariantMatrix;
};

export type EngineVideoInput = {
  /** The Factory's organization. The engine calls it the workspace. */
  organizationId: string;
  /** The request id, "req_" and a ULID (see engineRequestIdFor). Null when none can be made, and the engine schema then reports it. */
  requestId: string | null;
  plan: CreativePlan;
  /** The plan's video deliverable for this variant. */
  deliverableId: string;
  engine?: EngineOnlyFields;
  /**
   * The budget of this master in USD: the run's cost per master (RunSettings.costPerMasterUsd), which the Factory passes. Null means
   * the run has none, and no budget is set. Absent (undefined), the plan's own estimate for the deliverable is used.
   */
  budgetUsd?: number | null;
  /**
   * The run's theme page (pages/model.ts pageRequestKits). When given, its kit ids fill request.page, and the page fields in `engine` are not
   * used. Without a page, those fields are used as before.
   */
  themePage?: PageRequestKits | null;
};

/**
 * mapped: the request passes the engine's schema. needs_budget: the plan has no cost for this master, so no budget is set and none is
 * assumed. incomplete: the schema needs fields that neither the plan nor the caller gave. Each result lists the fields still missing.
 */
export type EngineMapping =
  | { status: "mapped"; request: ProductionRequest }
  | { status: "needs_budget"; message: string; missing: string[] }
  | { status: "incomplete"; missing: string[] };

export const NEEDS_BUDGET_MESSAGE =
  "The plan has no cost for this master, so the engine budget is not set. Set the cost of the master. No default is used.";

/**
 * The cost of one master, from the plan: the estimate for its video deliverable. A deliverable the plan lists as unpriced has no known
 * cost, and so does one the plan does not price. Null means no cost is known.
 */
export function budgetPerMaster(plan: CreativePlan, deliverableId: string): number | null {
  const estimate = plan.estimatedCost;
  if (!estimate || estimate.unpricedDeliverableIds?.includes(deliverableId)) return null;
  const amount = estimate.perDeliverableUsd?.[deliverableId];
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}

/**
 * The request id of one Factory video job: "req_" and a ULID. Its time is the plan's creation time, and its randomness is a hash of the
 * job id, so the same job always has the same id. Null when the creation time is not a date the ULID can hold.
 */
export function engineRequestIdFor(jobId: string, planCreatedAt: string): string | null {
  const timeMs = Date.parse(planCreatedAt);
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs >= 2 ** 48) return null;
  const random = BigInt(`0x${createHash("sha256").update(jobId).digest("hex").slice(0, 20)}`);
  return `req_${encodeUlid(timeMs, random)}`;
}

/** Drops the keys whose value is undefined, so an unset field is absent rather than undefined. */
function present(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * The request.page kit fields. A theme page supplies them, and a kit the page does not set stays absent, so the engine schema reports it
 * as missing. Without a page the engine's own fields are used.
 */
function pageKitFields(page: PageRequestKits | null | undefined, engine: EngineOnlyFields): Record<string, unknown> {
  if (!page) return { pageId: engine.pageId, styleKitId: engine.styleKitId, personaId: engine.personaId, voiceId: engine.voiceId };
  return {
    pageId: page.pageId,
    styleKitId: page.styleKitId ?? undefined,
    personaId: page.personaId ?? undefined,
    voiceId: page.voiceId ?? undefined,
  };
}

/** Maps one Factory video to the engine's production request, and checks it with the engine's own schema. */
export function mapVideoToEngineRequest(input: EngineVideoInput): EngineMapping {
  const engine = input.engine ?? {};
  const deliverable = input.plan.deliverables.find((item) => item.id === input.deliverableId && item.kind === "video");
  const seconds = deliverable?.targetDurationSeconds;
  const given = input.budgetUsd;
  const budget =
    given === undefined ? budgetPerMaster(input.plan, input.deliverableId) : typeof given === "number" && Number.isFinite(given) && given >= 0 ? given : null;

  const candidate = present({
    schema: "meridian.production_request/v1",
    requestId: input.requestId ?? undefined,
    workspaceId: input.organizationId,
    format: present({
      formatId: engine.formatId,
      referenceVideo: engine.referenceVideo,
      videoDnaId: engine.videoDnaId,
      keep: engine.keep,
      change: engine.change,
    }),
    script: present({ language: engine.language, beats: engine.beats }),
    visualRequests: engine.visualRequests,
    product: engine.product,
    page: present({
      ...pageKitFields(input.themePage, engine),
      characterIds: engine.characterIds,
    }),
    constraints: present({
      aspect: deliverable?.aspectRatio === "9:16" ? "9:16" : undefined,
      maxMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined,
      budgetUsd: budget ?? undefined,
      deadline: engine.deadline,
      priority: engine.priority,
    }),
    output: present({ master: true, variants: engine.variants }),
  });

  const parsed = productionRequestSchema.safeParse(candidate);
  if (parsed.success) return { status: "mapped", request: parsed.data };
  const missing = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "request"))];
  if (budget === null) return { status: "needs_budget", message: NEEDS_BUDGET_MESSAGE, missing };
  return { status: "incomplete", missing };
}
