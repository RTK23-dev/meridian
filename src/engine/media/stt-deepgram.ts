// Deepgram pre-recorded speech-to-text (Bible 10.3, 20.2; owner decision 2026-10-16). Two calls for the transcript and the bill:
// POST /v1/listen, then GET /v1/projects/{project_id}/requests/{request_id}. The project comes from GET /v1/projects, which lists the
// projects the workspace's key reaches. All three go through the API gateway (gateway.call, provider "deepgram"). The gateway holds the
// key (Meridian's credential resolver, gateway/meridian.ts) and the host (gateway/providers.ts), so this file names neither and never
// sees a key. The model comes from the stt route (config/routes.ts) and the price from prices.ts.
//
// Deepgram's answer is untrusted (Bible 2). The transcript goes through normaliseTranscript before anything stores it, the transcribed
// audio may not be longer than the audio asked about, and the bill is read only from its documented field. A bill that cannot be read
// leaves the call unsettled (contract v6): the transcript is still returned, with billNote saying why. A key that reaches no project, or
// more than one, has no bill to read, so the call stays unsettled too: the project is never guessed.
//
// Facts the adapter relies on, from Deepgram's API reference read on 2026-10-16 (the owner's live run confirms them):
//   - POST /v1/listen?model=<model>&smart_format=true&language=<primary tag>, with "Authorization: Token <key>" added by the gateway.
//   - The body is {"url": "..."} as application/json for a URL, or the raw bytes as application/octet-stream.
//   - The words are at results.channels[0].alternatives[0].words[] (word, start, end in seconds, confidence).
//   - metadata.request_id and metadata.duration (seconds).
//   - The bill is at request.response.details.usd (USD) in the request lookup.
//   - GET /v1/projects lists the projects, as projects[].project_id. UNVERIFIED LIVE: the listing is not read from the reference yet.
// Deepgram documents no idempotency header in that reference, so the idempotency key stays on the ledger and is not sent. The ledger
// refuses a repeat before the call (stt.ts), and that is the only dedupe.

import { z } from "zod";
import { FFMPEG_LIMITS } from "../../../functions/ffmpeg/limits.ts";
import type { MediaSource } from "../../../functions/ffmpeg/types.ts";
import type { BillRead } from "../budget/reconcile-holds.ts";
import { classifyError, excerpt, providerErrorForStatus } from "../assets/classify.ts";
import { EngineError } from "../contracts/errors.ts";
import { roundUsd } from "../contracts/money.ts";
import type { Gateway, GatewayCall, GatewayResult, ResolvedRoute } from "../gateway/gateway.ts";
import type { HttpResponse } from "../gateway/types.ts";
import { mediaConfig } from "./config.ts";
import { notConnectedReason } from "./stt-connection.ts";
import { normaliseTranscript, SttCallError, type SpeechToText, type SttRequest, type SttResult } from "./stt.ts";

const STAGE = "speech_to_text";
export const DEEPGRAM_PROVIDER = "deepgram";
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}$/;
const MAX_URL_CHARS = 2048;
/** Bytes of an error answer read for its message. The excerpt is shorter still. */
const ERROR_TEXT_BYTES = 2048;
/**
 * Statuses that refuse the call before any work (contract v6, Bible 10.4): a bad request, a bad key, a forbidden call. Deepgram bills
 * nothing for them, so the hold is settled as confirmed absent. Every other status keeps its hold: the vendor may have billed it.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

const listenAnswerSchema = z.object({
  metadata: z.object({
    request_id: z.string().optional(),
    duration: z.number().finite().nonnegative(),
  }),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(
              z.object({
                words: z.array(
                  z.object({
                    word: z.string(),
                    start: z.number().finite(),
                    end: z.number().finite(),
                    confidence: z.number().finite(),
                  }),
                ),
              }),
            )
            .min(1),
          // Named when the request asked for detection (detect_language=true). Owner decision (lead, 2026-10-17); not verified live.
          detected_language: z.string().min(1).optional(),
        }),
      )
      .min(1),
  }),
});

const billAnswerSchema = z.object({
  request: z.object({
    request_id: z.string().optional(),
    response: z.object({
      details: z.object({ usd: z.number().finite().nonnegative() }),
    }),
  }),
});

const projectsAnswerSchema = z.object({
  projects: z.array(z.object({ project_id: z.string() })),
});

/** The Deepgram project a workspace's bills belong to: one project, or why none can be named. */
export type ProjectLookup = { status: "ready"; projectId: string } | { status: "not_connected"; reason: string };

