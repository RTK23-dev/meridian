// OpenRouter, the default platform (owner decision 2026-10-14): structured chat for the Claude roles and asynchronous video
// generation. Both go through the gateway, which picks the model from config/routes.ts and adds the key. Every answer is
// untrusted data: it is validated with zod and never run or passed on as an instruction (CLAUDE.md rule 8).
//
// API shapes: POST /chat/completions with response_format json_schema; POST /videos, then GET /videos/{id} until the status
// is completed, failed, cancelled or expired (openrouter.ai/docs, video-generation). Both report usage.cost in USD.

import { z, type ZodType } from "zod";
import { EngineError } from "../contracts/errors.ts";
import type { ProviderPoll } from "../contracts/assets.ts";
import type { Capability } from "../config/routes.ts";
import { httpError, jsonBody } from "./errors.ts";
import type { Gateway, ResolvedRoute } from "./gateway.ts";
import { noteAnswer } from "./telemetry.ts";

const PROVIDER = "openrouter";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export type StructuredChatInput<T> = {
  organizationId: string | null;
  capability: Capability;
  /** The route the call goes to. Without it the capability's route table entry is used (a chosen model passes its own route). */
  route?: ResolvedRoute;
  messages: ChatMessage[];
  /** The answer's schema. It is sent as a JSON schema and the answer is parsed with it. */
  schema: ZodType<T>;
  schemaName: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  stage?: string;
};

export type ChatUsage = { promptTokens: number | null; completionTokens: number | null; costUsd: number | null };

export type StructuredChatResult<T> = {
  value: T;
  /** The model OpenRouter says answered, which can differ from the routed one when OpenRouter falls back. */
  model: string | null;
  generationId: string | null;
  usage: ChatUsage;
};

const chatResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }), finish_reason: z.string().nullable().optional() }))
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), cost: z.number().optional() })
    .optional(),
});

function openRouterRoute(gateway: Gateway, capability: Capability): ResolvedRoute {
  const route = gateway.route(capability);
  if (route.provider.id !== PROVIDER) {
    throw new EngineError("config", `capability ${capability} is routed to ${route.provider.id}, not OpenRouter`);
  }
  return route;
}

function cost(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Thrown when the model's answer does not match the schema. The issues name paths only, never the model's text. */
export class StructuredOutputError extends EngineError {
  issues: string[];
  /** What the call used and cost, when OpenRouter reported it. The call was billed even though the answer failed. */
  usage: ChatUsage | null;
  constructor(schemaName: string, issues: string[], stage?: string, usage: ChatUsage | null = null) {
    super("provider", `the answer did not match ${schemaName}: ${issues.join("; ")}`, { stage });
    this.issues = issues;
    this.usage = usage;
  }
}

/** The JSON schema sent to OpenRouter for a zod schema. */
export function jsonSchemaFor(schema: ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export async function structuredChat<T>(gateway: Gateway, input: StructuredChatInput<T>): Promise<StructuredChatResult<T>> {
  const route = input.route ?? openRouterRoute(gateway, input.capability);
  const result = await gateway.call({
    provider: PROVIDER,
    organizationId: input.organizationId,
    method: "POST",
    path: "/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: route.model,
      messages: input.messages,
      max_tokens: input.maxTokens,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      response_format: { type: "json_schema", json_schema: { name: input.schemaName, strict: true, schema: jsonSchemaFor(input.schema) } },
    }),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (result.status === "not_connected") {
    throw new EngineError("config", `OpenRouter is not connected: ${result.reason}`, { stage: input.stage });
  }
  const response = result.response;
  if (response.status < 200 || response.status >= 300) throw httpError(PROVIDER, response, input.stage);

  const parsed = chatResponseSchema.safeParse(jsonBody(PROVIDER, response, input.stage));
  if (!parsed.success) throw new EngineError("provider", "OpenRouter answered with an unexpected chat shape", { stage: input.stage });
  const body = parsed.data;
  const usage: ChatUsage = {
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    costUsd: cost(body.usage?.cost),
  };
  // Recorded before the answer is checked: a billed answer that fails its schema keeps what it reported (telemetry.ts).
  if (result.sample !== undefined) {
    noteAnswer(result.sample, { generationId: body.id ?? null, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd });
  }

  const content = body.choices[0]?.message.content ?? null;
  if (content === null || content.trim() === "") {
    throw new StructuredOutputError(input.schemaName, ["the answer was empty"], input.stage, usage);
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new StructuredOutputError(input.schemaName, ["the answer was not JSON"], input.stage, usage);
  }
  const answer = input.schema.safeParse(json);
  if (!answer.success) {
    const issues = answer.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
    throw new StructuredOutputError(input.schemaName, issues, input.stage, usage);
  }
  return { value: answer.data, model: body.model ?? null, generationId: body.id ?? null, usage };
}

// ---- video -----------------------------------------------------------------------------------------------------------

export type VideoSubmitInput = {
  organizationId: string | null;
  capability: Capability;
  /** A model the caller chose from the live catalog. Without it the capability's route table model is used (none is named now). */
  model?: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  generateAudio: boolean;
  signal?: AbortSignal;
  stage?: string;
};

const videoJobSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "expired"]),
  error: z.string().optional(),
  generation_id: z.string().optional(),
  unsigned_urls: z.array(z.string().url()).optional(),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

