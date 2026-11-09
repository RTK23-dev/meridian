// The connector's pure parts: the protocol answers initialize, lists tools with JSON Schemas, ignores notifications, refuses unknown
// methods and bad arguments, refuses a tool above the link's role, and turns a thrown tool into an error result; a paid call is held
// before it is sent, released when nothing was sent, kept when it may have been billed, and settled at the reported cost or the ceiling;
// a file link is signed, expires, and is never valid for another file; a secret is taken from the link or a Bearer header only.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { CONNECTOR_SECRET_PREFIX, hashConnectorSecret, isConnectorSecret, newConnectorSecret, secretFrom } from "./connectors.ts";
import { fileLink, MCP_FILE_LINK_TTL_SECONDS, verifyFileLink } from "./files.ts";
import { NotSentError, UNPRICED_CEILING_ESTIMATOR, withBrandHold, type HoldLedger } from "./paid.ts";
import { defineTool, ERROR, handleBody, handleMessage, MCP_PROTOCOL_VERSIONS, type McpTool, type ProtocolContext } from "./protocol.ts";
import { connectorTools } from "./registry.ts";
import { VIDEO_GUIDE } from "./tools.ts";

type Ctx = { calls: string[] };
const echo = defineTool<Ctx, z.ZodObject<{ word: z.ZodString }>>({
  name: "echo",
  title: "Echo",
  description: "Says the word back.",
  input: z.object({ word: z.string().min(1) }),
  role: "viewer",
  annotations: { readOnlyHint: true },
  async run(context, input) {
    context.calls.push(input.word);
    return { text: input.word, data: { word: input.word } };
  },
});
const adminOnly = defineTool<Ctx, z.ZodObject<Record<string, never>>>({ name: "admin_only", title: "Admin only", description: "x", input: z.object({}), role: "admin", annotations: {}, run: async () => ({ text: "done" }) });
const broken = defineTool<Ctx, z.ZodObject<Record<string, never>>>({ name: "broken", title: "Broken", description: "x", input: z.object({}), role: "viewer", annotations: {}, run: async () => { throw new Error("the provider answered nonsense"); } });

function protocol(role: ProtocolContext<Ctx>["role"] = "member") {
  const context: Ctx = { calls: [] };
  const results: string[] = [];
  return { context, results, value: { role, tools: [echo, adminOnly, broken] as McpTool<Ctx>[], context, onToolResult: (name: string) => void results.push(name) } satisfies ProtocolContext<Ctx> };
}

describe("MCP protocol", () => {
  it("answers initialize with the client's version when served, and the newest otherwise", async () => {
    const { value } = protocol();
    const known = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, value);
    assert.equal((known as { result: { protocolVersion: string } }).result.protocolVersion, "2025-03-26");
    const unknown = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, value);
    const result = (unknown as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string }; instructions: string } }).result;
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.equal(result.serverInfo.name, "meridian");
    assert.match(result.instructions, /Orchestrator mode you decide/);
  });

  it("lists tools with a JSON Schema for their arguments", async () => {
    const { value } = protocol();
    const answer = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, value)) as { result: { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } }> } };
    const listed = answer.result.tools.find((tool) => tool.name === "echo")!;
    assert.equal(listed.inputSchema.type, "object");
    assert.deepEqual(listed.inputSchema.required, ["word"]);
    assert.ok(!("$schema" in listed.inputSchema));
  });

  it("ignores notifications, refuses unknown methods and malformed messages", async () => {
    const { value } = protocol();
    assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, value), null);
    const unknown = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, value)) as { error: { code: number } };
    assert.equal(unknown.error.code, ERROR.methodNotFound);
    const malformed = (await handleMessage({ id: 4, method: "ping" }, value)) as { error: { code: number } };
    assert.equal(malformed.error.code, ERROR.invalidRequest);
    assert.equal(await handleBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], value), null, "a batch of notifications needs no answer");
  });

  it("calls a tool, refuses bad arguments and unknown tools as invalid params, and a higher role by name", async () => {
    const { value, context, results } = protocol("member");
    const ok = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { word: "hook" } } }, value)) as { result: { content: Array<{ text: string }>; structuredContent: unknown; isError: boolean } };
    assert.equal(ok.result.content[0]!.text, "hook");
    assert.deepEqual(ok.result.structuredContent, { word: "hook" });
    assert.equal(ok.result.isError, false);
    assert.deepEqual(context.calls, ["hook"]);
    const bad = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { word: "" } } }, value)) as { error: { code: number; message: string } };
    assert.equal(bad.error.code, ERROR.invalidParams);
    assert.match(bad.error.message, /^word:/);
    const missing = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }, value)) as { error: { code: number } };
    assert.equal(missing.error.code, ERROR.invalidParams);
    const refused = (await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "admin_only" } }, value)) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0]!.text, /needs the admin role/);
    assert.deepEqual(results, ["echo"], "a refused or invalid call is not recorded as run");
  });

  it("turns a thrown tool into an error result the chat can read", async () => {
    const { value, results } = protocol();
    const answer = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "broken" } }, value)) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(answer.result.isError, true);
    assert.match(answer.result.content[0]!.text, /Broken failed: the provider answered nonsense/);
    assert.deepEqual(results, ["broken"]);
  });

  it("lists every connector tool with a valid schema, and the guide names the render command", () => {
    const tools = connectorTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "meridian_start", "meridian_project_create", "meridian_project", "meridian_checkpoint", "meridian_project_update",
      "meridian_status", "meridian_brand", "meridian_video_guide", "meridian_voice_models", "meridian_voiceover", "meridian_image", "meridian_decide", "meridian_files", "meridian_render",
    ]);
    for (const tool of tools) assert.ok(z.toJSONSchema(tool.input), tool.name);
    const paid = tools.filter((tool) => ["meridian_voiceover", "meridian_image", "meridian_decide"].includes(tool.name));
    assert.ok(paid.every((tool) => tool.role === "member" && tool.annotations.readOnlyHint === false), "paid tools need a member and are never marked read-only");
    assert.match(VIDEO_GUIDE, /hyperframes@0\.8\.154 render -o video\.mp4/);
  });
});

