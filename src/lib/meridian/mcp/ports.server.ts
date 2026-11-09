// Production wiring for the connector's tools. Server only: it reaches the database, the gateway and the decision engines. Each port uses
// the path Meridian already has for the same work, so a chat spends and records exactly as the app does:
// - limits: the Billing page's own read (billing/store.ts);
// - images: the Studio image provider (production/openrouter-image.ts), with the Studio image model chosen in Settings, Models;
// - voice: OpenRouter's audio output, as the video engine's speech adapter sends it (engine/assets/providers/openrouterSpeech.ts), read
//   with its stream parser and checked with its normaliser, and the bill read from OpenRouter's generation stats;
// - decisions: the workspace's active engine (decisions/dispatcher.ts), which keeps its own caps and lineage;
// - storage: the Content Factory's Drive store.
// Every provider call goes through the engine's gateway, which adds the workspace's key; no key is read here.

import type { Sql } from "../learning/store.ts";
import type { DecisionRequest } from "../decisions/types.ts";
import type { JevQuestionSpec } from "../jev/types.ts";
import type { ResolvedConnector } from "./connectors.ts";
import { driveMcpFileStore } from "./files.ts";
import { NotSentError, sqlHoldLedger } from "./paid.ts";
import type { BrandContext, ConnectorPorts, DecisionAnswer, DecisionKind, SpeechModel } from "./tools.ts";

const SPEECH_PROMPT_VERSION = "mcp-voiceover-v1";
const IMAGE_PROMPT_VERSION = "mcp-image-v1";
const DECISION_QUESTION_VERSION = "mcp-decide-v1";

let gatewayCache: import("../../../engine/gateway/gateway.ts").Gateway | null = null;
async function gateway() {
  if (gatewayCache) return gatewayCache;
  const [{ createGateway }, { fetchHttpTransport }, { meridianCredentialSource }] = await Promise.all([
    import("../../../engine/gateway/gateway.ts"),
    import("../../../engine/gateway/transport.ts"),
    import("../../../engine/gateway/meridian.ts"),
  ]);
  gatewayCache = createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });
  return gatewayCache;
}

function bodyOf(response: { body?: unknown }): string {
  const body = response.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

/** The decision request for one connector question, in the engines' own question format. */
export function decisionRequestOf(input: { organizationId: string; brandId: string; kind: DecisionKind; question: string; options: string[]; context: string }): DecisionRequest {
  const id = `mcp.${input.kind}`;
  const optionKeys = input.options.map((_, index) => `option_${index + 1}`);
  const spec: JevQuestionSpec =
    input.kind === "choose"
      ? { id, version: DECISION_QUESTION_VERSION, type: "choice", instructions: input.question, criteria: Object.fromEntries(optionKeys.map((key, index) => [key, input.options[index]!])), options: optionKeys, evidenceRequirements: [] }
      : input.kind === "yes_no"
        ? { id, version: DECISION_QUESTION_VERSION, type: "noul", instructions: input.question, criteria: { true: "Yes.", false: "No." }, evidenceRequirements: [] }
        : {
            id,
            version: DECISION_QUESTION_VERSION,
            type: "score",
            instructions: `${input.question} Score from 1 (worst) to 5 (best).`,
            criteria: ["1: Poor.", "2: Weak.", "3: Acceptable.", "4: Strong.", "5: Excellent."],
            evidenceRequirements: [],
          };
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    state: { description: input.context || "No further context was given.", source: "mcp-connector" },
    questions: { [id]: spec },
  };
}

