// The connector's tools. The chat is the orchestrator: it writes the script, the plan and the coded video itself, at no cost to the
// workspace. These tools give it the brand's context and limits for free, and do the few things a chat cannot: a voiceover, an image and a
// decision (paid, under the workspace's limits), and storage. Everything a provider returns is data: it is checked, stored, and never
// passed on as an instruction. A figure that is not known is said to be unknown, never shown as 0.

import { z } from "zod";
import type { Sql } from "../learning/store.ts";
import type { ResolvedConnector } from "./connectors.ts";
import { fileLink, listFiles, storeFile, type McpFile, type McpFileStore } from "./files.ts";
import { budgetName, usd, withHold, type HoldLedger } from "./paid.ts";
import { defineTool, type McpTool, type ToolContent, type ToolResult } from "./protocol.ts";
import { readProject, recordProjectSpend } from "./projects.ts";
import { speechModelLine, voiceProblem, type SpeechModel } from "./speech.ts";
import { paidCallProblem, type PaidKind, type ProjectState } from "./workflow.ts";

/**
 * The budgets, from the Billing page. Null amounts are not set. A video made without a brand is paid from the monthly budget, which counts
 * the month's held spend across text and video (monthlyHeldUsd).
 */
export type LimitsView = {
  monthlyBudgetUsd: number | null;
  monthlyHeldUsd: number;
  decisionCapUsd: number | null;
  brands: Array<{ brandId: string; name: string; budgetUsd: number | null; committedUsd: number }>;
};

export type Readiness = { ready: boolean; detail: string };

export type BrandContext = { id: string; name: string; facts: Record<string, string> };

export type { SpeechModel } from "./speech.ts";

export type SpeechAnswer = { bytes: Uint8Array; mediaType: string; model: string; costUsd: number | null };
export type ImageAnswer = { bytes: Uint8Array; mediaType: string; model: string; width: number; height: number; costUsd: number | null };

export type DecisionKind = "choose" | "yes_no" | "score";
export type DecisionAnswer = {
  engine: string;
  model: string;
  status: string;
  answer: string | null;
  probability: number | null;
  confidence: number | null;
  distribution: Record<string, number> | null;
  reason: string | null;
  costUsd: number | null;
  /** Whether the decision was written to the workspace's decision log. */
  recorded: boolean;
};

/** What the tools reach. Production: ports.server.ts. Tests: in-memory fakes, so no test calls a provider. */
export type ConnectorPorts = {
  ledger: HoldLedger;
  files(): Promise<McpFileStore>;
  limits(): Promise<LimitsView>;
  readiness(): Promise<{ voice: Readiness; image: Readiness & { model: string | null }; decisions: Readiness & { engine: string }; storage: Readiness }>;
  brands(): Promise<Array<{ id: string; name: string }>>;
  brand(brandId: string): Promise<BrandContext | null>;
  speechModels(): Promise<{ ok: true; models: SpeechModel[] } | { ok: false; reason: string }>;
  /** Meridian's cookbooks, for the intake's style question and the chosen style's rules. */
  styles(): Promise<Array<{ cookbookId: string; label: string; summary: string; modes: readonly string[]; instructions: Array<{ role: string; text: string }> }>>;
  /** Throws NotSentError when it refuses before a request is sent. */
  speak(input: { model: string; voice: string; text: string; speed: number; instructions: string | null }): Promise<SpeechAnswer>;
  /** Throws NotSentError when it refuses before a request is sent. */
  image(input: { prompt: string; aspectRatio: "9:16" | "1:1" | "16:9"; seed: string }): Promise<ImageAnswer>;
  decide(input: { brandId: string | null; kind: DecisionKind; question: string; options: string[]; context: string }): Promise<DecisionAnswer>;
};

export type ConnectorContext = {
  sql: Sql;
  connector: ResolvedConnector;
  origin: string;
  now: () => Date;
  linkSecret: string | null;
  ports: ConnectorPorts;
};

/** The hold for one image, in USD: the same guard Studio and Factory images reserve, because no per-image price is declared. */
export const IMAGE_CEILING_USD = 1;
/**
 * The hold for one voiceover, in USD. The catalogue prices speech per token, and how many audio tokens a text becomes is not stated, so no
 * estimate is made from it: like an image, a voiceover holds a fixed guard and settles at the bill OpenRouter reports.
 */
