// Content governance (prompt 18) against the database: a brand's pillars and cadence, its quality rubrics and the scores on its delivered
// videos, and its rights records. Every call needs the admin role in the brand's workspace (requireBrand), checks that each row belongs to the
// brand, and writes an audit line for each change. Scores are appended, never edited. A rights record is revoked, never deleted.

import { randomUUID } from "node:crypto";
import { requireBrand } from "../brand-membership.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { deliveredManifestOf } from "./manifest.ts";
import {
  cadenceProblem,
  cadenceStatus,
  criteriaProblem,
  pillarMixOfCounts,
  pillarProblem,
  rightsProblem,
  scoresProblem,
  weightedTotal,
  type CadenceStatus,
  type PillarMixRow,
  type RubricCriterion,
} from "./governance.ts";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function auditGovernance(
  sql: Sql,
  entry: { organizationId: string; brandId: string; actorId: string; action: string; objectId: string; metadata: Record<string, string> },
): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${entry.organizationId}, ${entry.brandId}, ${entry.actorId}, ${entry.action}, 'content_governance', ${entry.objectId}, ${JSON.stringify(entry.metadata)})
  `;
}

type Pillar = { id: string; name: string; target_share: string | number | null };

export type GovernanceView = {
  brandId: string;
  pillars: Array<{ id: string; name: string; targetShare: number | null }>;
  pillarMix: PillarMixRow[];
  cadence: CadenceStatus;
  rubrics: Array<{ id: string; name: string; criteria: RubricCriterion[] }>;
  rights: Array<{ id: string; subject: string; holder: string; permittedUse: string; validUntil: string | null; attachmentId: string | null; attachmentName: string | null; valid: boolean; revokedAt: string | null }>;
  /** The brand's videos, for assigning a pillar, and its stored files, for linking a rights record. */
  videos: Array<{ id: string; title: string; status: string; pillarId: string | null }>;
  files: Array<{ id: string; fileName: string; sessionTitle: string }>;
};

function criteriaOf(text: string): RubricCriterion[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const record = item as { name?: unknown; weight?: unknown };
      return typeof record.name === "string" && typeof record.weight === "number" ? [{ name: record.name, weight: record.weight }] : [];
    });
  } catch {
    return [];
  }
}

/** Everything a brand's governance screen shows, read for a brand's workspace admin. */
export async function governanceOf(sql: Sql, userId: string, input: { brandId: string }): Promise<GovernanceView> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  const pillars = await sql<Pillar>`
    select id, name, target_share from content_pillars where brand_id = ${input.brandId} and organization_id = ${access.organizationId} order by name asc
  `;
  const videos = await sql<{ id: string; title: string; status: string; pillar_id: string | null; started_at: unknown }>`
    select id, title, status, pillar_id, started_at from content_factory_sessions
    where brand_id = ${input.brandId} and organization_id = ${access.organizationId} order by updated_at desc limit 200
  `;
  const cadenceRows = await sql<{ videos_per_week: number }>`
    select videos_per_week from content_cadence where brand_id = ${input.brandId} and organization_id = ${access.organizationId} limit 1
  `;
  const rubrics = await sql<{ id: string; name: string; criteria: string }>`
    select id, name, criteria from quality_rubrics where brand_id = ${input.brandId} and organization_id = ${access.organizationId} order by name asc
  `;
  const rights = await sql<{ id: string; subject: string; holder: string; permitted_use: string; valid_until: unknown; attachment_id: string | null; file_name: string | null; revoked_at: unknown }>`
    select r.id, r.subject, r.holder, r.permitted_use, r.valid_until, r.attachment_id, r.revoked_at, a.file_name
    from rights_records r left join content_factory_attachments a on a.id = r.attachment_id
    where r.brand_id = ${input.brandId} and r.organization_id = ${access.organizationId}
    order by r.created_at desc limit 200
  `;
  // The newest files first, so a brand with many stored files still offers the recent ones a rights record is needed for.
  const files = await sql<{ id: string; file_name: string | null; session_title: string }>`
    select a.id, a.file_name, s.title as session_title from content_factory_attachments a
    join content_factory_sessions s on s.id = a.session_id
    where s.brand_id = ${input.brandId} and a.organization_id = ${access.organizationId} and a.kind = 'file'
    order by a.created_at desc limit 100
  `;
  const now = today();
  // The cadence and the mix are counted in the database over every video of the brand, not over the rows this screen lists (limit above).
  const [weekCount] = await sql<{ n: number }>`
    select count(*)::int as n from content_factory_sessions
    where brand_id = ${input.brandId} and organization_id = ${access.organizationId} and started_at is not null and started_at >= now() - interval '7 days'
  `;
  const mixCounts = await sql<{ pillar_id: string | null; started: number }>`
    select pillar_id, count(*)::int as started from content_factory_sessions
    where brand_id = ${input.brandId} and organization_id = ${access.organizationId} and status = 'started'
    group by pillar_id
  `;
  const cadence = cadenceStatus(cadenceRows[0]?.videos_per_week ?? null, Number(weekCount?.n ?? 0));
  const mix = pillarMixOfCounts(
    pillars.map((pillar) => ({ id: pillar.id, name: pillar.name, targetShare: pillar.target_share === null ? null : Number(pillar.target_share) })),
    mixCounts.map((row) => ({ pillarId: row.pillar_id, started: Number(row.started) })),
  );
  return {
    brandId: input.brandId,
    pillars: pillars.map((pillar) => ({ id: pillar.id, name: pillar.name, targetShare: pillar.target_share === null ? null : Number(pillar.target_share) })),
    pillarMix: mix,
    cadence,
    rubrics: rubrics.map((rubric) => ({ id: rubric.id, name: rubric.name, criteria: criteriaOf(rubric.criteria) })),
    rights: rights.map((record) => {
      const validUntil = dateOf(record.valid_until);
      const revokedAt = record.revoked_at === null ? null : isoOf(record.revoked_at);
      return {
        id: record.id,
        subject: record.subject,
        holder: record.holder,
        permittedUse: record.permitted_use,
        validUntil,
        attachmentId: record.attachment_id,
        attachmentName: record.file_name,
        valid: revokedAt === null && (validUntil === null || validUntil >= now),
        revokedAt,
      };
    }),
    videos: videos.map((video) => ({ id: video.id, title: video.title, status: video.status, pillarId: video.pillar_id })),
    files: files.map((file) => ({ id: file.id, fileName: file.file_name ?? "Unnamed file", sessionTitle: file.session_title })),
  };
}

/** A unique-constraint violation, the only database error that means "already exists". Any other error is reported as it is. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export async function createPillar(sql: Sql, userId: string, input: { brandId: string; name: string; targetShare: number | null }): Promise<{ id: string }> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  // A target share is stored to two decimal places, so a finer one would be saved as a different share (0.004 as 0.00).
  if (input.targetShare !== null && Math.abs(input.targetShare * 100 - Math.round(input.targetShare * 100)) > 1e-6) {
    throw new Error("A target share has at most two decimal places.");
  }
  const id = randomUUID();
  const name = input.name.trim();
  return withTransaction(sql, async (tx) => {
    // The brand row is locked for the check and the insert, so two pillars cannot both pass the share total below.
    await tx`select id from brands where id = ${input.brandId} for update`;
    const existing = await tx<{ target_share: string | number | null }>`
      select target_share from content_pillars where brand_id = ${input.brandId} and organization_id = ${access.organizationId}
    `;
    const problem = pillarProblem(
      { name: input.name, targetShare: input.targetShare },
      existing.flatMap((row) => (row.target_share === null ? [] : [Number(row.target_share)])),
    );
    if (problem) throw new Error(problem);
    try {
      await tx`
        insert into content_pillars (id, organization_id, brand_id, name, target_share, created_by)
        values (${id}, ${access.organizationId}, ${input.brandId}, ${name}, ${input.targetShare}, ${userId})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error(`A pillar named "${name}" already exists for this brand.`);
      throw error;
    }
    await auditGovernance(tx, { organizationId: access.organizationId, brandId: input.brandId, actorId: userId, action: "content_governance.pillar_created", objectId: id, metadata: { name } });
    return { id };
  });
}