/**
 * Submits one generation and returns OpenRouter's job id. First and last frames are not sent yet: which models accept them
 * is Bible 20.3 item 2, checked in E2.
 */
export async function submitVideo(gateway: Gateway, input: VideoSubmitInput): Promise<{ jobId: string; model: string }> {
  const route = input.model === undefined ? openRouterRoute(gateway, input.capability) : gateway.chosen(input.capability, input.model);
  const result = await gateway.call({
    provider: PROVIDER,
    organizationId: input.organizationId,
    method: "POST",
    path: "/videos",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: route.model,
      prompt: input.prompt,
      duration: input.durationSeconds,
      aspect_ratio: input.aspectRatio,
      ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
      generate_audio: input.generateAudio,
    }),
    signal: input.signal,
  });
  if (result.status === "not_connected") {
    throw new EngineError("config", `OpenRouter is not connected: ${result.reason}`, { stage: input.stage });
  }
  if (result.response.status < 200 || result.response.status >= 300) throw httpError(PROVIDER, result.response, input.stage);
  const job = videoJobSchema.safeParse(jsonBody(PROVIDER, result.response, input.stage));
  if (!job.success) throw new EngineError("provider", "OpenRouter answered the video submit with an unexpected shape", { stage: input.stage });
  if (result.sample !== undefined) {
    noteAnswer(result.sample, { generationId: job.data.generation_id ?? null, promptTokens: null, completionTokens: null, costUsd: cost(job.data.usage?.cost) });
  }
  return { jobId: job.data.id, model: route.model };
}

/** One poll, mapped to the asset router's ProviderPoll (Bible 10.1). The video URL is OpenRouter's, served through the gateway. */
export async function pollVideo(gateway: Gateway, organizationId: string | null, jobId: string, stage?: string): Promise<ProviderPoll> {
  const result = await gateway.call({ provider: PROVIDER, organizationId, method: "GET", path: `/videos/${encodeURIComponent(jobId)}` });
  if (result.status === "not_connected") throw new EngineError("config", `OpenRouter is not connected: ${result.reason}`, { stage });
  const response = result.response;
  if (response.status < 200 || response.status >= 300) {
    const error = httpError(PROVIDER, response, stage);
    if (error.retryable) return { state: "pending" };
    return { state: "failed", error: { kind: response.status === 400 ? "invalid_input" : "unknown", retryable: false, message: error.message } };
  }
  const job = videoJobSchema.safeParse(jsonBody(PROVIDER, response, stage));
  if (!job.success) throw new EngineError("provider", "OpenRouter answered the video poll with an unexpected shape", { stage });
  const actualUsd = cost(job.data.usage?.cost);
  if (job.data.status === "pending" || job.data.status === "in_progress") return { state: "pending" };
  if (job.data.status === "completed") {
    const uri = job.data.unsigned_urls?.[0];
    if (!uri) return { state: "failed", error: { kind: "server", retryable: false, message: "OpenRouter reported completed with no video URL" } };
    return { state: "done", uri, ...(actualUsd === null ? {} : { actualUsd }) };
  }
  return {
    state: "failed",
    error: { kind: "unknown", retryable: false, message: `OpenRouter video job ${job.data.status}${job.data.error ? `: ${job.data.error.slice(0, 300)}` : ""}` },
    ...(actualUsd === null ? {} : { actualUsd }),
  };
}

// ---- route check -----------------------------------------------------------------------------------------------------

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * Checks every OpenRouter model id in the route table against GET /models, which is free. Used in the owner's live run to
 * turn `verified: false` entries into checked ones. Sends one request; spends nothing.
 */
export async function verifyRoutes(
  gateway: Gateway,
  capabilities: readonly Capability[],
): Promise<Array<{ capability: Capability; model: string; listed: boolean }>> {
  const result = await gateway.call({ provider: PROVIDER, organizationId: null, method: "GET", path: "/models" });
  if (result.status === "not_connected") throw new EngineError("config", `OpenRouter is not connected: ${result.reason}`);
  if (result.response.status !== 200) throw httpError(PROVIDER, result.response);
  const listing = modelsSchema.safeParse(jsonBody(PROVIDER, result.response));
  if (!listing.success) throw new EngineError("provider", "OpenRouter answered the models listing with an unexpected shape");
  const ids = new Set(listing.data.data.map((model) => model.id));
  const checked: Array<{ capability: Capability; model: string; listed: boolean }> = [];
  for (const capability of capabilities) {
    for (const route of gateway.routes(capability)) {
      if (route.provider.id === PROVIDER) checked.push({ capability, model: route.model, listed: ids.has(route.model) });
    }
  }
  return checked;
}