export const VOICE_CEILING_USD = 1;
/** Images up to this size are also sent inline, so the chat can look at them; larger ones are linked only. */
const INLINE_IMAGE_MAX_BYTES = 750_000;
export const VOICEOVER_MAX_CHARS = 4000;

export const brandIdSchema = z.string().min(1).max(80).describe("The brand id, from meridian_status.");
/** A brand is optional for a video: without one, the video is the workspace's own and is paid from the monthly budget. */
export const optionalBrandIdSchema = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe("The brand id, from meridian_status. Leave it out for a video without a brand: it is the workspace's own, paid from the monthly budget. With a projectId, the project's brand is used.");

/** What the monthly budget has left for a video without a brand, or null when no monthly budget is set. */
export function workspaceLeftUsd(limits: Pick<LimitsView, "monthlyBudgetUsd" | "monthlyHeldUsd">): number | null {
  return limits.monthlyBudgetUsd === null ? null : Math.max(0, Math.round((limits.monthlyBudgetUsd - limits.monthlyHeldUsd) * 100) / 100);
}
export const projectIdSchema = z.string().min(1).max(80).describe("The video project id, from meridian_project_create.");

function linkOf(context: ConnectorContext, file: McpFile) {
  return fileLink({ origin: context.origin, fileId: file.id, nowSeconds: Math.floor(context.now().getTime() / 1000), secret: context.linkSecret });
}

export function fileView(context: ConnectorContext, file: McpFile) {
  const link = linkOf(context, file);
  return { id: file.id, brandId: file.brandId, kind: file.kind, mediaType: file.mediaType, bytes: file.bytes, costUsd: file.costUsd, url: link?.url ?? null, urlExpiresAt: link?.expiresAt ?? null, details: file.details, createdAt: file.createdAt };
}

const linkNote = (context: ConnectorContext) =>
  context.linkSecret ? "" : " No download link could be made: the server has no MEDIA_LINK_SECRET set. The file is stored and listed.";

export async function requireBrand(context: ConnectorContext, brandId: string): Promise<{ id: string; name: string } | null> {
  const brands = await context.ports.brands();
  return brands.find((brand) => brand.id === brandId) ?? null;
}

export const noBrand = (brandId: string): ToolResult => ({ text: `There is no brand '${brandId}' in this workspace. meridian_status lists its brands.`, isError: true });

function costLine(outcome: { costUsd: number | null; settledUsd: number; basis: "reported" | "ceiling" }, brandId: string | null): string {
  return outcome.basis === "reported"
    ? `Cost: ${usd(outcome.costUsd ?? 0)}, as the provider reported it, paid from ${budgetName(brandId)}.`
    : `The provider reported no cost, so ${usd(outcome.settledUsd)} (the hold's ceiling) is booked against ${budgetName(brandId)}.`;
}