export async function deletePillar(sql: Sql, userId: string, input: { brandId: string; pillarId: string }): Promise<void> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  await withTransaction(sql, async (tx) => {
    const removed = await tx<{ id: string }>`
      delete from content_pillars where id = ${input.pillarId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId} returning id
    `;
    if (removed.length === 0) throw new Error("That pillar is not in this brand.");
    await auditGovernance(tx, { organizationId: access.organizationId, brandId: input.brandId, actorId: userId, action: "content_governance.pillar_deleted", objectId: input.pillarId, metadata: {} });
  });
}

/** Assigns a video to one of the brand's pillars, or clears the assignment. The pillar and the video must both belong to the brand. */
export async function assignPillar(sql: Sql, userId: string, input: { brandId: string; sessionId: string; pillarId: string | null }): Promise<void> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  await withTransaction(sql, async (tx) => {
    if (input.pillarId !== null) {
      const [pillar] = await tx<{ id: string }>`select id from content_pillars where id = ${input.pillarId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId} limit 1`;
      if (!pillar) throw new Error("That pillar is not in this brand.");
    }
    const updated = await tx<{ id: string }>`
      update content_factory_sessions set pillar_id = ${input.pillarId}, updated_at = now()
      where id = ${input.sessionId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId} returning id
    `;
    if (updated.length === 0) throw new Error("That video is not in this brand.");
    await auditGovernance(tx, { organizationId: access.organizationId, brandId: input.brandId, actorId: userId, action: "content_governance.video_pillar_set", objectId: input.sessionId, metadata: { pillarId: input.pillarId ?? "none" } });
  });
}

