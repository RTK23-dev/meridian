// The canvas's server functions for video projects (the ones a chat or Claude Code makes through the connector). Any member of the
// workspace may look; a member may settle their own checkpoint, reopen a step, switch how involved they are, or stop a video. Every read
// and write is scoped to the workspace, and every change is written to the audit log. Checkpoint text was written by a chat: it is data,
// shown as text, never run or passed on as an instruction.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { asText, objectInput, requireMembership, writeAudit } from "../api-shared";
import type { Sql } from "../learning/store.ts";
import { CHOICE_MAX, isPhase, isProjectMode, personResolution, reopenProblem } from "./canvas-decisions.ts";
import { fileLink, linkSecretFrom, listFiles, type McpFileKind } from "./files.ts";
import { checkpointProject, listProjects, readProject, updateProject, type ProjectSummary, type StoredProject } from "./projects.ts";
import { CONTENT_MAX, type Phase, type ProjectMode } from "./workflow.ts";

const LIST_LIMIT = 30;
const FILE_LIMIT = 40;

export type CanvasFile = { id: string; kind: McpFileKind; mediaType: string; bytes: number; costUsd: number | null; createdAt: string; url: string | null };
export type CanvasMaker = { status: string; runnerName: string; progress: string; requestId: string } | null;
export type CanvasProject = StoredProject & { brandName: string | null; files: CanvasFile[]; maker: CanvasMaker };
export type CanvasProjectSummary = ProjectSummary & { brandName: string | null };

function organizationOf(input: unknown): { organizationId: string; body: Record<string, unknown> } {
  const body = objectInput(input);
  const organizationId = asText(body.organizationId);
  if (!organizationId) throw new Error("organizationId is required.");
  return { organizationId, body };
}

function projectOf(input: unknown): { organizationId: string; projectId: string; body: Record<string, unknown> } {
  const { organizationId, body } = organizationOf(input);
  const projectId = asText(body.projectId);
  if (!projectId) throw new Error("projectId is required.");
  return { organizationId, projectId, body };
}

function phaseOf(body: Record<string, unknown>): Phase {
  if (!isPhase(body.phase)) throw new Error("phase must be one of concept, script, storyboard, assets, build, render, deliver.");
  return body.phase;
}

async function brandNames(sql: Sql, organizationId: string): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; name: string }>`select id, name from brands where organization_id = ${organizationId} and deleted_at is null`;
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The project as the canvas draws it: its state, its brand's name, its files with a signed link each, and the Claude Code job making it. */
async function canvasProject(sql: Sql, organizationId: string, project: StoredProject): Promise<CanvasProject> {
  const names = project.brandId ? await brandNames(sql, organizationId) : new Map<string, string>();
  const secret = linkSecretFrom(process.env);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const files = (await listFiles(sql, { organizationId, projectId: project.id, limit: FILE_LIMIT })).map((file) => ({
    id: file.id,
    kind: file.kind,
    mediaType: file.mediaType,
    bytes: file.bytes,
    costUsd: file.costUsd,
    createdAt: file.createdAt,
    // A relative link on this site. With no signing secret there is no link: the file is listed, and nothing unsigned is served.
    url: fileLink({ origin: "", fileId: file.id, nowSeconds, secret })?.url ?? null,
  }));
  const jobs = await sql<{ status: string; runner_name: string | null; progress: string | null; id: string }>`
    select id, status, runner_name, progress from claude_code_requests
    where organization_id = ${organizationId} and project_id = ${project.id}
    order by created_at desc limit 1
  `;
  const job = jobs[0];
  return {
    ...project,
    brandName: project.brandId ? names.get(project.brandId) ?? null : null,
    files,
    maker: job ? { status: job.status, runnerName: job.runner_name ?? "", progress: job.progress ?? "", requestId: job.id } : null,
  };
}

/** The workspace's video projects, newest first, with each brand's name. */
export const listVideoProjects = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({ organizationId: organizationOf(input).organizationId }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<CanvasProjectSummary[]> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const [projects, names] = await Promise.all([listProjects(sql, data.organizationId, LIST_LIMIT), brandNames(sql, data.organizationId)]);
    return projects.map((project) => ({ ...project, brandName: project.brandId ? names.get(project.brandId) ?? null : null }));
  });

