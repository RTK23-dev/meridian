// Deepgram pre-recorded speech-to-text (Bible 10.3, 20.2; owner decision 2026-10-16). Two calls: POST /v1/listen for the transcript,
// then GET /v1/projects/{project_id}/requests/{request_id} for the bill. Both go through the API gateway (gateway.call, provider
// "deepgram"). The gateway holds the key (Meridian's credential resolver, gateway/meridian.ts) and the host (gateway/providers.ts), so
// this file names neither and never sees a key. The model comes from the stt route (config/routes.ts) and the price from prices.ts.
//
// Deepgram's answer is untrusted (Bible 2). The transcript goes through normaliseTranscript before anything stores it, the transcribed
// audio may not be longer than the audio asked about, and the bill is read only from its documented field. A bill that cannot be read
// leaves the call unsettled (contract v6): the transcript is still returned, with billNote saying why.
//
// Facts the adapter relies on, from Deepgram's API reference read on 2026-10-16 (the owner's live run confirms them):
//   - POST /v1/listen?model=<model>&smart_format=true&language=<primary tag>, with "Authorization: Token <key>" added by the gateway.
//   - The body is {"url": "..."} as application/json for a URL, or the raw bytes as application/octet-stream.
//   - The words are at results.channels[0].alternatives[0].words[] (word, start, end in seconds, confidence).
//   - metadata.request_id and metadata.duration (seconds).
//   - The bill is at request.response.details.usd (USD) in the request lookup.
// Deepgram documents no idempotency header in that reference, so the idempotency key stays on the ledger and is not sent. The ledger
// refuses a repeat before the call (stt.ts), and that is the only dedupe.

import { z } from "zod";
import { FFMPEG_LIMITS } from "../../../functions/ffmpeg/limits.ts";
import type { MediaSource } from "../../../functions/ffmpeg/types.ts";
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
 * Statuses that refuse the call before any work (contract v6, Bible 10.4): a bad request, a bad key, a forbidden call. Deepgram
 * bills nothing for them, so the hold is settled as confirmed absent. Every other status keeps its hold: the vendor may have billed it.
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

export type DeepgramOptions = {
  /** The stt route (gateway.route("stt")). Its provider must be deepgram, and its model is the one requested. */
  route: ResolvedRoute;
  /** The API gateway. Only its call() is used, so the key and the host stay inside it. */
  gateway: Pick<Gateway, "call">;
  /** The workspace the call is for. Its key is the workspace's. */
  organizationId: string | null;
  /** Deepgram's project id: a non-secret setting the composition root supplies (media/STATUS.md). */
  projectId: string;
};

type Deps = {
  gateway: Pick<Gateway, "call">;
  organizationId: string | null;
  projectId: string;
  model: string;
};

/**
 * The Deepgram adapter for the stt route. It refuses a route that is not Deepgram's, a model id or project id that is not valid, and
 * sends nothing. A request the adapter cannot make (a URL that is not https, an empty file, a language it cannot send) is refused before
 * anything is sent, and is marked as refused before any work, so the ledger settles it as confirmed absent.
 */
export function deepgramSpeechToText(options: DeepgramOptions): SpeechToText {
  const { route } = options;
  if (route.provider.id !== DEEPGRAM_PROVIDER) {
    throw new EngineError("config", `the stt route names ${route.provider.id}, not ${DEEPGRAM_PROVIDER}`, { stage: STAGE });
  }
  if (!MODEL_PATTERN.test(route.model)) {
    throw new EngineError("config", "the deepgram model id in the stt route is not valid", { stage: STAGE });
  }
  if (!PROJECT_ID_PATTERN.test(options.projectId)) {
    throw new EngineError("config", "the deepgram project id is not valid (a non-secret setting, see media/STATUS.md)", { stage: STAGE });
  }
  const deps: Deps = {
    gateway: options.gateway,
    organizationId: options.organizationId,
    projectId: options.projectId,
    model: route.model,
  };
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
  let listen: { path: string; contentType: string; body: string | Uint8Array };
  try {
    listen = listenRequest(deps.model, request);
  } catch (error) {
    throw notSent(error);
  }
  const response = await send(deps, {
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
  // The response names no language (detect_language is off), so the language is the one the request asked the vendor to use.
  const normalised = normaliseTranscript(
    {
      language: request.language,
      words: alternative.words.map((word) => ({
        text: word.word,
        start: word.start,
        end: word.end,
        confidence: word.confidence,
      })),
    },
    request,
  );
  const bill = await readBill(deps, answer.metadata.request_id);
  return {
    words: normalised.words,
    language: normalised.language,
    billedUsd: bill.billedUsd,
    ...(bill.billNote === undefined ? {} : { billNote: bill.billNote }),
  };
}

type Bill = { billedUsd: number | null; billNote?: string };

function held(reason: string): Bill {
  return { billedUsd: null, billNote: `${reason}; the call stays held (contract v6)` };
}

/**
 * The bill of one transcription, from the request lookup. Any failure, a missing or unusable amount, or an answer for another request
 * leaves the call unsettled. The transcript is kept, and nothing is booked as the actual cost.
 */
async function readBill(deps: Deps, requestId: string | undefined): Promise<Bill> {
  if (requestId === undefined || !REQUEST_ID_PATTERN.test(requestId)) {
    return held("the answer names no usable request id, so the bill cannot be read");
  }
  const path = `/v1/projects/${encodeURIComponent(deps.projectId)}/requests/${encodeURIComponent(requestId)}`;
  let response: HttpResponse;
  try {
    response = await send(deps, { method: "GET", path, timeoutMs: mediaConfig.speechToText.billTimeoutMs });
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
  const query = new URLSearchParams({
    model,
    smart_format: "true",
    language: primaryLanguage(request.language),
  });
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
 * One request through the gateway. The gateway returns not_connected, or throws before it sends, for a provider it cannot reach: those
 * calls were never sent, so they are refused before any work. Any other failure came from the transport after the request was sent,
 * and is classified as the router classifies it: a timeout or a server error keeps its hold.
 */
async function send(deps: Deps, call: Call): Promise<HttpResponse> {
  let result: GatewayResult;
  try {
    result = await deps.gateway.call({ ...call, provider: DEEPGRAM_PROVIDER, organizationId: deps.organizationId });
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
