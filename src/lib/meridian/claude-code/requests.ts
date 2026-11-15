// A request to make a video from Claude Code (migration 0160). One click records the idea and its source as a snapshot and returns the
// one line to paste into Claude Code. The request starts nothing and spends nothing; Claude Code reads it through the connector, makes
// the video, and the project it creates is linked back. Every read and write is scoped to the workspace.

import { randomBytes } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { hasRole, isRole } from "../access.ts";

const canMake = (role: string) => isRole(role) && hasRole(role, "member");
import { isSkillChoice, SKILL_CHOICES, type SkillChoiceId } from "./skills.ts";
import { factorySource, gatheredSource, type RequestSource, type SourceSnapshot } from "./sources.ts";

export const REQUEST_TTL_HOURS = 24;
export const IDEA_MAX = 2000;

export type ClaudeCodeRequest = {
  id: string;
  /** What to make (a SkillChoiceId). */
  choice: SkillChoiceId;
  brandId: string | null;
  source: RequestSource;
  idea: string;
  snapshot: SourceSnapshot;
  status: "open" | "claimed" | "done" | "cancelled";
  projectId: string | null;
  createdAt: string;
  expiresAt: string;
};

type Row = {
  id: string;
  brand_id: string | null;
  source: string;
  idea: string;
  snapshot: unknown;
  status: string;
  project_id: string | null;
  created_at: unknown;
  expires_at: unknown;
};

const iso = (value: unknown) => new Date(value as string).toISOString();
const parse = <T>(value: unknown, fallback: T): T => (value === null || value === undefined ? fallback : typeof value === "string" ? (JSON.parse(value) as T) : (value as T));

function viewOf(row: Row): ClaudeCodeRequest {
  const snapshot = parse<SourceSnapshot>(row.snapshot, { idea: row.idea, lines: [], refs: [] });
  return {
    id: row.id,
    choice: snapshot.choice && isSkillChoice(snapshot.choice) ? snapshot.choice : "auto",
    brandId: row.brand_id,
    source: row.source as RequestSource,
    idea: row.idea,
    snapshot,
    status: row.status as ClaudeCodeRequest["status"],
    projectId: row.project_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  };
}

/** The one line to paste into Claude Code. The id is not a secret: the connector scopes every read to its own workspace. */
export const requestPrompt = (id: string) => `/meridian-video request ${id}`;

export type CreateRequestInput = {
  organizationId: string;
  userId: string;
  role: string;
  brandId: string | null;
  source: RequestSource;
  /** What to make (a SkillChoiceId). Leave out for "auto". */
  choice?: string;
  /** The person's own words. Required for "idea"; optional extra direction for the others. */
  idea: string;
  now?: () => Date;
};

export type CreateRequestResult = { ok: true; request: ClaudeCodeRequest; prompt: string } | { ok: false; reason: string };