/** One video project, as the canvas draws it. */
export const getVideoProject = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const { organizationId, projectId } = projectOf(input);
    return { organizationId, projectId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<CanvasProject> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    const project = await readProject(sql, data.organizationId, data.projectId);
    if (!project) throw new Error("There is no such video project in this workspace.");
    return canvasProject(sql, data.organizationId, project);
  });

/** The person settles their own step: the option they picked, or their own words. */
export const decideVideoCheckpoint = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, projectId, body } = projectOf(input);
    const choice = asText(body.choice).trim();
    const own = asText(body.input).trim();
    if (choice.length > CHOICE_MAX) throw new Error("That option name is too long.");
    if (own.length > CONTENT_MAX) throw new Error("Your own words are too long.");
    return { organizationId, projectId, phase: phaseOf(body), choice: choice || null, input: own || null };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<CanvasProject> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "member");
    const project = await readProject(sql, data.organizationId, data.projectId);
    if (!project) throw new Error("There is no such video project in this workspace.");
    const resolution = personResolution(project, data.phase, { choice: data.choice, input: data.input });
    if (!resolution.ok) throw new Error(resolution.reason);
    // The rules are checked again under the row lock, so a chat that settled the step a moment ago wins and this answer is refused.
    const result = await checkpointProject(sql, { organizationId: data.organizationId, projectId: data.projectId, request: resolution.request, now: new Date().toISOString() });
    if (!result.ok) throw new Error(result.reason);
    await writeAudit(sql, {
      organizationId: data.organizationId,
      brandId: project.brandId,
      actorId: context.userId,
      action: "video_project.checkpoint_decided",
      objectType: "mcp_project",
      objectId: project.id,
      metadata: { phase: data.phase, answer: data.input ? "own words" : "option", ...(data.choice ? { choice: data.choice } : {}) },
    });
    return canvasProject(sql, data.organizationId, result.project);
  });

/** Reopens a settled step. This clears it and every later step, so the chat makes them again. */
export const reopenVideoPhase = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, projectId, body } = projectOf(input);
    return { organizationId, projectId, phase: phaseOf(body) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<CanvasProject> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "member");
    const project = await readProject(sql, data.organizationId, data.projectId);
    if (!project) throw new Error("There is no such video project in this workspace.");
    const problem = reopenProblem(project, data.phase);
    if (problem) throw new Error(problem);
    const result = await checkpointProject(sql, { organizationId: data.organizationId, projectId: data.projectId, request: { action: "reopen", phase: data.phase }, now: new Date().toISOString() });
    if (!result.ok) throw new Error(result.reason);
    await writeAudit(sql, { organizationId: data.organizationId, brandId: project.brandId, actorId: context.userId, action: "video_project.phase_reopened", objectType: "mcp_project", objectId: project.id, metadata: { phase: data.phase } });
    return canvasProject(sql, data.organizationId, result.project);
  });

/** Switches how involved the person is (Studio, Guided, Orchestrator), or stops the video. The budget stays a chat or admin change. */
export const updateVideoProject = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const { organizationId, projectId, body } = projectOf(input);
    const mode = body.mode === undefined || body.mode === null || body.mode === "" ? undefined : body.mode;
    if (mode !== undefined && !isProjectMode(mode)) throw new Error("mode must be studio, guided or orchestrator.");
    const abandon = body.abandon === true;
    if (!mode && !abandon) throw new Error("Say what to change: mode, or abandon.");
    return { organizationId, projectId, mode: mode as ProjectMode | undefined, abandon };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<CanvasProject> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "member");
    const result = await updateProject(sql, { organizationId: data.organizationId, projectId: data.projectId, mode: data.mode, abandon: data.abandon });
    if (!result.ok) throw new Error(result.reason);
    await writeAudit(sql, {
      organizationId: data.organizationId,
      brandId: result.project.brandId,
      actorId: context.userId,
      action: data.abandon ? "video_project.abandoned" : "video_project.mode_changed",
      objectType: "mcp_project",
      objectId: data.projectId,
      metadata: data.mode ? { mode: data.mode } : {},
    });
    return canvasProject(sql, data.organizationId, result.project);
  });