/** Names the project of a workspace. The composition root builds one per process, so each workspace is asked once. */
export interface DeepgramProjects {
  forWorkspace(organizationId: string | null): Promise<ProjectLookup>;
}

/**
 * The project of each workspace, from GET /v1/projects through the gateway (owner decision 2026-10-16; the listing is UNVERIFIED LIVE).
 * Exactly one project is used, and it is cached per workspace for this process. Zero projects, or more than one, is NOT_CONNECTED with
 * its reason: the bill is not read and the call stays unsettled, because the project is never guessed. A failed lookup is not cached,
 * so the next call asks again. A key change to another Deepgram account needs a restart to drop the cache (media/STATUS.md).
 */
export function deepgramProjects(gateway: Pick<Gateway, "call">): DeepgramProjects {
  const cache = new Map<string, string>();
  return {
    async forWorkspace(organizationId: string | null): Promise<ProjectLookup> {
      const scope = organizationId?.trim() ?? "";
      if (scope === "") {
        return {
          status: "not_connected",
          reason: notConnectedReason("the Deepgram project cannot be named: no workspace is in scope, so the bill is not read"),
        };
      }
      const cached = cache.get(scope);
      if (cached !== undefined) return { status: "ready", projectId: cached };
      const lookup = await listProjects(gateway, scope);
      if (lookup.status === "ready") cache.set(scope, lookup.projectId);
      return lookup;
    },
  };
}

async function listProjects(gateway: Pick<Gateway, "call">, organizationId: string): Promise<ProjectLookup> {
  const unavailable = (reason: string): ProjectLookup => ({
    status: "not_connected",
    reason: notConnectedReason(`the Deepgram project cannot be named: ${reason}; the bill is not read`),
  });
  let result: GatewayResult;
  try {
    result = await gateway.call({
      provider: DEEPGRAM_PROVIDER,
      organizationId,
      method: "GET",
      path: "/v1/projects",
      timeoutMs: mediaConfig.speechToText.billTimeoutMs,
    });
  } catch (error) {
    return unavailable(`the project list did not answer (${error instanceof Error ? excerpt(error.message) : "unknown error"})`);
  }
  if (result.status === "not_connected") {
    return unavailable(`deepgram is not connected: ${result.reason}`);
  }
  const response = result.response;
  if (!isSuccess(response.status)) {
    return unavailable(`the project list answered HTTP ${response.status}`);
  }
  let raw: unknown;
  try {
    raw = jsonAnswer(response.body, mediaConfig.speechToText.maxProjectsResponseBytes, "project list");
  } catch (error) {
    return unavailable(error instanceof Error ? excerpt(error.message) : "the project list is unreadable");
  }
  const parsed = projectsAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable("the project list has no usable shape");
  }
  const ids = [...new Set(parsed.data.projects.map((project) => project.project_id))];
  if (ids.some((id) => !PROJECT_ID_PATTERN.test(id))) {
    return unavailable("the project list holds an id this adapter cannot use");
  }
  const [first, ...rest] = ids;
  if (first === undefined) {
    return unavailable("the key reaches no Deepgram project");
  }
  if (rest.length > 0) {
    return unavailable(`the key reaches ${ids.length} Deepgram projects, so the bill cannot be attributed without a choice`);
  }
  return { status: "ready", projectId: first };
}

export type DeepgramOptions = {
  /** The stt route (gateway.route("stt")). Its provider must be deepgram, and its model is the one requested. */
  route: ResolvedRoute;
  /** The API gateway. Only its call() is used, so the key and the host stay inside it. */
  gateway: Pick<Gateway, "call">;
  /** The project of each workspace (deepgramProjects). The workspace of a call is SttRequest.organizationId. */
  projects: DeepgramProjects;
};

