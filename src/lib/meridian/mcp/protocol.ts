// The Model Context Protocol, as much of it as Meridian's connector serves: JSON-RPC 2.0 messages over one HTTP POST, answered as JSON
// (Streamable HTTP without a server stream, which the transport allows). Pure: the tools and the caller's context are passed in, so the
// protocol is tested without a network or a database.
//
// Served: initialize, ping, tools/list, tools/call, prompts/list, prompts/get (one-click starters a client may show), and the client's
// notifications (accepted, never answered). Anything else is
// "method not found". A tool that fails returns a result with isError, as the protocol asks, so the chat can read the reason and act on
// it; a call to an unknown tool, or with arguments that do not fit, is an invalid-params error.

import { z } from "zod";
import { hasRole, type Role } from "../access.ts";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INFO = { name: "meridian", title: "Meridian", version: "1.0.0" } as const;

/** What the chat is told about Meridian when it connects: who does what, so it spends only where a chat cannot do the work itself. */
export const SERVER_INSTRUCTIONS = [
  "Meridian is the brand's video studio. When the person connects Meridian or asks for a video, call meridian_start FIRST and ask its",
  "short Q&A in one message (numbered questions, lettered options, their own words welcome). Then call meridian_project_create with",
  "their answers and follow the next step every tool returns. The person chose how involved to be: in Studio mode they choose at every",
  "checkpoint, in Guided mode the script and the final cut, in Orchestrator mode you decide. At a person's checkpoint, record the",
  "options (meridian_checkpoint propose), show them, and WAIT for their answer before resolving; never answer for them.",
  "You write the concept, script, storyboard and the coded video (a HyperFrames composition) yourself, free to the workspace. Meridian",
  "only does what a chat cannot: voiceovers, images, decisions from its decision engine, and storage, each paid from the workspace's",
  "own limits; pass the projectId so the video's budget applies. Every cost a tool reports is the provider's own figure.",
].join(" ");

export type JsonRpcId = string | number;
export type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId | null; method: string; params?: unknown };
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export const ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

/** One block of a tool's answer. Images and audio travel as base64, as the protocol's content types do. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

/** What a tool returns: the words the chat reads, the same facts as data, and any media to show. */
export type ToolResult = { text: string; data?: Record<string, unknown>; media?: ToolContent[]; isError?: boolean };

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

/** One tool: its name and words for the chat, the arguments it takes (a zod schema, sent as JSON Schema), the least role it needs, and its run. */
export type McpTool<C> = {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  role: Role;
  annotations: ToolAnnotations;
  run: (context: C, input: never) => Promise<ToolResult>;
};

/** Builds a tool with its input type checked against its schema. */
export function defineTool<C, S extends z.ZodType>(tool: {
  name: string;
  title: string;
  description: string;
  input: S;
  role: Role;
  annotations: ToolAnnotations;
  run: (context: C, input: z.infer<S>) => Promise<ToolResult>;
}): McpTool<C> {
  return tool as unknown as McpTool<C>;
}

/** The tools/list entry of a tool: its arguments as a JSON Schema object. */
export function toolListing(tool: McpTool<unknown>): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: schema, annotations: { title: tool.title, ...tool.annotations } };
}

/** A prompt a client may offer the person as a one-click starter. Its messages are fixed text with the person's arguments filled in. */
export type McpPrompt = {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  messages: (args: Record<string, string>) => Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

export type ProtocolContext<C> = {
  role: Role;
  tools: ReadonlyArray<McpTool<C>>;
  prompts?: ReadonlyArray<McpPrompt>;
  context: C;
  onToolError?: (name: string, error: unknown) => void;
  /** Called after every tool call that ran, with its arguments and whether it failed (for the audit log). */
  onToolResult?: (name: string, args: Record<string, unknown>, result: ToolResult) => Promise<void> | void;
};

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const idOk = message.id === undefined || message.id === null || typeof message.id === "string" || typeof message.id === "number";
  return message.jsonrpc === "2.0" && typeof message.method === "string" && idOk;
}

/** The answer content: the text first, then any media, and the structured data alongside. */
export function callResult(result: ToolResult): Record<string, unknown> {
  return {
    content: [{ type: "text", text: result.text }, ...(result.media ?? [])],
    ...(result.data ? { structuredContent: result.data } : {}),
    isError: result.isError === true,
  };
}

/** The version to speak: the client's, when Meridian speaks it, else the newest Meridian speaks. */
export function negotiatedVersion(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
}

/** Answers one message. A notification (no id) gets no answer. */
export async function handleMessage<C>(message: unknown, protocol: ProtocolContext<C>): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) return failure(null, ERROR.invalidRequest, "Not a JSON-RPC 2.0 request.");
  const id = message.id ?? null;
  const notification = message.id === undefined;
  if (notification) return null;
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;

  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiatedVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false }, ...(protocol.prompts && protocol.prompts.length > 0 ? { prompts: { listChanged: false } } : {}) },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: (protocol.prompts ?? []).map((prompt) => ({ name: prompt.name, title: prompt.title, description: prompt.description, arguments: prompt.arguments })) } };
    case "prompts/get": {
      const prompt = (protocol.prompts ?? []).find((item) => item.name === params.name);
      if (!prompt) return failure(id, ERROR.invalidParams, `There is no prompt named '${String(params.name ?? "")}'.`);
      const given = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      const args = Object.fromEntries(Object.entries(given).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, (value as string).slice(0, 2000)]));
      const missing = prompt.arguments.find((argument) => argument.required && !args[argument.name]?.trim());
      if (missing) return failure(id, ERROR.invalidParams, `The prompt needs '${missing.name}'.`);
      return { jsonrpc: "2.0", id, result: { description: prompt.description, messages: prompt.messages(args) } };
    }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: protocol.tools.map((tool) => toolListing(tool as McpTool<unknown>)) } };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = protocol.tools.find((item) => item.name === name);
      if (!tool) return failure(id, ERROR.invalidParams, `There is no tool named '${name}'.`);
      const parsed = tool.input.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return failure(id, ERROR.invalidParams, `${issue?.path.join(".") || "arguments"}: ${issue?.message ?? "does not fit"}`);
      }
      // The role is the link maker's current role in the workspace, read for this request; a tool needing more is refused by name.
      if (!hasRole(protocol.role, tool.role)) {
        return { jsonrpc: "2.0", id, result: callResult({ text: `${tool.title} needs the ${tool.role} role in this workspace; this connector acts as ${protocol.role}. Nothing was done.`, isError: true }) };
      }
      let result: ToolResult;
      try {
        result = await tool.run(protocol.context, parsed.data as never);
      } catch (error) {
        protocol.onToolError?.(name, error);
        const reason = error instanceof Error && error.message ? error.message : "The tool failed.";
        result = { text: `${tool.title} failed: ${reason}`, isError: true };
      }
      await Promise.resolve(protocol.onToolResult?.(name, parsed.data as Record<string, unknown>, result)).catch(() => undefined);
      return { jsonrpc: "2.0", id, result: callResult(result) };
    }
    default:
      return failure(id, ERROR.methodNotFound, `Meridian does not serve '${message.method}'.`);
  }
}

/** Answers a POST body: one message or a batch. Null when nothing needs an answer (only notifications). */
export async function handleBody<C>(body: unknown, protocol: ProtocolContext<C>): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return failure(null, ERROR.invalidRequest, "An empty batch.");
    const answers: JsonRpcResponse[] = [];
    for (const message of body) {
      const answer = await handleMessage(message, protocol);
      if (answer) answers.push(answer);
    }
    return answers.length > 0 ? answers : null;
  }
  return handleMessage(body, protocol);
}
