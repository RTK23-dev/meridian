// The connector routes' shared dependencies: the database, the production ports and a per-link rate limit held in this process.
import { getSql } from "../../db.ts";
import { createRateLimit } from "../security/limits.ts";
import { MCP_CALLS_PER_MINUTE, type McpHttpDeps } from "./handler.ts";
import { productionPorts } from "./ports.server.ts";

const limit = createRateLimit(MCP_CALLS_PER_MINUTE, 60_000);

export function mcpRouteDeps(): McpHttpDeps {
  return {
    getSql,
    ports: productionPorts,
    env: process.env,
    allow: (key, nowMs) => limit.allow(key, nowMs),
    logError: (message, detail) => console.error(message, detail),
  };
}