export const VIDEO_GUIDE = `# Making a Meridian video from this chat

You are the orchestrator. Write the script, the plan and the coded video yourself; that costs the workspace nothing. Use Meridian only
for what a chat cannot do: meridian_voiceover, meridian_image, meridian_decide. Each is paid from the brand's budget, or from the
workspace's monthly budget for a video without a brand (meridian_status shows both), and reports its own cost.

## 1. Plan (as a project)
- Start with meridian_start: ask its quick Q&A in one message, then meridian_project_create. The project keeps the order (concept,
  script, storyboard, assets, build, render, deliver) and who decides each step in the mode the person chose; follow the next step every
  tool returns, and pass projectId to the paid tools.
- With a brand, read meridian_brand (the brand's voice, claims, words to avoid) and keep claims to what the brand states; without one,
  keep claims to what the person said. Ask meridian_decide when the
  workspace's decision engine should choose between hooks, check a claim, or score a draft, instead of judging your own work.

## 2. Assets (paid)
- meridian_voiceover: one call per take, the whole narration or one beat. Pick a model from meridian_voice_models and one of the
  voices it lists; ask the person when unsure. Word timings are not returned: time captions to the beats you wrote.
- meridian_image: one call per image, 9:16 for a full-screen shot. Uses the Studio image model chosen in Settings, Models.
- Every file is stored by Meridian (the brand's space, or the workspace's own for a video without a brand) and comes back with a
  download link that lasts an hour (meridian_files makes fresh ones).

## 3. The coded video (free, you write it)
A HyperFrames composition: one folder with index.html at its root.
- Root element: <div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="<seconds>">.
- Each clip is an element with class="clip" and data-start, data-duration (seconds) and data-track-index. Media: <img src="assets/x.png">,
  <video src="assets/x.mp4" muted>, <audio src="assets/voice.mp3" data-track-index="10">.
- Animate with one GSAP timeline registered as window.__timelines["main"] = gsap.timeline({ paused: true }); no wall-clock timers, no
  Math.random without a seed. Load GSAP from https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js.
- Keep text inside the safe area (top 150 px and bottom 300 px clear for the platform's own buttons). 30 fps, 1080 x 1920.

## 4. Render (you choose per video)
- renderer "claude" (free, slower): meridian_render returns the files with download links and the exact commands. In your code sandbox:
  download the assets into assets/, write index.html, then run \`npx --yes hyperframes@0.8.154 render -o video.mp4\`. The sandbox must be
  allowed to reach this Meridian site (claude.ai: Settings, Capabilities, code execution network access).
- renderer "hyperframes" (Meridian's cloud render): not available from this connector yet; meridian_render says so and what it needs.
`;

/**
 * Who a paid call is for: the project's brand when the chat names a project, else the brand it names, else no brand (the workspace's own
 * video, paid from the monthly budget). A named project must be this workspace's, active, past its asset plan (for media), within the
 * video's own budget, and of the brand the chat names, if it names one. Nothing is held or sent when it is not.
 */
export async function paidScope(
  context: ConnectorContext,
  input: { brandId?: string; projectId?: string },
  kind: PaidKind,
  holdUsd: number,
): Promise<{ ok: true; brandId: string | null; project: ProjectState | null } | { ok: false; result: ToolResult }> {
  if (input.projectId) {
    const project = await readProject(context.sql, context.connector.organizationId, input.projectId);
    if (!project) return { ok: false, result: { text: `There is no video project '${input.projectId}' in this workspace. meridian_project lists them.`, isError: true } };
    if (input.brandId !== undefined && input.brandId !== project.brandId) {
      const owner = project.brandId === null ? "the workspace, with no brand" : `brand ${project.brandId}`;
      return { ok: false, result: { text: `That video project belongs to ${owner}. Leave brandId out to use the project's. Nothing was spent.`, isError: true } };
    }
    const problem = paidCallProblem(project, kind, holdUsd);
    if (problem) return { ok: false, result: { text: `${problem} Nothing was spent.`, isError: true } };
    return { ok: true, brandId: project.brandId, project };
  }
  if (input.brandId !== undefined) {
    const brand = await requireBrand(context, input.brandId);
    if (!brand) return { ok: false, result: noBrand(input.brandId) };
    return { ok: true, brandId: brand.id, project: null };
  }
  return { ok: true, brandId: null, project: null };
}