/** Makes a request. A member may; a viewer may not. A source with nothing behind it is refused with what to do first, never filled in. */
export async function createRequest(sql: Sql, input: CreateRequestInput): Promise<CreateRequestResult> {
  if (!canMake(input.role)) return { ok: false, reason: "Making a video needs the member role or above." };
  const choice: SkillChoiceId = input.choice === undefined || input.choice === "" ? "auto" : isSkillChoice(input.choice) ? input.choice : "auto";
  if (input.choice && !isSkillChoice(input.choice)) return { ok: false, reason: `Choose one of: ${SKILL_CHOICES.map((item) => item.id).join(", ")}.` };
  const words = input.idea.replace(/\s+/g, " ").trim().slice(0, IDEA_MAX);
  if (input.brandId) {
    const brand = await sql<{ id: string }>`select id from brands where id = ${input.brandId} and organization_id = ${input.organizationId} and deleted_at is null`;
    if (!brand[0]) return { ok: false, reason: "That brand is not in this workspace." };
  }
  let snapshot: SourceSnapshot;
  if (input.source === "idea") {
    if (words.length < 3) return { ok: false, reason: "Write the idea in a few words first." };
    snapshot = { idea: words, lines: [], refs: [] };
  } else {
    const found = input.source === "gathered" ? await gatheredSource(sql, input.organizationId, input.brandId) : await factorySource(sql, input.organizationId, input.brandId);
    if (!found.ok) return { ok: false, reason: found.reason };
    snapshot = found.snapshot;
  }
  snapshot = { ...snapshot, choice };
  const idea = (input.source === "idea" ? words : words.length >= 3 ? `${snapshot.idea}. ${words}` : snapshot.idea).slice(0, IDEA_MAX);
  if (idea.length < 3) return { ok: false, reason: "The source gave no idea to start from. Write one in your own words." };
  const now = (input.now ?? (() => new Date()))();
  const expires = new Date(now.getTime() + REQUEST_TTL_HOURS * 3_600_000);
  const id = `ccr_${randomBytes(9).toString("base64url")}`;
  const rows = await sql<Row>`
    insert into claude_code_requests (id, organization_id, brand_id, created_by, source, idea, snapshot, expires_at, created_at)
    values (${id}, ${input.organizationId}, ${input.brandId}, ${input.userId}, ${input.source}, ${idea}, ${JSON.stringify(snapshot)}::jsonb, ${expires.toISOString()}, ${now.toISOString()})
    returning id, brand_id, source, idea, snapshot, status, project_id, created_at, expires_at
  `;
  return { ok: true, request: viewOf(rows[0]!), prompt: requestPrompt(id) };
}

/** A request of this workspace that is neither cancelled nor past its time, or null. */
export async function readRequest(sql: Sql, organizationId: string, id: string, now: () => Date = () => new Date()): Promise<ClaudeCodeRequest | null> {
  const rows = await sql<Row>`
    select id, brand_id, source, idea, snapshot, status, project_id, created_at, expires_at
    from claude_code_requests
    where id = ${id} and organization_id = ${organizationId} and status <> 'cancelled' and expires_at > ${now().toISOString()}
  `;
  return rows[0] ? viewOf(rows[0]) : null;
}

/** The workspace's recent requests, newest first, for the Settings list. */
export async function listRequests(sql: Sql, organizationId: string, limit = 8): Promise<ClaudeCodeRequest[]> {
  const rows = await sql<Row>`
    select id, brand_id, source, idea, snapshot, status, project_id, created_at, expires_at
    from claude_code_requests where organization_id = ${organizationId} and status <> 'cancelled'
    order by created_at desc limit ${limit}
  `;
  return rows.map(viewOf);
}

/** Marks an open request claimed when Claude Code first reads it. Idempotent, and never reopens a finished one. */
export async function claimRequest(sql: Sql, organizationId: string, id: string): Promise<void> {
  await sql`update claude_code_requests set status = 'claimed' where id = ${id} and organization_id = ${organizationId} and status = 'open'`;
}

/** Links the project a request produced, and marks it done. Only a request of the same workspace (and, if it has one, the same brand). */
export async function completeRequest(sql: Sql, organizationId: string, id: string, project: { id: string; brandId: string | null }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    update claude_code_requests set status = 'done', project_id = ${project.id}
    where id = ${id} and organization_id = ${organizationId} and status in ('open', 'claimed') and (brand_id is null or brand_id is not distinct from ${project.brandId})
    returning id
  `;
  return rows.length > 0;
}

/** Cancels a request of the workspace. A member may. */
export async function cancelRequest(sql: Sql, input: { organizationId: string; role: string; id: string }): Promise<boolean> {
  if (!canMake(input.role)) return false;
  const rows = await sql<{ id: string }>`update claude_code_requests set status = 'cancelled' where id = ${input.id} and organization_id = ${input.organizationId} and status in ('open', 'claimed') returning id`;
  return rows.length > 0;
}