type Deps = {
  gateway: Pick<Gateway, "call">;
  projects: DeepgramProjects;
  model: string;
};

/**
 * The Deepgram adapter for the stt route. It refuses a route that is not Deepgram's, or a model id that is not valid, and sends nothing.
 * A request the adapter cannot make (a URL that is not https, an empty file, a language it cannot send) is refused before anything is
 * sent, and is marked as refused before any work, so the ledger settles it as confirmed absent.
 */
export function deepgramSpeechToText(options: DeepgramOptions): SpeechToText {
  const { route } = options;
  if (route.provider.id !== DEEPGRAM_PROVIDER) {
    throw new EngineError("config", `the stt route names ${route.provider.id}, not ${DEEPGRAM_PROVIDER}`, { stage: STAGE });
  }
  if (!MODEL_PATTERN.test(route.model)) {
    throw new EngineError("config", "the deepgram model id in the stt route is not valid", { stage: STAGE });
  }
  const deps: Deps = { gateway: options.gateway, projects: options.projects, model: route.model };
  return {
    provider: DEEPGRAM_PROVIDER,
    model: route.model,
    transcribe: (request: SttRequest) => transcribe(deps, request),
  };
}

/**
 * The stt connection's resolver (stt-connection.ts): the Deepgram adapter for a route that names Deepgram, and null for any other route,
 * so a route to another vendor is not connected here.
 */
export function deepgramForRoute(route: ResolvedRoute, deps: Omit<DeepgramOptions, "route">): SpeechToText | null {
  return route.provider.id === DEEPGRAM_PROVIDER ? deepgramSpeechToText({ ...deps, route }) : null;
}

async function transcribe(deps: Deps, request: SttRequest): Promise<SttResult> {
  const organizationId = request.organizationId?.trim() || null;
  let listen: { path: string; contentType: string; body: string | Uint8Array };
  try {
    if (organizationId === null) {
      throw new EngineError("config", notConnectedReason("no workspace is in scope, so no Deepgram key can be chosen for this call"), {
        stage: STAGE,
      });
    }
    listen = listenRequest(deps.model, request);
  } catch (error) {
    throw notSent(error);
  }
  const response = await send(deps, organizationId, {
    method: "POST",
    path: listen.path,
    headers: { "Content-Type": listen.contentType },
    body: listen.body,
    timeoutMs: mediaConfig.speechToText.listenTimeoutMs,
  });
  if (!isSuccess(response.status)) {
    throw statusFailure(response);
  }
  const parsed = listenAnswerSchema.safeParse(
    jsonAnswer(response.body, mediaConfig.speechToText.maxResponseBytes, "transcription"),
  );
  if (!parsed.success) {
    throw invalidAnswer(`the transcription has no usable shape (${issueOf(parsed.error)})`);
  }
  const answer = parsed.data;
  const audioMs = Math.round(answer.metadata.duration * 1000);
  if (audioMs > request.durationMs + mediaConfig.transcript.endToleranceMs) {
    throw invalidAnswer(`the vendor transcribed ${audioMs} ms of audio, more than the ${request.durationMs} ms requested`);
  }
  const alternative = answer.results.channels[0]?.alternatives[0];
  if (alternative === undefined) {
    throw invalidAnswer("the transcription has no alternative");
  }
  // A request with a language asks the vendor for it, and the response names no language, so the language is the one requested. A request
  // with no language asks for detection (detect_language=true): the channel names the language the vendor detected, and nothing else is
  // taken as the language. A detection that names no language is an invalid answer.
  const detected = answer.results.channels[0]?.detected_language;
  if (request.language === null && detected === undefined) {
    throw invalidAnswer("the transcription was asked to detect the language and names none");
  }
  const normalised = normaliseTranscript(
    {
      language: request.language ?? detected,
      words: alternative.words.map((word) => ({
        text: word.word,
        start: word.start,
        end: word.end,
        confidence: word.confidence,
      })),
    },
    request,
  );
  const bill = await readBill(deps, organizationId, answer.metadata.request_id);
  // The request id is the call's providerRef (contract v9): recorded on the ledger entry even when no bill is read.
  const providerRef = answer.metadata.request_id !== undefined && REQUEST_ID_PATTERN.test(answer.metadata.request_id) ? answer.metadata.request_id : undefined;
  return {
    words: normalised.words,
    language: normalised.language,
    billedUsd: bill.billedUsd,
    ...(bill.billNote === undefined ? {} : { billNote: bill.billNote }),
    ...(providerRef === undefined ? {} : { providerRef }),
  };
}