/** The connector's context and media tools (status, brand, guide, voice, image, decide, files, render). */
export function mediaTools(): McpTool<ConnectorContext>[] {
  return [
    defineTool<ConnectorContext, z.ZodObject<Record<string, never>>>({
      name: "meridian_status",
      title: "Workspace status and limits",
      description: "The workspace this connector reaches, your role, every brand with its budget and what it has committed, the monthly budget (which pays for videos without a brand) and what it has left, and which paid services (voice, images, decisions, storage) are ready. Free.",
      input: z.object({}),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(context) {
        const [limits, readiness] = await Promise.all([context.ports.limits(), context.ports.readiness()]);
        const brands = limits.brands.map((brand) => ({
          ...brand,
          remainingUsd: brand.budgetUsd === null ? null : Math.max(0, Math.round((brand.budgetUsd - brand.committedUsd) * 100) / 100),
        }));
        const lines = [
          `Connector "${context.connector.name}", acting as ${context.connector.role}.`,
          `Monthly budget: ${limits.monthlyBudgetUsd === null ? "not set, so paid calls for videos without a brand are refused" : `${usd(limits.monthlyBudgetUsd)}, held this month ${usd(limits.monthlyHeldUsd)}, left ${usd(workspaceLeftUsd(limits) ?? 0)}`}. A video without a brand is paid from it. Decision cap per call: ${limits.decisionCapUsd === null ? "not set" : usd(limits.decisionCapUsd)}.`,
          ...brands.map((brand) => `Brand ${brand.name} (${brand.brandId}): budget ${brand.budgetUsd === null ? "not set, so paid calls for it are refused" : `${usd(brand.budgetUsd)}, committed ${usd(brand.committedUsd)}, left ${usd(brand.remainingUsd ?? 0)}`}.`),
          `Voice: ${readiness.voice.ready ? "ready" : "not ready"}. ${readiness.voice.detail}`,
          `Images: ${readiness.image.ready ? "ready" : "not ready"}. ${readiness.image.detail}`,
          `Decisions (${readiness.decisions.engine}): ${readiness.decisions.ready ? "ready" : "not ready"}. ${readiness.decisions.detail}`,
          `Storage: ${readiness.storage.ready ? "ready" : "not ready"}. ${readiness.storage.detail}`,
          "This chat's own work (scripts, plans, the coded video, rendering in your sandbox) costs the workspace nothing.",
        ];
        return {
          text: lines.join("\n"),
          data: { connector: { name: context.connector.name, role: context.connector.role }, limits: { monthlyBudgetUsd: limits.monthlyBudgetUsd, monthlyHeldUsd: limits.monthlyHeldUsd, monthlyLeftUsd: workspaceLeftUsd(limits), decisionCapUsd: limits.decisionCapUsd }, brands, readiness },
        };
      },
    }),

    defineTool({
      name: "meridian_brand",
      title: "Brand context",
      description: "One brand's own words: what it sells, its audience, tone, claims it may and may not make, words to use and avoid, colours and imagery rules. Free. Use it before writing a script.",
      input: z.object({ brandId: brandIdSchema }),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        const brand = await context.ports.brand(input.brandId);
        if (!brand) return noBrand(input.brandId);
        const filled = Object.entries(brand.facts).filter(([, value]) => value.trim() !== "");
        const text = [`${brand.name} (${brand.id})`, ...filled.map(([label, value]) => `${label}: ${value}`), filled.length === 0 ? "The brand brain is empty; ask the person for the brand's facts." : ""].filter(Boolean).join("\n");
        return { text, data: { brand } };
      },
    }),

    defineTool({
      name: "meridian_video_guide",
      title: "How to make a video",
      description: "The steps and the exact HyperFrames composition format for a Meridian video made from this chat, and the two ways to render it. Free. Read it before writing the coded video.",
      input: z.object({}),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        return { text: VIDEO_GUIDE };
      },
    }),

    defineTool({
      name: "meridian_voice_models",
      title: "Voice models",
      description: "The text-to-speech models on OpenRouter, read live, each with its list rate per 1,000 characters and the voices it offers. Free. Pick a model and one of its voices for meridian_voiceover.",
      input: z.object({}),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(context: ConnectorContext) {
        const listing = await context.ports.speechModels();
        if (!listing.ok) return { text: `The speech models could not be read: ${listing.reason}`, isError: true };
        if (listing.models.length === 0) return { text: "The live catalogue lists no speech model right now, so no voiceover can be made.", data: { models: [] } };
        const lines = listing.models.map(speechModelLine);
        return {
          text: ["Speech models, cheapest first (list rates per character of text; each voiceover holds a fixed amount and settles at OpenRouter's bill):", ...lines].join("\n"),
          data: { models: listing.models },
        };
      },
    }),

    defineTool({
      name: "meridian_voiceover",
      title: "Make a voiceover",
      description: `Speaks your text with a speech model and stores the MP3. Paid from the brand budget, or from the workspace's monthly budget for a video without a brand: a hold is taken first, and the call is refused when the budget is not set or too low. Up to ${VOICEOVER_MAX_CHARS} characters per call. Returns the file and a download link.`,
      input: z.object({
        brandId: optionalBrandIdSchema,
        text: z.string().min(1).max(VOICEOVER_MAX_CHARS).describe("The words to speak, exactly as they should be said."),
        model: z.string().min(3).max(200).describe("A speech model id from meridian_voice_models."),
        voice: z.string().min(1).max(120).describe("One of the voices meridian_voice_models lists for the model (for example 'george' for ElevenLabs)."),
        speed: z.number().min(0.5).max(2).default(1).describe("Speaking rate; 1 is the voice's own pace. Not every model honours it."),
        instructions: z.string().max(500).optional().describe("How to say it, for models that take a delivery style (for example 'upbeat, playful'). Other models ignore it."),
        label: z.string().max(120).optional().describe("A short name for the take, for example 'hook' or 'full narration'."),
        projectId: projectIdSchema.optional(),
      }),
      role: "member",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async run(context: ConnectorContext, input) {
        const scope = await paidScope(context, input, "voiceover", VOICE_CEILING_USD);
        if (!scope.ok) return scope.result;
        const store = await context.ports.files();
        const ready = await store.ready(context.connector.organizationId);
        if (ready.status !== "ready") return { text: `${ready.reason} No voiceover was made, and nothing was spent.`, isError: true };
        const listing = await context.ports.speechModels();
        if (!listing.ok) return { text: `The speech models could not be read, so the model cannot be checked: ${listing.reason} Nothing was spent.`, isError: true };
        const model: SpeechModel | undefined = listing.models.find((item) => item.id === input.model);
        if (!model) return { text: `${input.model} is not a speech model in the live catalogue. meridian_voice_models lists them. Nothing was spent.`, isError: true };
        const voice = voiceProblem(model, input.voice);
        if (voice) return { text: `${voice} Nothing was spent.`, isError: true };
        const outcome = await withHold(context.ports.ledger, { organizationId: context.connector.organizationId, brandId: scope.brandId, ceilingUsd: VOICE_CEILING_USD, purpose: "voiceover", model: input.model }, async () => {
          const spoken = await context.ports.speak({ model: input.model, voice: input.voice, text: input.text, speed: input.speed, instructions: input.instructions ?? null });
          const file = await storeFile(context.sql, store, {
            organizationId: context.connector.organizationId,
            brandId: scope.brandId,
            connectorId: context.connector.id,
            projectId: input.projectId ?? null,
            kind: "voiceover",
            mediaType: spoken.mediaType,
            bytes: spoken.bytes,
            costUsd: spoken.costUsd,
            details: { model: spoken.model, voice: input.voice, speed: input.speed, instructions: input.instructions ?? null, characters: [...input.text].length, label: input.label ?? null, text: input.text },
          });
          return { value: file, costUsd: spoken.costUsd };
        });
        if (!outcome.ok) return { text: `No voiceover: ${outcome.reason}`, isError: true, data: { held: outcome.held } };
        if (input.projectId) await recordProjectSpend(context.sql, { organizationId: context.connector.organizationId, projectId: input.projectId, usd: outcome.settledUsd });
        const view = fileView(context, outcome.value);
        return {
          text: [`Voiceover stored as file ${view.id} (${Math.round(view.bytes / 1024)} KB MP3, ${input.model}, voice ${input.voice}).`, costLine(outcome, scope.brandId), view.url ? `Download (1 hour): ${view.url}` : "", linkNote(context)].filter(Boolean).join("\n"),
          data: { file: view, cost: { reportedUsd: outcome.costUsd, bookedUsd: outcome.settledUsd, basis: outcome.basis } },
        };
      },
    }),

    defineTool({
      name: "meridian_image",
      title: "Make an image",
      description: "Makes one image with the workspace's Studio image model (Settings, Models) and stores it. Paid from the brand budget, or from the workspace's monthly budget for a video without a brand: a hold is taken first and the call is refused when the budget is not set or too low. Returns the file, a download link, and the image itself when it is small enough to show.",
      input: z.object({
        brandId: optionalBrandIdSchema,
        prompt: z.string().min(3).max(4000).describe("What the image shows. Describe it; do not ask for copyrighted characters or real people."),
        aspectRatio: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
        label: z.string().max(120).optional().describe("A short name, for example 'shot 2 background'."),
        projectId: projectIdSchema.optional(),
      }),
      role: "member",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async run(context: ConnectorContext, input) {
        const scope = await paidScope(context, input, "image", IMAGE_CEILING_USD);
        if (!scope.ok) return scope.result;
        const store = await context.ports.files();
        const ready = await store.ready(context.connector.organizationId);
        if (ready.status !== "ready") return { text: `${ready.reason} No image was made, and nothing was spent.`, isError: true };
        const readiness = await context.ports.readiness();
        if (!readiness.image.ready) return { text: `${readiness.image.detail} No image was made, and nothing was spent.`, isError: true };
        const seed = `${context.connector.id}:${context.now().getTime()}`;
        const outcome = await withHold(context.ports.ledger, { organizationId: context.connector.organizationId, brandId: scope.brandId, ceilingUsd: IMAGE_CEILING_USD, purpose: "image", model: readiness.image.model ?? "studio_image" }, async () => {
          const made = await context.ports.image({ prompt: input.prompt, aspectRatio: input.aspectRatio, seed });
          const file = await storeFile(context.sql, store, {
            organizationId: context.connector.organizationId,
            brandId: scope.brandId,
            connectorId: context.connector.id,
            projectId: input.projectId ?? null,
            kind: "image",
            mediaType: made.mediaType,
            bytes: made.bytes,
            costUsd: made.costUsd,
            details: { model: made.model, width: made.width, height: made.height, aspectRatio: input.aspectRatio, prompt: input.prompt, label: input.label ?? null },
          });
          return { value: { file, bytes: made.bytes }, costUsd: made.costUsd };
        });
        if (!outcome.ok) return { text: `No image: ${outcome.reason}`, isError: true, data: { held: outcome.held } };
        if (input.projectId) await recordProjectSpend(context.sql, { organizationId: context.connector.organizationId, projectId: input.projectId, usd: outcome.settledUsd });
        const view = fileView(context, outcome.value.file);
        const media: ToolContent[] = outcome.value.bytes.byteLength <= INLINE_IMAGE_MAX_BYTES ? [{ type: "image", data: Buffer.from(outcome.value.bytes).toString("base64"), mimeType: view.mediaType }] : [];
        return {
          text: [`Image stored as file ${view.id} (${String(view.details.width)} x ${String(view.details.height)}, ${String(view.details.model)}).`, costLine(outcome, scope.brandId), view.url ? `Download (1 hour): ${view.url}` : "", linkNote(context)].filter(Boolean).join("\n"),
          data: { file: view, cost: { reportedUsd: outcome.costUsd, bookedUsd: outcome.settledUsd, basis: outcome.basis } },
          media,
        };
      },
    }),

    defineTool({
      name: "meridian_decide",
      title: "Ask the decision engine",
      description: "Asks the workspace's decision engine (chosen in Connections) to choose between options, answer a yes/no question, or score something 1 to 5, with its probability. Use it instead of judging your own work. Paid under the workspace's decision cap. The answer is uncalibrated until a calibration report says otherwise.",
      input: z.object({
        brandId: optionalBrandIdSchema,
        kind: z.enum(["choose", "yes_no", "score"]),
        question: z.string().min(5).max(600).describe("The question, plainly. For 'choose': which option is best for what."),
        options: z.array(z.string().min(1).max(500)).min(2).max(10).optional().describe("For 'choose': the options, each in full."),
        context: z.string().max(4000).default("").describe("What the engine needs to judge: the script, the brief, the audience."),
        projectId: projectIdSchema.optional(),
      }),
      role: "member",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(context: ConnectorContext, input) {
        if (input.kind === "choose" && (!input.options || input.options.length < 2)) return { text: "A 'choose' question needs at least two options.", isError: true };
        const scope = await paidScope(context, input, "decision", 0);
        if (!scope.ok) return scope.result;
        const answer = await context.ports.decide({ brandId: scope.brandId, kind: input.kind, question: input.question, options: input.options ?? [], context: input.context });
        if (input.projectId && answer.costUsd !== null) await recordProjectSpend(context.sql, { organizationId: context.connector.organizationId, projectId: input.projectId, usd: answer.costUsd });
        if (answer.status !== "answered") {
          return { text: `The decision engine (${answer.engine}) did not answer: ${answer.reason ?? answer.status}.`, data: { decision: answer }, isError: answer.status === "failed" };
        }
        const parts = [
          `Answer (${answer.engine}, ${answer.model}): "${answer.answer ?? "none"}"`,
          answer.probability !== null ? `Probability ${answer.probability.toFixed(2)}.` : "",
          answer.confidence !== null ? `Confidence ${answer.confidence.toFixed(2)}.` : "",
          answer.distribution ? `Distribution: ${Object.entries(answer.distribution).map(([key, value]) => `${key} ${value.toFixed(2)}`).join(", ")}.` : "",
          answer.costUsd !== null ? `Cost ${usd(answer.costUsd)}, as reported.` : "The engine reported no cost for this call.",
          "Uncalibrated: a probability, not a promise.",
          answer.recorded ? "" : "This decision could not be written to the workspace's decision log.",
        ];
        return { text: parts.filter(Boolean).join(" "), data: { decision: answer } };
      },
    }),

    defineTool({
      name: "meridian_files",
      title: "Files made from chats",
      description: "The voiceovers and images this workspace's connectors made, newest first, each with a fresh download link. Free.",
      input: z.object({ brandId: brandIdSchema.optional().describe("Only this brand's files."), projectId: projectIdSchema.optional(), limit: z.int().min(1).max(50).default(20) }),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        const files = await listFiles(context.sql, { organizationId: context.connector.organizationId, brandId: input.brandId ?? null, projectId: input.projectId ?? null, limit: input.limit });
        const views = files.map((file) => fileView(context, file));
        const lines = views.map((file) => `${file.id}: ${file.kind}${file.details.label ? ` "${String(file.details.label)}"` : ""}, ${file.mediaType}, ${file.costUsd === null ? "cost not reported" : usd(file.costUsd)}${file.url ? `, ${file.url}` : ""}`);
        return { text: views.length === 0 ? "No files have been made from a chat yet." : [...lines, linkNote(context)].filter(Boolean).join("\n"), data: { files: views } };
      },
    }),

    defineTool({
      name: "meridian_render",
      title: "Render the coded video",
      description: "Renders your HyperFrames composition. renderer 'claude' (free): returns the files' download links and the commands to render in your own code sandbox. renderer 'hyperframes' (Meridian's cloud render): says whether it is available from this connector.",
      input: z.object({
        renderer: z.enum(["claude", "hyperframes"]),
        fileIds: z.array(z.string().min(1).max(80)).max(40).default([]).describe("The voiceover and image files the composition uses."),
      }),
      role: "member",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        if (input.renderer === "hyperframes") {
          return {
            text: "Meridian's cloud render is not available from this connector yet: it runs inside the video engine's jobs (HyperFrames cloud, then Shotstack), which a chat cannot start. Render with renderer 'claude', or make the video from Meridian's Create page. Nothing was spent.",
            isError: true,
          };
        }
        const files = (await listFiles(context.sql, { organizationId: context.connector.organizationId, limit: 100 })).filter((file) => input.fileIds.includes(file.id));
        const missing = input.fileIds.filter((id) => !files.some((file) => file.id === id));
        const views = files.map((file) => fileView(context, file));
        const assets = views.map((file) => ({ fileId: file.id, path: `assets/${file.id}.${file.mediaType.split("/")[1] === "mpeg" ? "mp3" : file.mediaType.split("/")[1]}`, url: file.url }));
        const commands = [
          "mkdir -p video/assets && cd video",
          ...assets.filter((asset) => asset.url).map((asset) => `curl -fsSL -o ${asset.path} '${asset.url}'`),
          "# write index.html here (meridian_video_guide has the format), pointing at the asset paths above",
          "npx --yes hyperframes@0.8.154 render -o video.mp4",
        ];
        const text = [
          "Render in your own code sandbox; it costs the workspace nothing.",
          missing.length > 0 ? `Not found in this workspace: ${missing.join(", ")}.` : "",
          context.linkSecret ? "" : "No download links could be made (MEDIA_LINK_SECRET is not set on the server).",
          "Commands:",
          ...commands,
          "If the download is refused, allow this Meridian site in the chat's code execution network settings. If the render cannot find a browser, install Chromium in the sandbox first.",
        ].filter(Boolean).join("\n");
        return { text, data: { renderer: "claude", assets, commands, missing } };
      },
    }),
  ];
}
