/**
 * Input checks for the Content Factory server functions. Plain code with no server imports. Each check keeps only the fields it names: a
 * workspace named in a session's request body is never a way to reach another workspace (service.ts reads the workspace from the session).
 */
import { MAX_BASE64_CHARS } from "./model.ts";
import { shotDecisionSchema, type ShotDecision } from "../../../engine/review/shot-decision.ts";
import {
  isFilePurpose,
  isKeepableGene,
  isScriptRole,
  isSourcePage,
  MAX_MESSAGE_CHARS,
  MAX_TITLE_CHARS,
  REMAKE_DIRECTION_MAX_CHARS,
  type FilePurpose,
  type KeepableGene,
  type ScriptRole,
  type SourcePage,
} from "./model.ts";

const ID = /^[A-Za-z0-9_:-]{1,100}$/;

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function idOf(value: unknown, label: string): string {
  const id = text(value);
  if (!ID.test(id)) throw new Error(`Choose a valid ${label}.`);
  return id;
}

function optionalId(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return idOf(value, label);
}

function numberOrNull(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Enter a number for ${label}.`);
  return number;
}

export function workspaceInput(input: unknown): { organizationId: string } {
  return { organizationId: idOf(fields(input).organizationId, "workspace") };
}

export function brandHookInput(input: unknown): { organizationId: string; brandId: string } {
  return { organizationId: idOf(fields(input).organizationId, "workspace"), brandId: idOf(fields(input).brandId, "brand") };
}

export function sessionInput(input: unknown): { sessionId: string } {
  return { sessionId: idOf(fields(input).sessionId, "session") };
}

/** A run of a repurpose, whose rendered variations' decisions are read. */
export function repurposeRunInput(input: unknown): { sessionId: string; runId: string } {
  const body = fields(input);
  return { sessionId: idOf(body.sessionId, "session"), runId: idOf(body.runId, "run") };
}

/** A reviewer's decision on one rendered variation of a run. The decision and the reason are checked by the review, not here. */
export function repurposeReviewInput(input: unknown): { sessionId: string; runId: string; variantKey: string; decision: string; reason: string } {
  const body = fields(input);
  return {
    sessionId: idOf(body.sessionId, "session"),
    runId: idOf(body.runId, "run"),
    variantKey: idOf(body.variantKey, "variation"),
    decision: typeof body.decision === "string" ? body.decision : "",
    reason: typeof body.reason === "string" ? body.reason : "",
  };
}

/** The rendered variation of a repurpose run whose video a reviewer opens: the session, the run and the variation key. */
export function repurposeOutputInput(input: unknown): { sessionId: string; runId: string; variantKey: string } {
  const body = fields(input);
  return { sessionId: idOf(body.sessionId, "session"), runId: idOf(body.runId, "run"), variantKey: idOf(body.variantKey, "variation") };
}

/** A repurpose request: the session, and the settings as the person chose them. The settings are validated by the repurpose contract, not here. */
export function repurposeInput(input: unknown): { sessionId: string; settings: unknown } {
  const body = fields(input);
  return { sessionId: idOf(body.sessionId, "session"), settings: body.settings };
}

/** The reviewer's model for a shot's remake, by its catalog id. Empty: the orchestrator's choice. A name that is not an id is refused. */
export function modelIdOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Choose a model from the list.");
  const id = value.trim();
  if (id === "") return null;
  if (id.length > 200) throw new Error("Choose a model from the list.");
  return id;
}

/** A revision of a session with a direction for the whole video. The direction may be empty: then the revision is made as it always was. */
export function reviseDirectionInput(input: unknown): { sessionId: string; direction: string } {
  const body = fields(input);
  const direction = typeof body.direction === "string" ? body.direction : "";
  if (direction.length > MAX_MESSAGE_CHARS) throw new Error(`Keep a direction to ${MAX_MESSAGE_CHARS} characters.`);
  return { sessionId: idOf(body.sessionId, "session"), direction };
}

/** One shot of a session's video, for a read of its take, its model options or a quote of its remake. */
export function shotRefInput(input: unknown): { sessionId: string; shotId: string; modelId: string | null } {
  const body = fields(input);
  const shotId = idOf(body.shotId, "shot");
  if (!shotId.startsWith("shot_")) throw new Error("Choose a shot of this video.");
  return { sessionId: idOf(body.sessionId, "session"), shotId, modelId: modelIdOf(body.modelId) };
}

/** A reviewer's own clip for one shot: the session, the shot, and the file as base64, within the upload limit. Decoding is the service's job. */
export function clipInput(input: unknown): { sessionId: string; shotId: string; base64: string } {
  const body = fields(input);
  const shotId = idOf(body.shotId, "shot");
  if (!shotId.startsWith("shot_")) throw new Error("Choose a shot of this video.");
  if (typeof body.base64 !== "string" || body.base64.length === 0) throw new Error("Choose a clip to use for this shot.");
  if (body.base64.length > MAX_BASE64_CHARS) throw new Error("The clip is larger than the upload limit.");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) throw new Error("The clip could not be read.");
  return { sessionId: idOf(body.sessionId, "session"), shotId, base64: body.base64 };
}

/** A reviewer's change to one shot: the session, the shot and the decision, checked by the engine's schema before anything is read. */
export function shotDecisionInput(input: unknown): { sessionId: string; shotId: string; decision: ShotDecision; modelId: string | null } {
  const body = fields(input);
  const shotId = idOf(body.shotId, "shot");
  if (!shotId.startsWith("shot_")) throw new Error("Choose a shot of this video.");
  const parsed = shotDecisionSchema.safeParse(body.decision);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "The change to this shot is not valid.");
  return { sessionId: idOf(body.sessionId, "session"), shotId, decision: parsed.data, modelId: modelIdOf(body.modelId) };
}

/** A remake of one shot: the session, the shot of its video, and the reviewer's direction. The engine trims and checks the direction. */
export function remakeShotInput(input: unknown): { sessionId: string; shotId: string; directive: string | null; modelId: string | null } {
  const body = fields(input);
  const shotId = idOf(body.shotId, "shot");
  if (!shotId.startsWith("shot_")) throw new Error("Choose a shot of this video.");
  const directive = typeof body.directive === "string" ? body.directive : null;
  if (directive !== null && directive.length > REMAKE_DIRECTION_MAX_CHARS) {
    throw new Error(`Keep a direction to ${REMAKE_DIRECTION_MAX_CHARS} characters.`);
  }
  return { sessionId: idOf(body.sessionId, "session"), shotId, directive, modelId: modelIdOf(body.modelId) };
}

export function createSessionInput(input: unknown): { organizationId: string; brandId: string | null; title: string } {
  const body = fields(input);
  const title = text(body.title).replace(/\s+/g, " ");
  if (!title) throw new Error("Give the session a title.");
  if (title.length > MAX_TITLE_CHARS) throw new Error(`Keep the title to ${MAX_TITLE_CHARS} characters.`);
  return { organizationId: idOf(body.organizationId, "workspace"), brandId: optionalId(body.brandId, "brand"), title };
}

export function opportunityBriefInput(input: unknown): { organizationId: string; brandId: string; opportunityId: string } {
  const body = fields(input);
  return {
    organizationId: idOf(body.organizationId, "workspace"),
    brandId: idOf(body.brandId, "brand"),
    opportunityId: idOf(body.opportunityId, "idea"),
  };
}

export function messageInput(input: unknown): { sessionId: string; text: string; beatRole: ScriptRole | null } {
  const body = fields(input);
  const raw = typeof body.text === "string" ? body.text : "";
  if (raw.length > MAX_MESSAGE_CHARS) throw new Error(`Keep a message to ${MAX_MESSAGE_CHARS} characters.`);
  const beatRole = body.beatRole === null || body.beatRole === undefined || body.beatRole === "" ? null : body.beatRole;
  if (beatRole !== null && !isScriptRole(beatRole)) throw new Error("Choose a script role: hook, setup, item, proof, twist, payoff or cta.");
  return { sessionId: idOf(body.sessionId, "session"), text: raw.trim(), beatRole };
}

export function uploadInput(input: unknown): { sessionId: string; messageId: string; fileName: string; purpose: FilePurpose; base64: string } {
  const body = fields(input);
  const base64 = typeof body.base64 === "string" ? body.base64 : "";
  if (!base64) throw new Error("No file was sent.");
  if (base64.length > MAX_BASE64_CHARS) throw new Error("The file is too large to store.");
  if (!isFilePurpose(body.purpose)) throw new Error("Say whether the file is the reference video or other material.");
  return {
    sessionId: idOf(body.sessionId, "session"),
    messageId: idOf(body.messageId, "message"),
    fileName: typeof body.fileName === "string" ? body.fileName.slice(0, 300) : "",
    purpose: body.purpose,
    base64,
  };
}

export function sourceSearchInput(input: unknown): { sessionId: string; brandId: string; page: SourcePage; query: string } {
  const body = fields(input);
  if (!isSourcePage(body.page)) throw new Error("Choose a page to search.");
  return { sessionId: idOf(body.sessionId, "session"), brandId: idOf(body.brandId, "brand"), page: body.page, query: text(body.query).slice(0, 200) };
}

export function attachSourceInput(input: unknown): { sessionId: string; messageId: string; brandId: string; page: SourcePage; recordId: string } {
  const body = fields(input);
  if (!isSourcePage(body.page)) throw new Error("Choose a page.");
  return {
    sessionId: idOf(body.sessionId, "session"),
    messageId: idOf(body.messageId, "message"),
    brandId: idOf(body.brandId, "brand"),
    page: body.page,
    recordId: idOf(body.recordId, "record"),
  };
}

export function settingsInput(input: unknown): {
  sessionId: string;
  brandId?: string | null;
  budgetUsd: number | null;
  maxSeconds: number | null;
  language: string | null;
  priority: string | null;
  keepGenes: KeepableGene[];
} {
  const body = fields(input);
  const language = text(body.language);
  if (language && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) throw new Error("Use a language code such as en or en-US.");
  const keep = Array.isArray(body.keepGenes) ? body.keepGenes : [];
  if (!keep.every(isKeepableGene)) throw new Error("Choose genes from the list.");
  const priority = text(body.priority);
  return {
    sessionId: idOf(body.sessionId, "session"),
    ...(Object.prototype.hasOwnProperty.call(body, "brandId") ? { brandId: optionalId(body.brandId, "brand") } : {}),
    budgetUsd: numberOrNull(body.budgetUsd, "the budget"),
    maxSeconds: numberOrNull(body.maxSeconds, "the length"),
    language: language || null,
    priority: priority || null,
    keepGenes: keep as KeepableGene[],
  };
}