/** The brand's cadence, or unset when the brand has not chosen one. Clearing it removes the target. */
export async function setCadence(sql: Sql, userId: string, input: { brandId: string; videosPerWeek: number | null }): Promise<void> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  if (input.videosPerWeek !== null) {
    const problem = cadenceProblem(input.videosPerWeek);
    if (problem) throw new Error(problem);
  }
  await withTransaction(sql, async (tx) => {
    if (input.videosPerWeek === null) {
      await tx`delete from content_cadence where brand_id = ${input.brandId} and organization_id = ${access.organizationId}`;
    } else {
      await tx`
        insert into content_cadence (brand_id, organization_id, videos_per_week, updated_by)
        values (${input.brandId}, ${access.organizationId}, ${input.videosPerWeek}, ${userId})
        on conflict (brand_id) do update set videos_per_week = excluded.videos_per_week, updated_by = excluded.updated_by, updated_at = now()
      `;
    }
    await auditGovernance(tx, {
      organizationId: access.organizationId,
      brandId: input.brandId,
      actorId: userId,
      action: "content_governance.cadence_set",
      objectId: input.brandId,
      metadata: { videosPerWeek: input.videosPerWeek === null ? "unset" : String(input.videosPerWeek) },
    });
  });
}

export async function createRubric(sql: Sql, userId: string, input: { brandId: string; name: string; criteria: RubricCriterion[] }): Promise<{ id: string }> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  const name = input.name.trim();
  if (name.length === 0) throw new Error("Give the rubric a name.");
  const problem = criteriaProblem(input.criteria.map((criterion) => ({ name: criterion.name, weight: criterion.weight })));
  if (problem) throw new Error(problem);
  const id = randomUUID();
  const criteria = input.criteria.map((criterion) => ({ name: criterion.name.trim(), weight: criterion.weight }));
  return withTransaction(sql, async (tx) => {
    try {
      await tx`
        insert into quality_rubrics (id, organization_id, brand_id, name, criteria, created_by)
        values (${id}, ${access.organizationId}, ${input.brandId}, ${name}, ${JSON.stringify(criteria)}, ${userId})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error(`A rubric named "${name}" already exists for this brand.`);
      throw error;
    }
    await auditGovernance(tx, { organizationId: access.organizationId, brandId: input.brandId, actorId: userId, action: "content_governance.rubric_created", objectId: id, metadata: { name } });
    return { id };
  });
}

export type VideoScoreView = {
  requestId: string | null;
  delivered: boolean;
  rubrics: Array<{ id: string; name: string; criteria: RubricCriterion[] }>;
  latest: { rubricId: string; rubricName: string; total: number; scores: Record<string, number>; scoredBy: string; createdAt: string } | null;
};

/** The latest score of a session's video, with the brand's rubrics to score it against. The score belongs to the video's engine request. */
export async function videoScoreOf(sql: Sql, userId: string, input: { sessionId: string }): Promise<VideoScoreView> {
  const [session] = await sql<{ organization_id: string; brand_id: string | null; engine_request_id: string | null }>`
    select organization_id, brand_id, engine_request_id from content_factory_sessions where id = ${input.sessionId} limit 1
  `;
  if (!session || session.brand_id === null) throw new Error("That video is not found.");
  const access = await requireBrand(sql, userId, session.brand_id, "admin");
  if (access.organizationId !== session.organization_id) throw new Error("That video is not found.");
  const rubrics = await sql<{ id: string; name: string; criteria: string }>`
    select id, name, criteria from quality_rubrics where brand_id = ${session.brand_id} and organization_id = ${access.organizationId} order by name asc
  `;
  const manifestId = await deliveredManifestOf(sql, access.organizationId, session.engine_request_id);
  // A score belongs to the delivered manifest it was made on. A revised video is a new manifest, so an earlier score is not shown as its score.
  const scoreRows = manifestId === null || session.engine_request_id === null
    ? []
    : await sql<{ rubric_id: string; rubric_name: string; total: number; scores: string; scored_by: string; created_at: unknown }>`
    select s.rubric_id, r.name as rubric_name, s.total, s.scores, s.scored_by, s.created_at
    from quality_scores s join quality_rubrics r on r.id = s.rubric_id
    where s.session_id = ${input.sessionId} and s.organization_id = ${access.organizationId}
      and s.engine_request_id = ${session.engine_request_id} and s.manifest_id = ${manifestId}
    order by s.created_at desc limit 1
  `;
  const score = scoreRows[0];
  return {
    requestId: session.engine_request_id,
    delivered: manifestId !== null,
    rubrics: rubrics.map((rubric) => ({ id: rubric.id, name: rubric.name, criteria: criteriaOf(rubric.criteria) })),
    latest: score
      ? { rubricId: score.rubric_id, rubricName: score.rubric_name, total: Number(score.total), scores: JSON.parse(score.scores) as Record<string, number>, scoredBy: score.scored_by, createdAt: isoOf(score.created_at) }
      : null,
  };
}

/**
 * Scores a delivered video against one of the brand's rubrics. Only a video the engine has delivered can be scored, every criterion needs a whole
 * score from 1 to 5, and the score is appended: a later score adds to the history and does not replace this one.
 */
export async function scoreVideo(sql: Sql, userId: string, input: { sessionId: string; rubricId: string; scores: Record<string, number> }): Promise<VideoScoreView> {
  const [session] = await sql<{ organization_id: string; brand_id: string | null; engine_request_id: string | null }>`
    select organization_id, brand_id, engine_request_id from content_factory_sessions where id = ${input.sessionId} limit 1
  `;
  if (!session || session.brand_id === null) throw new Error("That video is not found.");
  const brandId = session.brand_id;
  const access = await requireBrand(sql, userId, brandId, "admin");
  if (access.organizationId !== session.organization_id) throw new Error("That video is not found.");
  const manifestId = await deliveredManifestOf(sql, access.organizationId, session.engine_request_id);
  if (manifestId === null || session.engine_request_id === null) {
    throw new Error("The engine has not delivered this video yet, so there is nothing to score.");
  }
  const [rubric] = await sql<{ id: string; criteria: string }>`
    select id, criteria from quality_rubrics where id = ${input.rubricId} and brand_id = ${brandId} and organization_id = ${access.organizationId} limit 1
  `;
  if (!rubric) throw new Error("That rubric is not in this brand.");
  const criteria = criteriaOf(rubric.criteria);
  const problem = scoresProblem(criteria, input.scores);
  if (problem) throw new Error(problem);
  const total = weightedTotal(criteria, input.scores);
  const requestId = session.engine_request_id;
  await withTransaction(sql, async (tx) => {
    await tx`
      insert into quality_scores (id, organization_id, brand_id, session_id, engine_request_id, manifest_id, rubric_id, scores, total, scored_by)
      values (${randomUUID()}, ${access.organizationId}, ${brandId}, ${input.sessionId}, ${requestId}, ${manifestId}, ${rubric.id}, ${JSON.stringify(input.scores)}, ${total}, ${userId})
    `;
    await auditGovernance(tx, {
      organizationId: access.organizationId,
      brandId,
      actorId: userId,
      action: "content_governance.video_scored",
      objectId: input.sessionId,
      metadata: { engineRequestId: requestId, manifestId, total: String(total) },
    });
  });
  return videoScoreOf(sql, userId, { sessionId: input.sessionId });
}

export async function createRightsRecord(
  sql: Sql,
  userId: string,
  input: { brandId: string; subject: string; holder: string; permittedUse: string; validUntil: string | null; attachmentId: string | null },
): Promise<{ id: string }> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  const problem = rightsProblem({ subject: input.subject, holder: input.holder, permittedUse: input.permittedUse, validUntil: input.validUntil }, today());
  if (problem) throw new Error(problem);
  if (input.attachmentId !== null) {
    const [file] = await sql<{ id: string }>`
      select a.id from content_factory_attachments a join content_factory_sessions s on s.id = a.session_id
      where a.id = ${input.attachmentId} and a.kind = 'file' and s.brand_id = ${input.brandId} and a.organization_id = ${access.organizationId} limit 1
    `;
    if (!file) throw new Error("That file is not stored for this brand.");
  }
  const id = randomUUID();
  await withTransaction(sql, async (tx) => {
    await tx`
      insert into rights_records (id, organization_id, brand_id, subject, holder, permitted_use, valid_until, attachment_id, created_by)
      values (${id}, ${access.organizationId}, ${input.brandId}, ${input.subject.trim()}, ${input.holder.trim()}, ${input.permittedUse.trim()}, ${input.validUntil}, ${input.attachmentId}, ${userId})
    `;
    await auditGovernance(tx, { organizationId: access.organizationId, brandId: input.brandId, actorId: userId, action: "content_governance.rights_recorded", objectId: id, metadata: { attachment: input.attachmentId ?? "none" } });
  });
  return { id };
}

/** Revokes a rights record. The record stays on file, so an earlier approval can still show which record it relied on. */
export async function revokeRightsRecord(sql: Sql, userId: string, input: { brandId: string; recordId: string }): Promise<void> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  await withTransaction(sql, async (tx) => {
    const revoked = await tx<{ id: string }>`
      update rights_records set revoked_at = now(), revoked_by = ${userId}
      where id = ${input.recordId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId} and revoked_at is null
      returning id
    `;
    if (revoked.length === 0) throw new Error("That rights record is not in this brand, or it is already revoked.");
    await auditGovernance(tx, { organizationId: access.organizationId, brandId: input.brandId, actorId: userId, action: "content_governance.rights_revoked", objectId: input.recordId, metadata: {} });
  });
}