export function productionPorts(sql: Sql, connector: ResolvedConnector): ConnectorPorts {
  const organizationId = connector.organizationId;
  let filesCache: Awaited<ReturnType<typeof driveMcpFileStore>> | null = null;

  return {
    ledger: sqlHoldLedger(sql),

    async files() {
      filesCache ??= await driveMcpFileStore(sql);
      return filesCache;
    },

    async limits() {
      const { readBillingPage } = await import("../billing/store.ts");
      const page = await readBillingPage(sql, { userId: connector.userId, organizationId });
      return {
        monthlyBudgetUsd: page.workspace.monthlyBudgetUsd,
        decisionCapUsd: page.workspace.decisionCapUsd,
        brands: page.brands.map((brand) => ({ brandId: brand.brandId, name: brand.name, budgetUsd: brand.brandBudgetUsd, committedUsd: brand.committedUsd })),
      };
    },

    async readiness() {
      const [{ generationCredentialStatus }, { OpenRouterStudioImageProvider }, { storedMediaModel }, { createDecisionEngines, DECISION_ENGINE_LABELS }, { resolveActiveEngine }, files] = await Promise.all([
        import("../providers/chat.server.ts"),
        import("../production/openrouter-image.ts"),
        import("../settings/media-models.ts"),
        import("../decisions/dispatcher.ts"),
        import("../decisions/selection.ts"),
        this.files(),
      ]);
      const key = await generationCredentialStatus(organizationId);
      const imageHealth = await new OpenRouterStudioImageProvider().healthFor(organizationId);
      const imageModel = await storedMediaModel(sql, organizationId, "studio_image").catch(() => null);
      const selection = await resolveActiveEngine(sql, organizationId);
      const engine = createDecisionEngines()[selection.engineId];
      const engineHealth = engine ? await (engine.healthFor ? engine.healthFor(organizationId) : engine.health()) : { status: "NOT_CONFIGURED" as const, message: "No engine is registered." };
      const storage = await files.ready(organizationId);
      return {
        voice: key.status === "ready" ? { ready: true, detail: "Voiceovers use the workspace's OpenRouter key; pick a model from meridian_voice_models." } : { ready: false, detail: key.reason },
        image: { ready: imageHealth.state === "CONFIGURED", detail: imageHealth.detail ?? "", model: imageModel },
        decisions: { ready: engineHealth.status === "READY", engine: DECISION_ENGINE_LABELS[selection.engineId] ?? selection.engineId, detail: "message" in engineHealth && engineHealth.message ? engineHealth.message : "" },
        storage: storage.status === "ready" ? { ready: true, detail: "Files are kept in the brand's Google Drive folder." } : { ready: false, detail: storage.reason },
      };
    },

    async brands() {
      return sql<{ id: string; name: string }>`select id, name from brands where organization_id = ${organizationId} and deleted_at is null order by name`;
    },

    async brand(brandId) {
      const { BRAIN_FIELDS } = await import("../brain.ts");
      const rows = await sql<Record<string, unknown>>`
        select b.id, b.name, b.description, b.category, b.industry, b.website, b.country_market, b.sells, br.*
        from brands b left join brand_brains br on br.brand_id = b.id
        where b.id = ${brandId} and b.organization_id = ${organizationId} and b.deleted_at is null
        limit 1
      `;
      const row = rows[0];
      if (!row) return null;
      const text = (value: unknown) => (typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value));
      const facts: Record<string, string> = {
        Description: text(row.description),
        Sells: text(row.sells),
        Category: text(row.category),
        Industry: text(row.industry),
        Market: text(row.country_market),
        Website: text(row.website),
      };
      for (const field of BRAIN_FIELDS) facts[field.label] = text(row[field.column]);
      return { id: String(row.id), name: text(row.name), facts } satisfies BrandContext;
    },

    async styles() {
      const { builtinCookbooks } = await import("../cookbooks/builtin/index.ts");
      return builtinCookbooks().map((cookbook) => ({
        cookbookId: cookbook.cookbookId,
        label: cookbook.label,
        summary: cookbook.summary,
        modes: cookbook.modes,
        instructions: cookbook.instructions.map((rule) => ({ role: rule.role, text: rule.text })),
      }));
    },

    async speechModels() {
      const { readModelCatalog } = await import("../../../engine/gateway/catalog.ts");
      const read = await readModelCatalog(await gateway(), { organizationId });
      if (read.status !== "read") return { ok: false, reason: read.reason };
      const failed = read.catalog.failed.find((item) => item.source === "speech");
      const models: SpeechModel[] = read.catalog.entries
        .filter((entry) => entry.modelClasses.includes("tts"))
        .map((entry) => ({ id: entry.id, priceUnit: entry.price.unit, usd: entry.price.usd }))
        .sort((a, b) => a.usd - b.usd || a.id.localeCompare(b.id));
      if (models.length === 0 && failed) return { ok: false, reason: failed.reason };
      return { ok: true, models };
    },

    async speak(input) {
      const [{ speechFromStream, SPEECH_TIMEOUT_MS }, { normaliseSpeech }, { openRouterGenerationBill }] = await Promise.all([
        import("../../../engine/assets/providers/openrouterSpeech.ts"),
        import("../../../engine/assets/normalise.ts"),
        import("../../../engine/gateway/generation.ts"),
      ]);
      const gw = await gateway();
      const result = await gw.call({
        provider: "openrouter",
        organizationId,
        method: "POST",
        path: "/chat/completions",
        headers: { "content-type": "application/json", accept: "text/event-stream", "x-meridian-prompt-version": SPEECH_PROMPT_VERSION },
        body: JSON.stringify({
          model: input.model,
          modalities: ["text", "audio"],
          audio: { voice: input.voice, format: "mp3" },
          messages: [{ role: "user", content: input.text }],
          stream: true,
          ...(input.speed === 1 ? {} : { speed: input.speed }),
        }),
        timeoutMs: SPEECH_TIMEOUT_MS,
      });
      if (result.status === "not_connected") throw new NotSentError(`OpenRouter is not connected: ${result.reason}`);
      const response = result.response;
      // A 4xx is the provider refusing the request (an unknown voice, a model without audio); OpenRouter does not bill it.
      if (response.status >= 400 && response.status < 500) throw new NotSentError(`OpenRouter refused the voiceover (HTTP ${response.status}): ${bodyOf(response).slice(0, 300)}`);
      if (response.status < 200 || response.status >= 300) throw new Error(`OpenRouter answered HTTP ${response.status}.`);
      const stream = speechFromStream(bodyOf(response));
      if (!stream.ok) throw new Error(`The voiceover stream was not usable: ${stream.reason}`);
      const checked = normaliseSpeech(stream.bytes, "audio/mpeg");
      if (!checked.ok) throw new Error(`The voiceover audio was not usable: ${checked.reason}`);
      const bill = stream.generationId ? await openRouterGenerationBill(gw, { organizationId, generationId: stream.generationId }) : null;
      return { bytes: checked.value.bytes, mediaType: checked.value.mediaType, model: input.model, costUsd: bill?.status === "billed" ? bill.usd : null };
    },

    async image(input) {
      const { OpenRouterStudioImageProvider, OPENROUTER_IMAGE_SEAT_MODEL } = await import("../production/openrouter-image.ts");
      const outcome = await new OpenRouterStudioImageProvider().generate({
        prompt: input.prompt,
        seed: input.seed,
        promptVersion: IMAGE_PROMPT_VERSION,
        model: OPENROUTER_IMAGE_SEAT_MODEL,
        aspectRatio: input.aspectRatio,
        organizationId,
      });
      if (outcome.status === "NOT_CONNECTED") throw new NotSentError(outcome.error);
      if (outcome.status === "failed") throw new Error(outcome.error);
      return {
        bytes: outcome.bytes,
        mediaType: outcome.mediaType,
        model: outcome.model,
        width: outcome.width,
        height: outcome.height,
        costUsd: typeof outcome.costCents === "number" ? outcome.costCents / 100 : null,
      };
    },

    async decide(input) {
      const [{ decideWithActiveEngine, DECISION_ENGINE_LABELS }] = await Promise.all([import("../decisions/dispatcher.ts")]);
      const request = decisionRequestOf({ organizationId, ...input });
      const questionId = Object.keys(request.questions)[0]!;
      const result = await decideWithActiveEngine({ sql, request });
      const answer = result.answers[questionId];
      const optionText = (value: unknown) => {
        const match = typeof value === "string" ? /^option_(\d+)$/.exec(value) : null;
        return match ? (input.options[Number(match[1]) - 1] ?? String(value)) : value === undefined || value === null ? null : String(value);
      };
      const base = {
        engine: DECISION_ENGINE_LABELS[result.engineId] ?? result.engineId,
        model: result.returnedModel,
        costUsd: typeof result.usage?.reportedCostUsd === "number" ? result.usage.reportedCostUsd : null,
      };
      if (!answer) return { ...base, status: "failed", answer: null, probability: null, confidence: null, distribution: null, reason: result.failure?.message ?? "The engine returned no answer for the question." } satisfies DecisionAnswer;
      if (answer.status !== "answered") return { ...base, status: answer.status, answer: null, probability: null, confidence: null, distribution: null, reason: answer.abstainReason } satisfies DecisionAnswer;
      const distribution = answer.distribution ?? answer.probabilities ?? null;
      return {
        ...base,
        status: "answered",
        answer: input.kind === "choose" ? optionText(answer.choice ?? answer.answer) : String(answer.choice ?? answer.score ?? answer.answer),
        probability: typeof answer.probability === "number" ? answer.probability : typeof answer.noulProbability === "number" ? answer.noulProbability : null,
        confidence: typeof answer.confidence === "number" ? answer.confidence : null,
        distribution: distribution ? Object.fromEntries(Object.entries(distribution).map(([key, value]) => [optionText(key) ?? key, value])) : null,
        reason: null,
      } satisfies DecisionAnswer;
    },
  };
}
