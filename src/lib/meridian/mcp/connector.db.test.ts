// The connector end to end, on the test database, with fake providers (no test calls a provider): an admin makes a link and sees it
// listed without its secret; the link reaches its workspace over HTTP; status shows the brand budget; a voiceover and an image are held on
// the brand budget, stored and linked, and settle at the reported cost or the ceiling; a brand with no budget sends nothing; a viewer's
// link cannot spend; a revoked link, or one whose maker left, is refused like an unknown one; every paid call is audited.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import { createConnector, listConnectors, resolveConnector, revokeConnector } from "./connectors.ts";
import { meridianMcpFileStore, type McpFileStore } from "./files.ts";
import { serveMcpFile } from "./serve-file.server.ts";
import { handleMcpRequest, type McpHttpDeps } from "./handler.ts";
import { NotSentError, sqlHoldLedger } from "./paid.ts";
import type { ConnectorPorts } from "./tools.ts";

const WS = "ws_mcp";
const BRAND = "brand_mcp";
const BARE_BRAND = "brand_mcp_bare";
const ADMIN = "user_mcp_admin";
const VIEWER = "user_mcp_viewer";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 5, 6, 7]);

async function seedUser(sql: Sql, userId: string, role: string): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${WS}, ${userId}, ${role})`;
}

function memoryFiles(): McpFileStore & { puts: string[] } {
  const bytes = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    puts,
    ready: async () => ({ status: "ready" }),
    async put(input) {
      puts.push(input.key);
      bytes.set(input.key, input.bytes);
      return { storageObjectId: null };
    },
    get: async (input) => bytes.get(input.key) ?? null,
  };
}

describe("MCP connector", () => {
  let db: TestDatabase;
  const files = memoryFiles();
  // The files port. Most tests use the in-memory store; the test of a video without a brand uses Meridian's real database store.
  let filesPort: McpFileStore = files;
  const spoken: string[] = [];
  const env = { MEDIA_LINK_SECRET: "m".repeat(40), PUBLIC_APP_URL: "https://meridian.example" };

  function ports(sql: Sql): ConnectorPorts {
    return {
      ledger: sqlHoldLedger(sql),
      files: async () => filesPort,
      limits: async () => {
        const account = await BudgetLedgerService.getAccount(sql, WS, BRAND);
        const { monthlyHeldUsd } = await import("../providers/generation-ledger.ts");
        return { monthlyBudgetUsd: 50, monthlyHeldUsd: await monthlyHeldUsd(sql, WS), decisionCapUsd: 0.05, brands: [{ brandId: BRAND, name: "Calm Mug Co", budgetUsd: account ? Number(account.maxSpendMicros) / 1e6 : null, committedUsd: account ? Number(account.spentMicros + account.reservedMicros) / 1e6 : 0 }, { brandId: BARE_BRAND, name: "Bare", budgetUsd: null, committedUsd: 0 }] };
      },
      readiness: async () => ({
        voice: { ready: true, detail: "ready" },
        image: { ready: true, detail: "ready", model: "google/image-model" },
        decisions: { ready: true, engine: "OpenRouter Decisions", detail: "" },
        storage: { ready: true, detail: "ready" },
      }),
      brands: async () => [{ id: BRAND, name: "Calm Mug Co" }, { id: BARE_BRAND, name: "Bare" }],
      brand: async (id) => (id === BRAND ? { id, name: "Calm Mug Co", facts: { Tone: "plain and warm", "Words to avoid": "" } } : null),
      speechModels: async () => ({ ok: true, models: [{ id: "openai/gpt-audio-mini", name: null, usdPerCharacter: 0.0000006, voices: ["alloy", "unknown"], listedOn: null, summary: null }] }),
      styles: async () => [
        { cookbookId: "ck_voice_listicle", label: "Voice-led list", summary: "A spoken list over kinetic type.", modes: ["agent", "engine"], instructions: [{ role: "script", text: "One item to a beat." }] },
        { cookbookId: "ck_engine_only", label: "Engine only", summary: "Not for chats.", modes: ["engine"], instructions: [] },
      ],
      async speak(input) {
        if (input.voice === "unknown") throw new NotSentError("OpenRouter refused the voiceover (HTTP 400).");
        spoken.push(input.text);
        return { bytes: MP3, mediaType: "audio/mpeg", model: input.model, costUsd: 0.012 };
      },
      image: async () => ({ bytes: PNG, mediaType: "image/png", model: "google/image-model", width: 1080, height: 1920, costUsd: null }),
      decide: async (input) => ({ engine: "OpenRouter Decisions", model: "openai/gpt-6-luna-decisions", status: "answered", answer: input.options[1] ?? "true", probability: 0.71, confidence: null, distribution: null, reason: null, costUsd: 0.004, recorded: true }),
    };
  }

  function deps(): McpHttpDeps {
    return { getSql: async () => db.sql, ports: (sql) => ports(sql), env, now: () => new Date("2026-11-09T10:00:00Z") };
  }

  async function rpc(secret: string | null, method: string, params?: unknown, opts: { bearer?: boolean } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret && opts.bearer) headers.authorization = `Bearer ${secret}`;
    const request = new Request(`https://meridian.example/api/mcp/${opts.bearer ? "" : (secret ?? "x")}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const response = await handleMcpRequest(request, { pathSecret: opts.bearer ? null : secret }, deps());
    return { status: response.status, body: response.status === 202 ? null : ((await response.json()) as Record<string, any>) };
  }
  const call = (secret: string, name: string, args: Record<string, unknown> = {}) => rpc(secret, "tools/call", { name, arguments: args });

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await db.sql`insert into brands (id, organization_id, name, created_by) values (${BARE_BRAND}, ${WS}, 'Bare', 'test')`;
    await seedUser(db.sql, ADMIN, "admin");
    await seedUser(db.sql, VIEWER, "viewer");
    await BudgetLedgerService.setBrandBudget(db.sql, { organizationId: WS, brandId: BRAND, capUsd: 5 });
  });
  after(async () => db.close());

  it("lets only an admin make and list links, shows the secret once, and stores only its hash", async () => {
    await assert.rejects(createConnector(db.sql, { organizationId: WS, userId: VIEWER, name: "Mine" }), /permission/i);
    const made = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "  Victor's   Claude " });
    assert.equal(made.connector.name, "Victor's Claude");
    assert.equal(made.connector.hint, made.secret.slice(-4));
    const listed = await listConnectors(db.sql, { organizationId: WS, userId: ADMIN });
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(made.secret), "the secret is never listed");
    const stored = await db.sql<{ token_hash: string }>`select token_hash from mcp_connectors`;
    assert.ok(stored.every((row) => row.token_hash !== made.secret));
  });

  it("answers initialize and lists the tools over HTTP, by link or by Bearer header", async () => {
    const { secret } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "HTTP" });
    const init = await rpc(secret, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
    assert.equal(init.status, 200);
    assert.equal(init.body!.result.serverInfo.name, "meridian");
    const listed = await rpc(secret, "tools/list", undefined, { bearer: true });
    assert.equal(listed.status, 200);
    assert.ok((listed.body!.result.tools as Array<{ name: string }>).some((tool) => tool.name === "meridian_voiceover"));
    const note = await handleMcpRequest(new Request(`https://meridian.example/api/mcp/${secret}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), { pathSecret: secret }, deps());
    assert.equal(note.status, 202);
    const get = await handleMcpRequest(new Request(`https://meridian.example/api/mcp/${secret}`), { pathSecret: secret }, deps());
    assert.equal(get.status, 405);
  });

  it("refuses an unknown link, a revoked link and a link whose maker left, all the same way", async () => {
    assert.equal((await rpc("mrd_" + "a".repeat(43), "tools/list")).status, 401);
    const revoked = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Old" });
    assert.deepEqual(await revokeConnector(db.sql, { organizationId: WS, userId: ADMIN, connectorId: revoked.connector.id }), { revoked: true });
    assert.equal((await rpc(revoked.secret, "tools/list")).status, 401);
    await seedUser(db.sql, "user_mcp_leaver", "admin");
    const orphan = await createConnector(db.sql, { organizationId: WS, userId: "user_mcp_leaver", name: "Leaver" });
    await db.sql`delete from memberships where user_id = 'user_mcp_leaver'`;
    assert.equal(await resolveConnector(db.sql, orphan.secret), null);
    assert.equal((await rpc(orphan.secret, "tools/list")).status, 401);
  });

  it("shows the limits, and makes a voiceover held and settled on the brand budget, stored and linked", async () => {
    const { secret } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Voice" });
    const status = await call(secret, "meridian_status");
    assert.match(status.body!.result.content[0].text, /Brand Calm Mug Co \(brand_mcp\): budget \$5\.00, committed \$0\.00, left \$5\.00/);
    assert.match(status.body!.result.content[0].text, /Brand Bare \(brand_mcp_bare\): budget not set, so paid calls for it are refused/);

    const voice = await call(secret, "meridian_voiceover", { brandId: BRAND, text: "Hot coffee, two hours later.", model: "openai/gpt-audio-mini", voice: "alloy", label: "hook" });
    const result = voice.body!.result;
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /Cost: \$0\.01, as the provider reported it/);
    assert.match(result.structuredContent.file.url, /^https:\/\/meridian\.example\/api\/mcp-files\/[0-9a-f-]+\?expires=\d+&sig=[0-9a-f]{64}$/);
    assert.deepEqual(spoken, ["Hot coffee, two hours later."]);
    const account = await BudgetLedgerService.getAccount(db.sql, WS, BRAND);
    assert.equal(account!.spentMicros, 12_000n, "the reported cost is booked");
    assert.equal(account!.reservedMicros, 0n, "and the hold is gone");
  });

  it("books an image with no reported cost at its ceiling, and shows a small image inline", async () => {
    const { secret } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Image" });
    const before = (await BudgetLedgerService.getAccount(db.sql, WS, BRAND))!.spentMicros;
    const image = await call(secret, "meridian_image", { brandId: BRAND, prompt: "A ceramic mug on a desk at dawn" });
    const result = image.body!.result;
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /reported no cost, so \$1\.00 \(the hold's ceiling\) is booked/);
    assert.equal(result.content[1].type, "image");
    const after = (await BudgetLedgerService.getAccount(db.sql, WS, BRAND))!.spentMicros;
    assert.equal(after - before, 1_000_000n);
  });

  it("sends nothing for a brand with no budget, releases the hold of a refused voice, and keeps a viewer from spending", async () => {
    const { secret } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Refusals" });
    const bare = await call(secret, "meridian_image", { brandId: BARE_BRAND, prompt: "A mug" });
    assert.equal(bare.body!.result.isError, true);
    assert.match(bare.body!.result.content[0].text, /No budget is set for this brand.*Nothing was sent/);
    const refused = await call(secret, "meridian_voiceover", { brandId: BRAND, text: "Hello", model: "openai/gpt-audio-mini", voice: "unknown" });
    assert.match(refused.body!.result.content[0].text, /Nothing was sent, and the hold was released/);
    assert.equal((await BudgetLedgerService.getAccount(db.sql, WS, BRAND))!.reservedMicros, 0n);
    const wrongModel = await call(secret, "meridian_voiceover", { brandId: BRAND, text: "Hello", model: "made/up", voice: "alloy" });
    assert.match(wrongModel.body!.result.content[0].text, /not a speech model in the live catalogue/);

    const viewer = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Viewer link" });
    await db.sql`update mcp_connectors set created_by = ${VIEWER} where id = ${viewer.connector.id}`;
    const denied = await call(viewer.secret, "meridian_image", { brandId: BRAND, prompt: "A mug" });
    assert.match(denied.body!.result.content[0].text, /needs the member role/);
    const allowed = await call(viewer.secret, "meridian_brand", { brandId: BRAND });
    assert.match(allowed.body!.result.content[0].text, /Tone: plain and warm/);
  });

  it("runs the Q&A and a Studio video over HTTP: the person's checkpoints, the asset gate, the video's budget and delivery", async () => {
    const { secret } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Workflow" });
    const start = await call(secret, "meridian_start");
    const intake = start.body!.result.content[0].text as string;
    assert.match(intake, /^Quick Q&A before making the video\. Ask these questions in ONE message/);
    assert.match(intake, /1\. Which brand is this video for\?\n {3}A\. Calm Mug Co \(\$\d+\.\d\d left\)\n {3}B\. Bare \(no budget set: paid steps are refused\)/);
    assert.match(intake, /Voice-led list: A spoken list over kinetic type\./);
    assert.doesNotMatch(intake, /Engine only/, "a style a chat cannot make is not offered");

    const created = await call(secret, "meridian_project_create", { brandId: BRAND, goal: "Sell a product", idea: "Our mug keeps coffee hot for two hours", seconds: 30, style: "ck_voice_listicle", voiceover: true, mode: "studio", render: "chat", budgetUsd: 1.5 });
    const createdText = created.body!.result.content[0].text as string;
    assert.equal(created.body!.result.isError, false, createdText);
    assert.match(createdText, /Studio mode/);
    assert.match(createdText, /- Concept: you choose/);
    assert.match(createdText, /- Render: the chat decides/);
    assert.match(createdText, /One item to a beat/, "the chosen style's rules travel with the project");
    const projectId = created.body!.result.structuredContent.project.id as string;

    const forced = await call(secret, "meridian_checkpoint", { projectId, phase: "concept", action: "resolve", decidedBy: "chat", content: "x" });
    assert.match(forced.body!.result.content[0].text, /person's choice in Studio mode/);
    const early = await call(secret, "meridian_image", { brandId: BRAND, prompt: "A mug", projectId });
    assert.match(early.body!.result.content[0].text, /Settle the asset plan first.*Nothing was spent/);

    const options = [{ label: "A", summary: "First" }, { label: "B", summary: "Second" }];
    for (const phase of ["concept", "script", "storyboard", "assets"]) {
      const proposed = await call(secret, "meridian_checkpoint", { projectId, phase, action: "propose", options });
      assert.match(proposed.body!.result.content[0].text, /options recorded/);
      const resolved = await call(secret, "meridian_checkpoint", { projectId, phase, action: "resolve", decidedBy: "person", choice: "A", content: `${phase}: settled` });
      assert.equal(resolved.body!.result.isError, false, resolved.body!.result.content[0].text);
    }
    const before = (await BudgetLedgerService.getAccount(db.sql, WS, BRAND))!;
    const image = await call(secret, "meridian_image", { brandId: BRAND, prompt: "A mug at dawn", projectId });
    assert.equal(image.body!.result.isError, false, image.body!.result.content[0].text);
    const second = await call(secret, "meridian_image", { brandId: BRAND, prompt: "A mug at noon", projectId });
    assert.match(second.body!.result.content[0].text, /\$0\.50 is left, less than this call's hold of \$1\.00.*Nothing was spent/);
    const after = (await BudgetLedgerService.getAccount(db.sql, WS, BRAND))!;
    assert.equal(after.spentMicros - before.spentMicros, 1_000_000n, "only the first image is booked on the brand");
    assert.equal(after.reservedMicros, 0n);
    const raised = await call(secret, "meridian_project_update", { projectId, budgetUsd: 3 });
    assert.match(raised.body!.result.content[0].text, /Spent on this video: \$1\.00 of \$3\.00/);
    const lowered = await call(secret, "meridian_project_update", { projectId, budgetUsd: 0.5 });
    assert.match(lowered.body!.result.content[0].text, /already spent on this video/);

    const status = await call(secret, "meridian_project", { projectId });
    assert.match(status.body!.result.content[0].text, /Assets?|Asset plan: settled by the person \(A\)/);
    assert.match(status.body!.result.content[0].text, /Files: 1\./);
    assert.match(status.body!.result.content[0].text, /Next: Build/);

    await call(secret, "meridian_checkpoint", { projectId, phase: "build", action: "propose", options });
    await call(secret, "meridian_checkpoint", { projectId, phase: "build", action: "resolve", decidedBy: "person", choice: "B" });
    const render = await call(secret, "meridian_checkpoint", { projectId, phase: "render", action: "resolve", decidedBy: "chat", content: "video.mp4 in the chat" });
    assert.match(render.body!.result.content[0].text, /Next: Deliver/);
    await call(secret, "meridian_checkpoint", { projectId, phase: "deliver", action: "propose", options });
    const delivered = await call(secret, "meridian_checkpoint", { projectId, phase: "deliver", action: "resolve", decidedBy: "person", choice: "A" });
    assert.match(delivered.body!.result.content[0].text, /The video is delivered\. Spent on this video: \$1\.00 of \$3\.00/);
    const again = await call(secret, "meridian_checkpoint", { projectId, phase: "deliver", action: "reopen" });
    assert.match(again.body!.result.content[0].text, /This video is delivered/);
    const listed = await call(secret, "meridian_project");
    assert.match(listed.body!.result.content[0].text, new RegExp(`${projectId}: "Our mug keeps coffee hot for two hours", studio, delivered`));

    const prompts = await rpc(secret, "prompts/list");
    assert.deepEqual((prompts.body!.result.prompts as Array<{ name: string }>).map((prompt) => prompt.name), ["make_video", "studio_video", "resume_video"]);
  });

  it("makes a video with no brand: the Q&A, a project, a voiceover held on the monthly budget and kept in Meridian's database, served by its link", async () => {
    const { secret } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "No brand" });
    filesPort = await meridianMcpFileStore(db.sql, async () => ({ kind: "database", detail: "Files are kept in Meridian's own database." }));
    try {
      const start = await call(secret, "meridian_start");
      assert.match(start.body!.result.content[0].text, /No brand: the workspace's own video/);
      const created = await call(secret, "meridian_project_create", {
        goal: "Explain how something works", idea: "Microwaves shake water; the middle heats last.", seconds: 30, style: "8-bit pixel explainer",
        voiceover: true, mode: "orchestrator", render: "chat",
      });
      const project = created.body!.result.structuredContent.project;
      assert.equal(project.brandId, null);
      assert.match(created.body!.result.content[0].text, /with no brand \(the workspace's own, paid from the monthly budget\)/);
      for (const phase of ["concept", "script", "storyboard", "assets"]) {
        const step = await call(secret, "meridian_checkpoint", { projectId: project.id, phase, action: "resolve", decidedBy: "chat", content: `${phase} settled` });
        assert.notEqual(step.body!.result.isError, true, phase);
      }

      // No monthly budget yet: nothing is sent, and nothing is held.
      await db.sql`update organizations set monthly_video_budget_usd = null where id = ${WS}`;
      const refused = await call(secret, "meridian_voiceover", { projectId: project.id, text: "Microwaves shake water.", model: "openai/gpt-audio-mini", voice: "alloy" });
      assert.equal(refused.body!.result.isError, true);
      assert.match(refused.body!.result.content[0].text, /No monthly budget is set/);
      assert.equal((await db.sql`select id from model_runs where organization_id = ${WS} and operation = 'mcp.voiceover'`).length, 0);

      await db.sql`update organizations set monthly_video_budget_usd = 3 where id = ${WS}`;
      const made = await call(secret, "meridian_voiceover", { projectId: project.id, text: "Microwaves shake water.", model: "openai/gpt-audio-mini", voice: "alloy" });
      assert.notEqual(made.body!.result.isError, true, made.body!.result.content[0].text);
      assert.match(made.body!.result.content[0].text, /paid from the workspace's monthly budget/);
      const holds = await db.sql<{ status: string; brand_id: string | null; cost_usd: string | number; estimate_usd: string | number }>`
        select status, brand_id, cost_usd, estimate_usd from model_runs where organization_id = ${WS} and operation = 'mcp.voiceover'
      `;
      assert.equal(holds.length, 1);
      assert.deepEqual({ ...holds[0]!, cost_usd: Number(holds[0]!.cost_usd), estimate_usd: Number(holds[0]!.estimate_usd) }, { status: "completed", brand_id: null, cost_usd: 0.012, estimate_usd: 1 });

      const file = made.body!.result.structuredContent.file;
      assert.equal(file.brandId, null);
      const stored = await db.sql<{ provider: string; brand_id: string | null }>`
        select o.provider, o.brand_id from storage_objects o join mcp_files f on f.storage_object_id = o.id where f.id = ${file.id}
      `;
      assert.deepEqual(stored, [{ provider: "database", brand_id: null }]);
      const served = await serveMcpFile(new Request(file.url), file.id, {
        getSql: async () => db.sql,
        env,
        store: async (sql) => meridianMcpFileStore(sql, async () => ({ kind: "database", detail: "" })),
        nowSeconds: Date.parse("2026-11-09T10:00:00Z") / 1000 + 60,
      });
      assert.equal(served.status, 200);
      assert.deepEqual(new Uint8Array(await served.arrayBuffer()), MP3);

      const status = await call(secret, "meridian_project", { projectId: project.id });
      assert.match(status.body!.result.content[0].text, /no cap beyond the monthly budget/);
    } finally {
      filesPort = files;
    }
  });

  it("asks the decision engine, lists the files with fresh links, gives the render commands, and audits paid calls", async () => {
    const { secret, connector } = await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "Decide" });
    const decision = await call(secret, "meridian_decide", { brandId: BRAND, kind: "choose", question: "Which hook stops the scroll?", options: ["Coffee goes cold.", "Still hot at hour two."] });
    assert.match(decision.body!.result.content[0].text, /Answer \(OpenRouter Decisions, openai\/gpt-6-luna-decisions\): "Still hot at hour two\." Probability 0\.71/);
    const listed = await call(secret, "meridian_files", { brandId: BRAND });
    const listedFiles = listed.body!.result.structuredContent.files as Array<{ id: string; kind: string; url: string }>;
    assert.ok(listedFiles.length >= 2 && listedFiles.every((file) => file.url.includes("/api/mcp-files/")));
    const render = await call(secret, "meridian_render", { renderer: "claude", fileIds: [listedFiles[0]!.id, "missing-file"] });
    assert.match(render.body!.result.content[0].text, /npx --yes hyperframes@0\.8\.154 render -o video\.mp4/);
    assert.match(render.body!.result.content[0].text, /Not found in this workspace: missing-file/);
    const cloud = await call(secret, "meridian_render", { renderer: "hyperframes" });
    assert.equal(cloud.body!.result.isError, true);
    const audits = await db.sql<{ action: string }>`select action from audit_log where object_id = ${connector.id} order by created_at`;
    assert.deepEqual(audits.map((row) => row.action), ["mcp_connector.created", "mcp.meridian_decide"]);
  });
});
