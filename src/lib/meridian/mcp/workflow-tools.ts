// The connector's workflow tools: the intake Q&A a chat runs first, the video project it then makes, and the checkpoints between phases.
// The rules are in workflow.ts and are enforced here, so Claude and ChatGPT follow the same workflow and neither can skip a person's
// checkpoint, settle phases out of order, or pay for media before the asset plan is settled.

import { z } from "zod";
import { usd } from "./paid.ts";
import { checkpointProject, createProject, listProjects, readProject, updateProject } from "./projects.ts";
import { defineTool, type McpTool, type ToolResult } from "./protocol.ts";
import { brandIdSchema, noBrand, projectIdSchema, requireBrand, type ConnectorContext } from "./tools.ts";
import { listFiles } from "./files.ts";
import {
  CONTENT_MAX,
  DECIDERS,
  INTAKE_INSTRUCTIONS,
  intakeQuestions,
  MODE_COPY,
  nextStep,
  PHASE_COPY,
  PHASES,
  planLines,
  PROJECT_MODES,
  styleOptions,
  type Brief,
  type CheckpointRequest,
  type ProjectState,
} from "./workflow.ts";

const LETTERS = "ABCDEFGH";

function projectView(project: ProjectState) {
  return {
    id: project.id,
    title: project.title,
    brandId: project.brandId,
    mode: project.mode,
    status: project.status,
    budgetUsd: project.budgetUsd,
    spentUsd: Math.round(project.spentUsd * 10_000) / 10_000,
    phases: PHASES.map((phase) => {
      const checkpoint = project.checkpoints[phase];
      return { phase, status: checkpoint?.status ?? "open", decidedBy: checkpoint?.decidedBy ?? null, choice: checkpoint?.choice ?? null, options: checkpoint?.options ?? [] };
    }),
  };
}

function stateLines(project: ProjectState): string[] {
  return PHASES.map((phase) => {
    const checkpoint = project.checkpoints[phase];
    if (!checkpoint) return `${PHASE_COPY[phase].label}: open`;
    if (checkpoint.status === "proposed") return `${PHASE_COPY[phase].label}: options shown (${checkpoint.options.map((option) => option.label).join(", ")}), waiting for the person`;
    const by = checkpoint.decidedBy === "person" ? "the person" : checkpoint.decidedBy === "decision_engine" ? "the decision engine" : "the chat";
    return `${PHASE_COPY[phase].label}: settled by ${by}${checkpoint.choice ? ` (${checkpoint.choice})` : checkpoint.input ? " (their own words)" : ""}`;
  });
}

const spendLine = (project: ProjectState) => `Spent on this video: ${usd(project.spentUsd)}${project.budgetUsd === null ? " (no cap beyond the brand budget)" : ` of ${usd(project.budgetUsd)}`}.`;