/**
 * The bill reader of a Deepgram call for the reconciler (budget/reconcile-holds.ts, contract v9). The call's request id is its providerRef,
 * and the bill is read from the same request lookup transcribe uses, in the workspace's project. Any miss is unavailable with its reason,
 * and nothing is estimated.
 */
export function deepgramBillReader(options: Pick<DeepgramOptions, "gateway" | "projects">): (input: { organizationId: string; providerRef: string }) => Promise<BillRead> {
  return async ({ organizationId, providerRef }) => {
    const bill = await readBill(options, organizationId, providerRef);
    if (bill.billedUsd === null) {
      return { status: "unavailable", reason: bill.billNote ?? "the Deepgram bill is not available" };
    }
    return { status: "billed", usd: bill.billedUsd };
  };
}

type Bill = { billedUsd: number | null; billNote?: string };

function held(reason: string): Bill {
  return { billedUsd: null, billNote: `${reason}; the call stays held (contract v6)` };
}

/**
 * The bill of one transcription, from the request lookup in the workspace's project. Any failure, a missing or unusable amount, an
 * answer for another request, or a project that cannot be named (NOT_CONNECTED) leaves the call unsettled. The transcript is kept, and
 * nothing is booked as the actual cost.
 */
async function readBill(deps: Pick<Deps, "gateway" | "projects">, organizationId: string | null, requestId: string | undefined): Promise<Bill> {
  if (requestId === undefined || !REQUEST_ID_PATTERN.test(requestId)) {
    return held("the answer names no usable request id, so the bill cannot be read");
  }
  let project: ProjectLookup;
  try {
    project = await deps.projects.forWorkspace(organizationId);
  } catch (error) {
    return held(`the project lookup failed (${error instanceof Error ? excerpt(error.message) : "unknown error"})`);
  }
  if (project.status === "not_connected") {
    return held(project.reason);
  }
  const path = `/v1/projects/${encodeURIComponent(project.projectId)}/requests/${encodeURIComponent(requestId)}`;
  let response: HttpResponse;
  try {
    response = await send(deps, organizationId, { method: "GET", path, timeoutMs: mediaConfig.speechToText.billTimeoutMs });
  } catch (error) {
    return held(`the bill lookup did not answer (${error instanceof Error ? excerpt(error.message) : "unknown error"})`);
  }
  if (!isSuccess(response.status)) {
    return held(`the bill lookup answered HTTP ${response.status}`);
  }
  let raw: unknown;
  try {
    raw = jsonAnswer(response.body, mediaConfig.speechToText.maxBillResponseBytes, "bill");
  } catch (error) {
    return held(error instanceof Error ? excerpt(error.message) : "the bill answer is unreadable");
  }
  const parsed = billAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return held("the bill answer has no usable usd amount");
  }
  const billedFor = parsed.data.request.request_id;
  if (billedFor !== undefined && billedFor !== requestId) {
    return held("the bill answer is for another request");
  }
  return { billedUsd: roundUsd(parsed.data.request.response.details.usd) };
}

type ListenRequest = { path: string; contentType: string; body: string | Uint8Array };

function listenRequest(model: string, request: SttRequest): ListenRequest {
  // No language means detection (Deepgram's detect_language, lead decision 2026-10-17). A language is sent as its primary subtag.
  const query =
    request.language === null
      ? new URLSearchParams({ model, smart_format: "true", detect_language: "true" })
      : new URLSearchParams({ model, smart_format: "true", language: primaryLanguage(request.language) });
  return { path: `/v1/listen?${query.toString()}`, ...payloadOf(request.source) };
}