describe("paid calls under a brand hold", () => {
  function ledger(refuse?: string) {
    const events: string[] = [];
    const value: HoldLedger = {
      async reserve(input) {
        if (refuse) throw new Error(refuse);
        events.push(`reserve ${input.amountMicros}`);
        return { id: "res-1" };
      },
      async settle(input) {
        events.push(`settle ${input.cost.basis} ${"amountMicros" in input.cost ? input.cost.amountMicros : ""}${input.cost.basis === "ESTIMATED" ? ` ${input.cost.estimatorVersion}` : ""}`);
      },
      async release(input) {
        events.push(`release ${input.reservationId}`);
      },
    };
    return { events, value };
  }
  const scope = { organizationId: "o", brandId: "b", ceilingUsd: 1, purpose: "image" };

  it("sends nothing when the budget refuses the hold", async () => {
    const { value, events } = ledger("No budget is set for this brand.");
    let called = false;
    const outcome = await withBrandHold(value, scope, async () => { called = true; return { value: 1, costUsd: 0.1 }; });
    assert.equal(called, false);
    assert.deepEqual(outcome, { ok: false, held: false, reason: "No budget is set for this brand. Nothing was sent." });
    assert.deepEqual(events, []);
  });

  it("settles at the reported cost, or at the ceiling when none is reported", async () => {
    const reported = ledger();
    const a = await withBrandHold(reported.value, scope, async () => ({ value: "x", costUsd: 0.04 }));
    assert.deepEqual(reported.events, ["reserve 1000000", "settle PROVIDER_ACTUAL 40000"]);
    assert.ok(a.ok && a.basis === "reported" && a.settledUsd === 0.04);
    const unknown = ledger();
    const b = await withBrandHold(unknown.value, scope, async () => ({ value: "x", costUsd: null }));
    assert.deepEqual(unknown.events, ["reserve 1000000", `settle ESTIMATED 1000000 ${UNPRICED_CEILING_ESTIMATOR}`]);
    assert.ok(b.ok && b.basis === "ceiling" && b.costUsd === null);
  });

  it("releases the hold when nothing was sent, and keeps it when the provider may have been reached", async () => {
    const notSent = ledger();
    const a = await withBrandHold(notSent.value, scope, async () => { throw new NotSentError("OpenRouter is not connected."); });
    assert.deepEqual(notSent.events, ["reserve 1000000", "release res-1"]);
    assert.ok(!a.ok && !a.held);
    const maybe = ledger();
    const b = await withBrandHold(maybe.value, scope, async () => { throw new Error("The connection dropped."); });
    assert.deepEqual(maybe.events, ["reserve 1000000"]);
    assert.ok(!b.ok && b.held);
    assert.match(b.ok ? "" : b.reason, /stays held on the brand budget/);
  });
});

describe("connector secrets and file links", () => {
  it("makes a secret of the expected shape, hashes it, and reads it only from the link or a Bearer header", () => {
    const secret = newConnectorSecret();
    assert.ok(secret.startsWith(CONNECTOR_SECRET_PREFIX) && isConnectorSecret(secret));
    assert.notEqual(newConnectorSecret(), secret);
    assert.match(hashConnectorSecret(secret), /^[0-9a-f]{64}$/);
    assert.equal(secretFrom({ pathSecret: secret }), secret);
    assert.equal(secretFrom({ pathSecret: null, authorization: `Bearer ${secret}` }), secret);
    assert.equal(secretFrom({ pathSecret: "guess", authorization: "Bearer guess" }), null);
    assert.equal(secretFrom({ pathSecret: null, authorization: `Basic ${secret}` }), null);
  });

  it("signs a file link for an hour, refuses it after, and never for another file", () => {
    const secret = "s".repeat(40);
    const link = fileLink({ origin: "https://meridian.example/", fileId: "f1", nowSeconds: 1_000, secret })!;
    const url = new URL(link.url);
    assert.equal(url.pathname, "/api/mcp-files/f1");
    const check = (fileId: string, nowSeconds: number) => verifyFileLink({ fileId, expires: url.searchParams.get("expires"), sig: url.searchParams.get("sig"), secret, nowSeconds });
    assert.equal(check("f1", 1_000 + MCP_FILE_LINK_TTL_SECONDS - 1), "ok");
    assert.equal(check("f1", 1_000 + MCP_FILE_LINK_TTL_SECONDS), "expired");
    assert.equal(check("f2", 1_001), "bad_signature");
    assert.equal(fileLink({ origin: "https://meridian.example", fileId: "f1", nowSeconds: 1_000, secret: null }), null, "no secret, no link");
  });
});
