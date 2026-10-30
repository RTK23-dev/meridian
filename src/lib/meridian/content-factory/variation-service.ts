// Video variations: one reusable source draft becomes N original draft videos in one bounded batch. The source draft is only read. Each new
// draft copies the source's plain instructions and attachments (the reference file is shared by its storage record; no bytes are copied),
// gets one fixed angle instruction and its exact share of the budget, and joins one new batch. Nothing here starts a video, queues the
// engine or reaches a provider: a person starts the batch after reading the list. Admins of the brand's workspace only.

import { randomUUID } from "node:crypto";
import { requireBrand } from "../brand-membership.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { SESSION_REFUSAL, sessionAccess } from "./service.ts";
import { getBatch, type BatchSummary } from "./batch-service.ts";
import { angleInstruction, sourceProblem, splitBudget, VARIATION_ANGLES, type VariationAngle } from "./variations.ts";
import { formatFromPatterns, researchAngles, type FormatOutcome, type StoredPattern } from "./research-format.ts";

const TITLE_MAX = 120;
/** A request that repeats an identical one within this many seconds returns that batch instead of making another. */
const REPLAY_WINDOW_SECONDS = 20;

type SourceMessage = { id: string; text: string; beat_role: string | null };
type SourceAttachment = {
  id: string;
  message_id: string;
  kind: string;
  purpose: string | null;
  file_name: string | null;
  storage_object_id: string | null;
  storage_key: string | null;
  media_type: string | null;
  byte_size: string | number | null;
  sha256: string | null;
  source_page: string | null;
  source_brand_id: string | null;
  source_record_id: string | null;
  snapshot: string | null;
  content: string | null;
};

/** A brand's stored research patterns, read by brand and workspace. Nothing else is read. */
async function brandPatterns(sql: Sql, organizationId: string, brandId: string): Promise<StoredPattern[]> {
  const rows = await sql<{ dimension: string; value: string; sample_count: number; corpus_size: number; prevalence: number; confidence: number }>`
    select dimension, value, sample_count, corpus_size, prevalence, confidence from research_patterns
    where organization_id = ${organizationId} and brand_id = ${brandId} and scope = 'brand' and state in ('INFERRED', 'VALIDATED')
  `;
  return rows.map((row) => ({ dimension: row.dimension, value: row.value, sampleCount: Number(row.sample_count), corpusSize: Number(row.corpus_size), prevalence: Number(row.prevalence), confidence: Number(row.confidence) }));
}

/** The format found in the brand's research, or why there is none. Admins of the brand's workspace only. */
export async function researchFormatOf(sql: Sql, userId: string, input: { brandId: string }): Promise<FormatOutcome> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  return formatFromPatterns(await brandPatterns(sql, access.organizationId, input.brandId));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

