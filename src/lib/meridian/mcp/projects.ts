// Video projects made from a chat (migration 0157). The rules live in workflow.ts; this module stores a project, applies a checkpoint under
// the project's row lock (so two calls cannot settle the same phase twice), and records what each paid call booked against the video's own
// budget. Every read and write is scoped to the connector's workspace.

import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import {
  applyCheckpoint,
  checkpointProblem,
  isComplete,
  PHASES,
  PROJECT_MODES,
  type Brief,
  type CheckpointRequest,
  type Checkpoints,
  type ProjectMode,
  type ProjectState,
  type ProjectStatus,
} from "./workflow.ts";

type ProjectRow = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  title: string;
  mode: string;
  brief: unknown;
  checkpoints: unknown;
  status: string;
  budget_usd: string | number | null;
  spent_usd: string | number;
  created_at: unknown;
  updated_at: unknown;
};

export type ProjectSummary = { id: string; title: string; brandId: string | null; mode: ProjectMode; status: ProjectStatus; phase: string | null; updatedAt: string };

const json = <T>(value: unknown, fallback: T): T => (value === null || value === undefined ? fallback : typeof value === "string" ? (JSON.parse(value) as T) : (value as T));

function stateOf(row: ProjectRow): ProjectState & { updatedAt: string } {
  const mode = (PROJECT_MODES as readonly string[]).includes(row.mode) ? (row.mode as ProjectMode) : "studio";
  return {
    id: row.id,
    title: row.title,
    brandId: row.brand_id,
    mode,
    status: row.status as ProjectStatus,
    brief: json<Brief>(row.brief, {} as Brief),
    checkpoints: json<Checkpoints>(row.checkpoints, {}),
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
    spentUsd: Number(row.spent_usd),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function createProject(
  sql: Sql,
  input: { organizationId: string; brandId: string | null; connectorId: string; title: string; mode: ProjectMode; brief: Brief; budgetUsd: number | null },
): Promise<ProjectState> {
  const id = randomUUID();
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 120) || "New video";
  const rows = await sql<ProjectRow>`
    insert into mcp_projects (id, organization_id, brand_id, connector_id, title, mode, brief, budget_usd)
    values (${id}, ${input.organizationId}, ${input.brandId}, ${input.connectorId}, ${title}, ${input.mode}, ${JSON.stringify(input.brief)}::jsonb, ${input.budgetUsd})
    returning *
  `;
  return stateOf(rows[0]!);
}

/** One project of the workspace, or null. */
export async function readProject(sql: Sql, organizationId: string, projectId: string): Promise<ProjectState | null> {
  const rows = await sql<ProjectRow>`select * from mcp_projects where id = ${projectId} and organization_id = ${organizationId} limit 1`;
  return rows[0] ? stateOf(rows[0]) : null;
}

/** The workspace's recent projects, newest first, to resume one. */
export async function listProjects(sql: Sql, organizationId: string, limit = 10): Promise<ProjectSummary[]> {
  const rows = await sql<ProjectRow>`select * from mcp_projects where organization_id = ${organizationId} order by updated_at desc limit ${Math.min(Math.max(limit, 1), 50)}`;
  return rows.map((row) => {
    const state = stateOf(row);
    const phase = PHASES.find((item) => state.checkpoints[item]?.status !== "resolved") ?? null;
    return { id: state.id, title: state.title, brandId: state.brandId, mode: state.mode, status: state.status, phase, updatedAt: state.updatedAt };
  });
}

/**
 * Applies one checkpoint under the project's row lock. The rules are checked again inside the lock, so the answer is the state as it is
 * now. Settling the last phase delivers the project.
 */
export async function checkpointProject(
  sql: Sql,
  input: { organizationId: string; projectId: string; request: CheckpointRequest; now: string },
): Promise<{ ok: true; project: ProjectState } | { ok: false; reason: string }> {
  return withTransaction(sql, async (tx) => {
    const rows = await tx<ProjectRow>`select * from mcp_projects where id = ${input.projectId} and organization_id = ${input.organizationId} for update`;
    if (!rows[0]) return { ok: false as const, reason: "There is no such video project in this workspace." };
    const project = stateOf(rows[0]);
    const problem = checkpointProblem(project, input.request);
    if (problem) return { ok: false as const, reason: problem };
    const checkpoints = applyCheckpoint(project.checkpoints, input.request, input.now);
    const status: ProjectStatus = isComplete(checkpoints) ? "delivered" : "active";
    const updated = await tx<ProjectRow>`
      update mcp_projects set checkpoints = ${JSON.stringify(checkpoints)}::jsonb, status = ${status}, updated_at = now()
      where id = ${project.id} returning *
    `;
    return { ok: true as const, project: stateOf(updated[0]!) };
  });
}

/** Changes how involved the person is, the video's budget, or abandons it. A budget below what is already spent is refused. */
export async function updateProject(
  sql: Sql,
  input: { organizationId: string; projectId: string; mode?: ProjectMode; budgetUsd?: number | null; abandon?: boolean },
): Promise<{ ok: true; project: ProjectState } | { ok: false; reason: string }> {
  return withTransaction(sql, async (tx) => {
    const rows = await tx<ProjectRow>`select * from mcp_projects where id = ${input.projectId} and organization_id = ${input.organizationId} for update`;
    if (!rows[0]) return { ok: false as const, reason: "There is no such video project in this workspace." };
    const project = stateOf(rows[0]);
    if (project.status !== "active") return { ok: false as const, reason: `This video is ${project.status}.` };
    if (input.budgetUsd !== undefined && input.budgetUsd !== null && input.budgetUsd < project.spentUsd) {
      return { ok: false as const, reason: `$${project.spentUsd.toFixed(2)} is already spent on this video; its budget cannot be lower.` };
    }
    const mode = input.mode ?? project.mode;
    const budget = input.budgetUsd === undefined ? project.budgetUsd : input.budgetUsd;
    const status: ProjectStatus = input.abandon ? "abandoned" : "active";
    const updated = await tx<ProjectRow>`
      update mcp_projects set mode = ${mode}, budget_usd = ${budget}, status = ${status}, updated_at = now() where id = ${project.id} returning *
    `;
    return { ok: true as const, project: stateOf(updated[0]!) };
  });
}

/** Adds what a paid call booked to the video's spend. */
export async function recordProjectSpend(sql: Sql, input: { organizationId: string; projectId: string; usd: number }): Promise<void> {
  if (!(input.usd > 0)) return;
  await sql`update mcp_projects set spent_usd = spent_usd + ${input.usd}, updated_at = now() where id = ${input.projectId} and organization_id = ${input.organizationId}`;
}
