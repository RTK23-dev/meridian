// The connector's HTTP endpoint, framework-free (a Web Request in, a Response out), so the routes stay thin and the handler is tested
// without a server. One POST carries one JSON-RPC message or a batch; the answer is JSON. There is no server stream and no session id:
// every call is authorised on its own, by the link's secret (or a Bearer header), and the maker's role is read for that call.
//
// Refusals say what to do and nothing more: an unknown, revoked or orphaned link is the same 401, so a guesser learns nothing. Calls are
// limited per link, bodies are capped, and every paid tool call is written to the audit log with its outcome.

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { resolveConnector, secretFrom, type ResolvedConnector } from "./connectors.ts";
import { linkSecretFrom } from "./files.ts";
import { ERROR, handleBody } from "./protocol.ts";
import { CONNECTOR_PROMPTS, connectorTools } from "./registry.ts";
import type { ConnectorContext, ConnectorPorts } from "./tools.ts";

export const MCP_MAX_BODY_BYTES = 1_000_000;
export const MCP_CALLS_PER_MINUTE = 60;
const PAID_TOOLS = new Set(["meridian_voiceover", "meridian_image", "meridian_decide"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

export type McpHttpDeps = {
  getSql: () => Promise<Sql>;
  ports: (sql: Sql, connector: ResolvedConnector) => ConnectorPorts;
  env: Record<string, string | undefined>;
  now?: () => Date;
  allow?: (key: string, nowMs: number) => boolean;
  logError?: (message: string, detail: unknown) => void;
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra } });
}

function rpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { jsonrpc: "2.0", id: null, error: { code, message } }, extra);
}

/** The public origin links are made under: the deployment's own URL when set, else the request's. */
export function publicOrigin(request: Request, env: Record<string, string | undefined>): string {
  for (const name of ["PUBLIC_APP_URL", "APP_URL", "BETTER_AUTH_URL"]) {
    const value = env[name]?.trim();
    if (value && /^https?:\/\//.test(value)) return new URL(value).origin;
  }
  return new URL(request.url).origin;
}

export async function handleMcpRequest(request: Request, input: { pathSecret: string | null }, deps: McpHttpDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") {
    return rpcError(405, ERROR.invalidRequest, "Meridian's connector answers POST only; it keeps no server stream.", { allow: "POST, OPTIONS" });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) return rpcError(413, ERROR.invalidRequest, "The request is too large.");

  const secret = secretFrom({ pathSecret: input.pathSecret, authorization: request.headers.get("authorization") });
  const unauthorized = () => rpcError(401, ERROR.invalidRequest, "This connector link is not valid. Make a new one in Meridian: Settings, Connections, Claude connector.");
  if (!secret) return unauthorized();

  const text = await request.text();
  if (text.length > MCP_MAX_BODY_BYTES) return rpcError(413, ERROR.invalidRequest, "The request is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, ERROR.parse, "The body is not JSON.");
  }

  const now = deps.now ?? (() => new Date());
  const sql = await deps.getSql();
  const connector = await resolveConnector(sql, secret, now());
  if (!connector) return unauthorized();
  if (deps.allow && !deps.allow(connector.id, now().getTime())) {
    return rpcError(429, ERROR.invalidRequest, `Too many calls: a connector may make ${MCP_CALLS_PER_MINUTE} a minute. Wait a moment and try again.`, { "retry-after": "60" });
  }

  const context: ConnectorContext = { sql, connector, origin: publicOrigin(request, deps.env), now, linkSecret: linkSecretFrom(deps.env), ports: deps.ports(sql, connector) };
  const answer = await handleBody(body, {
    role: connector.role,
    tools: connectorTools(),
    prompts: CONNECTOR_PROMPTS,
    context,
    onToolError: (name, error) => deps.logError?.(`mcp tool ${name} failed`, error instanceof Error ? error.message : error),
    onToolResult: async (name, args, result) => {
      if (!PAID_TOOLS.has(name)) return;
      const brandId = typeof args.brandId === "string" ? args.brandId : null;
      await sql`
        insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        select ${randomUUID()}, ${connector.organizationId}, b.id, ${connector.userId}, ${`mcp.${name}`}, 'mcp_connector', ${connector.id},
          ${JSON.stringify({ tool: name, outcome: result.isError ? "refused_or_failed" : "done" })}
        from (select ${brandId}::text as wanted) w left join brands b on b.id = w.wanted and b.organization_id = ${connector.organizationId}
      `;
    },
  });
  if (answer === null) return new Response(null, { status: 202, headers: CORS });
  return json(200, answer);
}