function payloadOf(source: MediaSource): { contentType: string; body: string | Uint8Array } {
  if (source.kind === "url") {
    return { contentType: "application/json", body: JSON.stringify({ url: httpsUrl(source.url) }) };
  }
  if (source.bytes.byteLength === 0) {
    throw new EngineError("invalid_input", "the audio is empty", { stage: STAGE });
  }
  if (source.bytes.byteLength > FFMPEG_LIMITS.maxInputBytes) {
    throw new EngineError("invalid_input", `the audio is larger than the ${FFMPEG_LIMITS.maxInputBytes} byte limit`, { stage: STAGE });
  }
  return { contentType: "application/octet-stream", body: source.bytes };
}

/** The URL Deepgram fetches itself. Only https, with no credentials and a bounded length. */
function httpsUrl(raw: string): string {
  if (raw.length > MAX_URL_CHARS) {
    throw new EngineError("invalid_input", `the audio URL is longer than ${MAX_URL_CHARS} characters`, { stage: STAGE });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EngineError("invalid_input", "the audio URL is not a URL", { stage: STAGE });
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new EngineError("invalid_input", "the audio URL must be https, with no credentials", { stage: STAGE });
  }
  return url.toString();
}

/** The primary subtag of a BCP-47 tag, which is what Deepgram's language parameter takes ("en-US" is sent as "en"). */
function primaryLanguage(tag: string): string {
  const primary = tag.trim().toLowerCase().split("-")[0] ?? "";
  if (!LANGUAGE_PATTERN.test(primary)) {
    throw new EngineError("invalid_input", `the language ${tag} is not a tag this adapter can send`, { stage: STAGE });
  }
  return primary;
}

type Call = Omit<GatewayCall, "provider" | "organizationId">;

/**
 * One request through the gateway, for one workspace. The gateway returns not_connected, or throws before it sends, for a provider it
 * cannot reach or a workspace with no key: those calls were never sent, so they are refused before any work. Any other failure came from
 * the transport after the request was sent, and is classified as the router classifies it: a timeout or a server error keeps its hold.
 */
async function send(deps: Pick<Deps, "gateway">, organizationId: string | null, call: Call): Promise<HttpResponse> {
  let result: GatewayResult;
  try {
    result = await deps.gateway.call({ ...call, provider: DEEPGRAM_PROVIDER, organizationId });
  } catch (error) {
    if (error instanceof EngineError) {
      throw notSent(error);
    }
    throw new SttCallError(classifyError(error), STAGE, false);
  }
  if (result.status === "not_connected") {
    throw notSent(new EngineError("config", notConnectedReason(`deepgram is not connected: ${result.reason}`), { stage: STAGE }));
  }
  return result.response;
}

/** A call that was never sent: refused before any work, so nothing can be billed (contract v6). */
function notSent(error: unknown): SttCallError {
  const kind = error instanceof EngineError && error.kind === "invalid_input" ? "invalid_input" : "unknown";
  const message = error instanceof Error ? excerpt(error.message) : "the call was not sent";
  return new SttCallError({ kind, retryable: false, message }, STAGE, true);
}

/** A non-2xx answer, classified by the router's rules (classify.ts). */
function statusFailure(response: HttpResponse): SttCallError {
  const text = new TextDecoder().decode(response.body.subarray(0, ERROR_TEXT_BYTES));
  return new SttCallError(providerErrorForStatus(response.status, text), STAGE, REFUSAL_STATUSES.has(response.status));
}

/** An answer the vendor did send, which is unusable. The call was made, so its hold stays (not refused before any work). */
function invalidAnswer(detail: string): EngineError {
  return new EngineError("provider", `speech-to-text returned an invalid answer: ${detail}`, { retryable: false, stage: STAGE });
}

/** The parsed JSON of an answer, read only up to the byte cap. The answer is untrusted: nothing in it is executed or followed. */
function jsonAnswer(body: Uint8Array, maxBytes: number, what: string): unknown {
  if (body.byteLength > maxBytes) {
    throw invalidAnswer(`the ${what} answer is larger than ${maxBytes} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw invalidAnswer(`the ${what} answer is not UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidAnswer(`the ${what} answer is not JSON`);
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function issueOf(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}` : "unreadable shape";
}