export function workflowTools(): McpTool<ConnectorContext>[] {
  return [
    defineTool({
      name: "meridian_start",
      title: "Start a video: quick Q&A",
      description: "Call this first, before making anything: it returns the short intake Q&A to ask the person (brand, goal, idea, format, style, voice, how involved they want to be, render, budget), each with options and room for their own answer. Free.",
      input: z.object({}),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(context: ConnectorContext) {
        const [limits, cookbooks] = await Promise.all([context.ports.limits(), context.ports.styles()]);
        const brands = limits.brands.map((brand) => ({ id: brand.brandId, name: brand.name, leftUsd: brand.budgetUsd === null ? null : Math.max(0, brand.budgetUsd - brand.committedUsd) }));
        if (brands.length === 0) return { text: "This workspace has no brand yet. Ask the person to add one in Meridian first; a video belongs to a brand.", isError: true };
        const styles = styleOptions(cookbooks);
        const questions = intakeQuestions({ brands, styles });
        const lines = questions.map((question, number) => {
          const options = question.options.map((option, i) => `   ${LETTERS[i]}. ${option}`);
          return [`${number + 1}. ${question.question}${question.required ? "" : " (optional)"}`, ...options, ...(question.ownAnswer && question.options.length > 0 ? ["   Or your own answer."] : [])].join("\n");
        });
        const single = brands.length === 1 ? `\nThe brand is ${brands[0]!.name} (${brands[0]!.id}), the only one in this workspace.` : "";
        return {
          text: [`Quick Q&A before making the video. ${INTAKE_INSTRUCTIONS}${single}`, "", ...lines].join("\n"),
          data: { questions, brands, styles, modes: PROJECT_MODES.map((mode) => ({ mode, ...MODE_COPY[mode] })) },
        };
      },
    }),

    defineTool({
      name: "meridian_project_create",
      title: "Create the video project",
      description: "Creates the video project from the person's Q&A answers and returns the plan (who decides each step in the chosen mode) and the first step. Free.",
      input: z.object({
        brandId: brandIdSchema,
        goal: z.string().min(2).max(300),
        idea: z.string().min(3).max(2000),
        platform: z.string().min(2).max(120).default("Reels / TikTok / Shorts"),
        seconds: z.int().min(5).max(180),
        style: z.string().min(2).max(300).describe("A style id from meridian_start (for example ck_voice_listicle), or the person's own description."),
        voiceover: z.boolean(),
        voiceTone: z.string().max(200).default("warm and natural"),
        mode: z.enum(PROJECT_MODES),
        render: z.enum(["chat", "code_only"]),
        budgetUsd: z.number().min(0).max(10_000).nullable().default(null).describe("The most Meridian may spend on this video; null for no cap beyond the brand budget."),
        language: z.string().min(2).max(16).default("en"),
        audience: z.string().max(500).default(""),
        title: z.string().max(120).optional(),
      }),
      role: "member",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        const brand = await requireBrand(context, input.brandId);
        if (!brand) return noBrand(input.brandId);
        const cookbooks = await context.ports.styles();
        const cookbook = cookbooks.find((item) => item.cookbookId === input.style.trim());
        const brief: Brief = {
          goal: input.goal.trim(),
          idea: input.idea.trim(),
          platform: input.platform.trim(),
          seconds: input.seconds,
          style: cookbook ? { id: cookbook.cookbookId, label: cookbook.label, instructions: cookbook.instructions } : { id: null, label: input.style.trim(), instructions: [] },
          voice: { wanted: input.voiceover, tone: input.voiceover ? input.voiceTone.trim() : "" },
          language: input.language,
          render: input.render,
          audience: input.audience.trim(),
        };
        const project = await createProject(context.sql, {
          organizationId: context.connector.organizationId,
          brandId: brand.id,
          connectorId: context.connector.id,
          title: input.title?.trim() || input.idea.trim().split(/[.!?\n]/)[0]!.slice(0, 80),
          mode: input.mode,
          brief,
          budgetUsd: input.budgetUsd,
        });
        const next = nextStep(project);
        return {
          text: [
            `Video project ${project.id} created: "${project.title}" for ${brand.name}, ${MODE_COPY[project.mode].label} mode.`,
            "Plan:",
            ...planLines(project.mode).map((line) => `- ${line}`),
            spendLine(project),
            "",
            next,
          ].join("\n"),
          data: { project: projectView(project), next },
        };
      },
    }),

    defineTool({
      name: "meridian_project",
      title: "Video project status",
      description: "One video project: each phase, who settled it, what was spent against its budget, its files, and the exact next step. Without a projectId, the recent projects, to resume one. Free.",
      input: z.object({ projectId: projectIdSchema.optional() }),
      role: "viewer",
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        if (!input.projectId) {
          const projects = await listProjects(context.sql, context.connector.organizationId);
          if (projects.length === 0) return { text: "No video project yet. Start one with meridian_start.", data: { projects } };
          return {
            text: projects.map((project) => `${project.id}: "${project.title}", ${project.mode}, ${project.status}${project.phase ? `, at ${PHASE_COPY[project.phase as keyof typeof PHASE_COPY].label}` : ""}`).join("\n"),
            data: { projects },
          };
        }
        const project = await readProject(context.sql, context.connector.organizationId, input.projectId);
        if (!project) return { text: `There is no video project '${input.projectId}' in this workspace.`, isError: true };
        const files = await listFiles(context.sql, { organizationId: context.connector.organizationId, projectId: project.id, limit: 50 });
        const next = nextStep(project);
        return {
          text: [`"${project.title}" (${project.id}), ${MODE_COPY[project.mode].label} mode, ${project.status}.`, ...stateLines(project), spendLine(project), `Files: ${files.length}.`, "", next].join("\n"),
          data: { project: projectView(project), brief: project.brief, files: files.map((file) => ({ id: file.id, kind: file.kind, costUsd: file.costUsd })), next },
        };
      },
    }),

    defineTool({
      name: "meridian_checkpoint",
      title: "Checkpoint",
      description: "Moves a video project through its phases. 'propose' records the options you are showing the person; 'resolve' settles the phase (with the person's choice or their own words when it is their checkpoint, and the settled text); 'reopen' goes back to a phase and clears every later one. Meridian enforces the order and who decides. Free.",
      input: z.object({
        projectId: projectIdSchema,
        phase: z.enum(PHASES),
        action: z.enum(["propose", "resolve", "reopen"]),
        options: z.array(z.object({ label: z.string().min(1).max(60), summary: z.string().min(1).max(500) })).max(5).default([]).describe("For 'propose': the options shown, each with a short label (A, B, C or a name) and a one-line summary."),
        decidedBy: z.enum(DECIDERS).optional().describe("For 'resolve': who decided. 'person' only when the person answered in this chat."),
        choice: z.string().max(60).optional().describe("For 'resolve': the label of the option chosen."),
        input: z.string().max(4000).optional().describe("For 'resolve': the person's own words, when they did not pick an option or added to it."),
        content: z.string().max(CONTENT_MAX).optional().describe("For 'resolve': the settled text (the concept, the script, the storyboard, the asset plan; for later phases, a short note)."),
      }),
      role: "member",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        let request: CheckpointRequest;
        if (input.action === "propose") request = { action: "propose", phase: input.phase, options: input.options };
        else if (input.action === "reopen") request = { action: "reopen", phase: input.phase };
        else {
          if (!input.decidedBy) return { text: "Say who decided (decidedBy: person, chat or decision_engine).", isError: true };
          request = { action: "resolve", phase: input.phase, decidedBy: input.decidedBy, choice: input.choice ?? null, input: input.input ?? null, content: input.content ?? null };
        }
        const result = await checkpointProject(context.sql, { organizationId: context.connector.organizationId, projectId: input.projectId, request, now: context.now().toISOString() });
        if (!result.ok) return { text: result.reason, isError: true };
        const project = result.project;
        const label = PHASE_COPY[input.phase].label;
        const done = input.action === "propose" ? `${label}: options recorded. Show them to the person and wait for their answer.` : input.action === "reopen" ? `${label} reopened; it and every later phase are open again.` : `${label} settled.`;
        const next = input.action === "propose" ? "" : project.status === "delivered" ? `The video is delivered. ${spendLine(project)}` : nextStep(project);
        const result2: ToolResult = { text: [done, next].filter(Boolean).join("\n"), data: { project: projectView(project), next } };
        return result2;
      },
    }),

    defineTool({
      name: "meridian_project_update",
      title: "Change a video project",
      description: "Changes how involved the person is (mode), the video's own budget, or abandons the project. Use it when the person asks. Free.",
      input: z.object({
        projectId: projectIdSchema,
        mode: z.enum(PROJECT_MODES).optional(),
        budgetUsd: z.number().min(0).max(10_000).nullable().optional().describe("The new budget for this video; null for no cap beyond the brand budget."),
        abandon: z.boolean().optional(),
      }),
      role: "member",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async run(context: ConnectorContext, input) {
        const result = await updateProject(context.sql, { organizationId: context.connector.organizationId, projectId: input.projectId, mode: input.mode, budgetUsd: input.budgetUsd, abandon: input.abandon });
        if (!result.ok) return { text: result.reason, isError: true };
        const project = result.project;
        return {
          text: [`"${project.title}" is now ${MODE_COPY[project.mode].label} mode, ${project.status}.`, spendLine(project), project.status === "active" ? nextStep(project) : ""].filter(Boolean).join("\n"),
          data: { project: projectView(project) },
        };
      },
    }),
  ];
}