async function audit(sql: Sql, entry: { organizationId: string; brandId: string; actorId: string; action: string; objectType: string; objectId: string; metadata: Record<string, string> }): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${entry.organizationId}, ${entry.brandId}, ${entry.actorId}, ${entry.action}, ${entry.objectType}, ${entry.objectId}, ${JSON.stringify(entry.metadata)})
  `;
}

/**
 * Makes `count` draft videos from the source draft and groups them into one batch with `totalBudgetUsd` split exactly in cents. The source is
 * checked first and again under its row lock; a refusal writes nothing. Every new draft is a copy by value of the source's instructions and
 * attachments, so changing a variation never changes the source or its siblings.
 */
export async function createVariations(
  sql: Sql,
  userId: string,
  input: { sourceSessionId: string; count: number; totalBudgetUsd: number; title?: string; useResearchFormat?: boolean },
): Promise<BatchSummary> {
  const split = splitBudget(input.totalBudgetUsd, input.count);
  if (!split.ok) throw new Error(split.reason);
  const source = await sessionAccess(sql, userId, input.sourceSessionId);
  if (source.source_session_id !== null) throw new Error("Choose the original reusable draft, not a video variation, as the source.");
  if (source.brand_id === null) throw new Error("The source draft has no brand, so variations cannot be made from it.");
  const access = await requireBrand(sql, userId, source.brand_id, "admin");
  if (access.organizationId !== source.organization_id) throw new Error(SESSION_REFUSAL);
  const brandId = source.brand_id;
  const organizationId = source.organization_id;
  let batchId: string = randomUUID();

  await withTransaction(sql, async (tx) => {
    // The source is locked for the rest of the transaction, so a start or an edit cannot land between the check and the copies.
    const [locked] = await tx<{ status: string; brand_id: string | null; source_session_id: string | null; title: string; max_seconds: number | null; language: string | null; priority: string | null; keep_genes: string }>`
      select status, brand_id, source_session_id, title, max_seconds, language, priority, keep_genes
      from content_factory_sessions where id = ${source.id} and organization_id = ${organizationId} for update
    `;
    if (!locked) throw new Error(SESSION_REFUSAL);
    if (locked.source_session_id !== null) throw new Error("Choose the original reusable draft, not a video variation, as the source.");
    if (locked.brand_id === null) throw new Error("The source draft has no brand, so variations cannot be made from it.");
    if (locked.brand_id !== brandId) throw new Error("The source brand changed. Reload the page and try again.");
    const lockedAccess = await requireBrand(tx, userId, locked.brand_id, "admin");
    if (lockedAccess.organizationId !== organizationId) throw new Error(SESSION_REFUSAL);
    const messages = await tx<SourceMessage>`
      select id, text, beat_role from content_factory_messages where session_id = ${source.id} and organization_id = ${organizationId} order by created_at asc, id asc
    `;
    const attachments = await tx<SourceAttachment>`
      select id, message_id, kind, purpose, file_name, storage_object_id, storage_key, media_type, byte_size, sha256, source_page, source_brand_id, source_record_id, snapshot, content
      from content_factory_attachments where session_id = ${source.id} and organization_id = ${organizationId} order by created_at asc, id asc
    `;
    const problem = sourceProblem({
      status: locked.status,
      brandId: locked.brand_id,
      hasReferenceVideo: attachments.some((item) =>
        item.kind === "file" &&
        item.purpose === "reference_video" &&
        (item.media_type === "video/mp4" || item.media_type === "video/quicktime" || item.media_type === "video/webm") &&
        typeof item.storage_key === "string" &&
        item.storage_key.trim().length > 0,
      ),
      marketAttachments: attachments.filter(
        (item) => item.kind === "source" && item.source_page === "market" && typeof item.snapshot === "string" && item.snapshot.trim().length > 0,
      ).length,
      instructions: messages.filter((item) => item.beat_role === null).map((item) => item.text),
      scriptLines: messages.filter((item) => item.beat_role !== null).length,
    });
    if (problem !== null) throw new Error(problem);
    if (attachments.some((item) => item.kind === "source" && item.source_brand_id !== locked.brand_id)) {
      throw new Error("All attached source records must belong to this brand before the draft can be reused.");
    }

    // A repeated request (a double click, a replay) must not make a second batch. The source row is locked, so the second request waits for the
    // first, then finds its batch: the same person, the same count and total, made from this source moments ago.
    const totalCents = split.cents.reduce((sum, cents) => sum + cents, 0);
    const [recent] = await tx<{ id: string }>`
      select b.id
      from content_factory_batches b
      where b.organization_id = ${organizationId} and b.brand_id = ${brandId} and b.created_by = ${userId}
        and b.created_at > now() - (${REPLAY_WINDOW_SECONDS} * interval '1 second')
        and round(b.budget_usd * 100) = ${totalCents}
        and (select count(*) from content_factory_batch_items i where i.batch_id = b.id) = ${input.count}
        and not exists (
          select 1 from content_factory_batch_items i join content_factory_sessions s on s.id = i.session_id
          where i.batch_id = b.id and s.source_session_id is distinct from ${source.id}
        )
        and (exists (
          select 1 from content_factory_batch_items i join content_factory_sessions s on s.id = i.session_id
          where i.batch_id = b.id and left(s.variation_angle, 4) = 'res_'
        )) = ${input.useResearchFormat === true}
      order by b.created_at desc limit 1
    `;
    if (recent) {
      batchId = recent.id;
      return;
    }

    // Angles: the brand's research format when asked for, then the fixed angles for any that remain. Asking for the research format when there
    // is none is refused with the reason; it never falls back to the fixed angles without saying so.
    let fromResearch: VariationAngle[] = [];
    if (input.useResearchFormat) {
      const outcome = formatFromPatterns(await brandPatterns(tx, organizationId, brandId));
      if (!outcome.ok) throw new Error(outcome.reason);
      fromResearch = researchAngles(outcome.format, input.count);
    }
    const fixed = VARIATION_ANGLES.filter((angle) => !fromResearch.some((found) => found.id === angle.id));
    const angles: VariationAngle[] = [...fromResearch, ...fixed].slice(0, input.count);

    const title = clip((input.title ?? "").trim() || `${locked.title}: ${input.count} variations`, TITLE_MAX);
    const totalUsd = split.cents.reduce((sum, cents) => sum + cents, 0) / 100;
    await tx`
      insert into content_factory_batches (id, organization_id, brand_id, title, budget_usd, created_by)
      values (${batchId}, ${organizationId}, ${brandId}, ${title}, ${totalUsd}, ${userId})
    `;

    for (let index = 0; index < input.count; index += 1) {
      const angle = angles[index];
      const cents = split.cents[index];
      if (!angle || cents === undefined) throw new Error("The variations could not be planned.");
      const sessionId = randomUUID();
      await tx`
        insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, budget_usd, max_seconds, language, priority, keep_genes, source_session_id, variation_angle)
        values (${sessionId}, ${organizationId}, ${brandId}, ${userId}, ${clip(`${locked.title}: ${angle.label}`, TITLE_MAX)}, ${cents / 100}, ${locked.max_seconds}, ${locked.language}, ${locked.priority}, ${locked.keep_genes}, ${source.id}, ${angle.id})
      `;
      const messageIds = new Map<string, string>();
      for (const message of messages) {
        const copyId = randomUUID();
        messageIds.set(message.id, copyId);
        await tx`
          insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role)
          values (${copyId}, ${organizationId}, ${sessionId}, ${userId}, ${message.text}, ${null})
        `;
      }
      await tx`
        insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role)
        values (${randomUUID()}, ${organizationId}, ${sessionId}, ${userId}, ${angleInstruction(angle)}, ${null})
      `;
      for (const item of attachments) {
        const messageId = messageIds.get(item.message_id);
        if (!messageId) throw new Error("A source attachment has no message to copy it onto.");
        await tx`
          insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, purpose, file_name, storage_object_id, storage_key, media_type, byte_size, sha256, source_page, source_brand_id, source_record_id, snapshot, content)
          values (${randomUUID()}, ${organizationId}, ${sessionId}, ${messageId}, ${item.kind}, ${item.purpose}, ${item.file_name}, ${item.storage_object_id}, ${item.storage_key}, ${item.media_type}, ${item.byte_size}, ${item.sha256}, ${item.source_page}, ${item.source_brand_id}, ${item.source_record_id}, ${item.snapshot}, ${item.content})
        `;
      }
      await tx`
        insert into content_factory_batch_items (id, organization_id, batch_id, session_id, position)
        values (${randomUUID()}, ${organizationId}, ${batchId}, ${sessionId}, ${index})
      `;
      await audit(tx, { organizationId, brandId, actorId: userId, action: "content_factory.variation_created", objectType: "content_factory_session", objectId: sessionId, metadata: { sourceSessionId: source.id, angle: angle.id } });
    }
    await audit(tx, {
      organizationId,
      brandId,
      actorId: userId,
      action: "content_factory.variations_batch_created",
      objectType: "content_factory_batch",
      objectId: batchId,
      metadata: { sourceSessionId: source.id, itemCount: String(input.count), budgetUsd: totalUsd.toFixed(2), researchAngles: String(fromResearch.length) },
    });
  });
  return getBatch(sql, userId, { batchId });
}

export type VariationSource = { id: string; title: string; problem: string | null };

/**
 * The brand's draft sessions that variations could be made from, each with the first reason it cannot be, or null when it can. Derived
 * variations are not listed (a variation is never a template). Admins of the brand's workspace only. Read-only.
 */
export async function variationSourcesOf(sql: Sql, userId: string, input: { brandId: string }): Promise<VariationSource[]> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  const drafts = await sql<{ id: string; title: string; status: string }>`
    select id, title, status from content_factory_sessions
    where organization_id = ${access.organizationId} and brand_id = ${input.brandId} and source_session_id is null and status = 'draft'
    order by updated_at desc, id desc limit 200
  `;
  if (drafts.length === 0) return [];
  const attachments = await sql<{ session_id: string; reference: number; market: number }>`
    select a.session_id,
      count(*) filter (where a.kind = 'file' and a.purpose = 'reference_video')::int as reference,
      count(*) filter (where a.kind = 'source' and a.source_page = 'market')::int as market
    from content_factory_attachments a join content_factory_sessions s on s.id = a.session_id
    where s.organization_id = ${access.organizationId} and s.brand_id = ${input.brandId} and s.source_session_id is null and s.status = 'draft'
    group by a.session_id
  `;
  const messages = await sql<{ session_id: string; text: string; beat_role: string | null }>`
    select m.session_id, m.text, m.beat_role from content_factory_messages m join content_factory_sessions s on s.id = m.session_id
    where s.organization_id = ${access.organizationId} and s.brand_id = ${input.brandId} and s.source_session_id is null and s.status = 'draft'
  `;
  return drafts.map((draft) => {
    const counts = attachments.find((row) => row.session_id === draft.id);
    const own = messages.filter((row) => row.session_id === draft.id);
    const problem = sourceProblem({
      status: draft.status,
      brandId: input.brandId,
      hasReferenceVideo: (counts?.reference ?? 0) > 0,
      marketAttachments: counts?.market ?? 0,
      instructions: own.filter((row) => row.beat_role === null).map((row) => row.text),
      scriptLines: own.filter((row) => row.beat_role !== null).length,
    });
    return { id: draft.id, title: draft.title, problem };
  });
}
