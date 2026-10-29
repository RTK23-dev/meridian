// The batches of Content Factory videos (prompt 15): a batch of draft videos is made, started under its budget, and read back with each
// item's state. A retry is for one failed item and touches that item only. Admins of the brand's workspace only. Every start and every retry
// is the engine's own start (service.ts), so each video is checked and reserved as a single video is. The state of each item is read from
// the engine's status (batch.ts), never assumed.

import { randomUUID } from "node:crypto";
import { engineRequestStatus } from "../../../engine/api/index.ts";
import { requireBrand } from "../brand-membership.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { reviseSession, startRun } from "./service.ts";
import { committedUsd, fitsBatchBudget, itemStateOf, MAX_BATCH_ITEMS, type BatchItemState } from "./batch.ts";

const TITLE_MAX = 120;
const BUDGET_MAX_USD = 100_000;
const STOPPED_NOTE = "The batch stopped at an earlier video, so this one was not started.";

type StartPorts = Parameters<typeof startRun>[3];

export type BatchItemSummary = {
  sessionId: string;
  title: string;
  position: number;
  budgetUsd: number | null;
  state: BatchItemState;
  reason: string;
  retryable: boolean;
  attempts: number;
  /** Whether the video is still a draft. Only a draft is started by a batch start. */
  draft: boolean;
};

export type BatchSummary = {
  id: string;
  brandId: string;
  title: string;
  budgetUsd: number;
  /** The budgets of the items the engine has taken. Never more than the batch budget. */
  committedUsd: number;
  items: BatchItemSummary[];
};

export type BatchStartOutcome = { started: number; refused: number; stoppedAtBudget: boolean; batch: BatchSummary };

type BatchRow = { id: string; organization_id: string; brand_id: string; title: string; budget_usd: string | number };

type ItemRow = {
  session_id: string;
  position: number;
  title: string;
  session_status: string;
  revision: number;
  last_refusal: unknown;
  budget_usd: string | number | null;
  engine_request_id: string | null;
};

function refusalsOf(value: unknown): string[] {
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

function budgetOf(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

async function loadBatch(sql: Sql, batchId: string): Promise<{ batch: BatchRow; items: ItemRow[] }> {
  const batches = await sql<BatchRow>`
    select id, organization_id, brand_id, title, budget_usd from content_factory_batches where id = ${batchId} limit 1
  `;
  const batch = batches[0];
  if (!batch) throw new Error("That batch is not found.");
  const items = await sql<ItemRow>`
    select i.session_id, i.position, s.title, s.status as session_status, s.revision, s.last_refusal, s.budget_usd, s.engine_request_id
    from content_factory_batch_items i
    join content_factory_sessions s on s.id = i.session_id
    where i.batch_id = ${batchId}
    order by i.position asc
  `;
  return { batch, items };
}

function spendOf(item: ItemRow): { started: boolean; budgetUsd: number | null } {
  return { started: item.session_status === "started", budgetUsd: budgetOf(item.budget_usd) };
}

async function summarize(sql: Sql, batch: BatchRow, items: ItemRow[]): Promise<BatchSummary> {
  const views = await Promise.all(items.map(async (item) => {
    const engine = item.session_status === "started" && item.engine_request_id !== null
      ? await engineRequestStatus(sql, batch.organization_id, item.engine_request_id)
      : null;
    const view = itemStateOf({ sessionStatus: item.session_status, revision: Number(item.revision), lastRefusal: refusalsOf(item.last_refusal), engine });
    return {
      sessionId: item.session_id,
      title: item.title,
      position: item.position,
      budgetUsd: budgetOf(item.budget_usd),
      state: view.state,
      reason: view.reason,
      retryable: view.retryable,
      attempts: view.attempts,
      draft: item.session_status === "draft",
    };
  }));
  return {
    id: batch.id,
    brandId: batch.brand_id,
    title: batch.title,
    budgetUsd: Number(batch.budget_usd),
    committedUsd: committedUsd(items.map(spendOf)),
    items: views,
  };
}

async function auditBatch(sql: Sql, entry: { organizationId: string; brandId: string; actorId: string; action: string; objectId: string; metadata: Record<string, string> }): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${entry.organizationId}, ${entry.brandId}, ${entry.actorId}, ${entry.action}, 'content_factory_batch', ${entry.objectId}, ${JSON.stringify(entry.metadata)})
  `;
}

async function setRefusal(sql: Sql, sessionId: string, reasons: string[]): Promise<void> {
  await sql`update content_factory_sessions set last_refusal = ${JSON.stringify(reasons)}, updated_at = now() where id = ${sessionId}`;
}

/** A batch with its items and their states, read from the engine. Admins of the brand's workspace only. */
export async function getBatch(sql: Sql, userId: string, input: { batchId: string }): Promise<BatchSummary> {
  const { batch, items } = await loadBatch(sql, input.batchId);
  await requireBrand(sql, userId, batch.brand_id, "admin");
  return summarize(sql, batch, items);
}

/** The batches of a brand, newest first. Admins of the brand's workspace only. */
export async function listBatches(sql: Sql, userId: string, input: { brandId: string }): Promise<Array<{ id: string; title: string; budgetUsd: number; itemCount: number; createdAt: string }>> {
  await requireBrand(sql, userId, input.brandId, "admin");
  const rows = await sql<{ id: string; title: string; budget_usd: string | number; item_count: number; created_at: unknown }>`
    select b.id, b.title, b.budget_usd, b.created_at, count(i.id)::int as item_count
    from content_factory_batches b
    left join content_factory_batch_items i on i.batch_id = b.id
    where b.brand_id = ${input.brandId}
    group by b.id
    order by b.created_at desc
    limit 50
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    budgetUsd: Number(row.budget_usd),
    itemCount: Number(row.item_count),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

/**
 * Makes a batch of draft videos of one brand, under one budget. A video joins one batch only, and only while it is a draft.
 */
export async function createBatch(sql: Sql, userId: string, input: { brandId: string; title: string; budgetUsd: number; sessionIds: string[] }): Promise<BatchSummary> {
  const access = await requireBrand(sql, userId, input.brandId, "admin");
  const title = input.title.trim();
  if (title.length === 0) throw new Error("Give the batch a name.");
  if (title.length > TITLE_MAX) throw new Error(`The name is longer than ${TITLE_MAX} characters.`);
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0 || input.budgetUsd > BUDGET_MAX_USD) {
    throw new Error(`The batch budget must be a positive amount in dollars, up to ${BUDGET_MAX_USD.toLocaleString("en-US")}.`);
  }
  const sessionIds = [...new Set(input.sessionIds)];
  if (sessionIds.length === 0) throw new Error("Choose at least one draft video for the batch.");
  if (sessionIds.length > MAX_BATCH_ITEMS) throw new Error(`A batch holds at most ${MAX_BATCH_ITEMS} videos.`);
  const id = randomUUID();
  await withTransaction(sql, async (tx) => {
    for (const sessionId of sessionIds) {
      const [row] = await tx<{ organization_id: string; brand_id: string | null; status: string }>`
        select organization_id, brand_id, status from content_factory_sessions where id = ${sessionId} limit 1 for update
      `;
      if (!row || row.organization_id !== access.organizationId || row.brand_id !== input.brandId) {
        throw new Error("A video is not in this brand, so it cannot join the batch.");
      }
      if (row.status !== "draft") throw new Error("Only a draft video can join a batch. A video that has started is already in production.");
      const [taken] = await tx<{ batch_id: string }>`select batch_id from content_factory_batch_items where session_id = ${sessionId} limit 1`;
      if (taken) throw new Error("A video can belong to one batch only.");
      // A draft that variations were made from is a reusable template. It stays out of every batch so it can be reused.
      const [template] = await tx<{ id: string }>`
        select id from content_factory_sessions where organization_id = ${access.organizationId} and source_session_id = ${sessionId} limit 1
      `;
      if (template) throw new Error("This draft is the template other videos were made from. It stays out of batches so it can be used again.");
    }
    await tx`
      insert into content_factory_batches (id, organization_id, brand_id, title, budget_usd, created_by)
      values (${id}, ${access.organizationId}, ${input.brandId}, ${title}, ${input.budgetUsd}, ${userId})
    `;
    for (const [position, sessionId] of sessionIds.entries()) {
      await tx`
        insert into content_factory_batch_items (id, organization_id, batch_id, session_id, position)
        values (${randomUUID()}, ${access.organizationId}, ${id}, ${sessionId}, ${position})
      `;
    }
    await auditBatch(tx, {
      organizationId: access.organizationId,
      brandId: input.brandId,
      actorId: userId,
      action: "content_factory.batch_created",
      objectId: id,
      metadata: { itemCount: String(sessionIds.length), budgetUsd: String(input.budgetUsd) },
    });
  });
  return getBatch(sql, userId, { batchId: id });
}


/**
 * Takes the batch row's lock for the rest of the transaction. Every start and retry of a batch runs under it, so two requests cannot each
 * read the same committed spend and both spend the same budget (security review, finding 5).
 */
async function lockBatch(tx: Sql, batchId: string): Promise<void> {
  await tx`select id from content_factory_batches where id = ${batchId} for update`;
}

/**
 * Starts the batch's draft items in order, each under the batch budget. A start the engine refuses is stored on its item and the batch goes
 * on with the rest. A start that would take the committed spend past the budget stops the batch: that video and the ones after it stay
 * draft, with the reason, and nothing more is started. The whole start is one transaction under the batch lock, so a start that fails
 * part way leaves no half-started batch behind.
 */
export async function startBatch(sql: Sql, userId: string, input: { batchId: string }, ports?: StartPorts): Promise<BatchStartOutcome> {
  const { batch } = await loadBatch(sql, input.batchId);
  await requireBrand(sql, userId, batch.brand_id, "admin");
  return withTransaction(sql, async (tx) => {
    await lockBatch(tx, input.batchId);
    return startBatchLocked(tx, userId, input, ports);
  });
}

async function startBatchLocked(sql: Sql, userId: string, input: { batchId: string }, ports?: StartPorts): Promise<BatchStartOutcome> {
  const { batch, items } = await loadBatch(sql, input.batchId);
  await requireBrand(sql, userId, batch.brand_id, "admin");
  const budget = Number(batch.budget_usd);
  let committed = committedUsd(items.map(spendOf));
  let started = 0;
  let refused = 0;
  let stopped = false;
  for (const item of items) {
    if (item.session_status !== "draft") continue;
    if (stopped) {
      await setRefusal(sql, item.session_id, [STOPPED_NOTE]);
      continue;
    }
    const fit = fitsBatchBudget({ batchBudgetUsd: budget, committedUsd: committed, itemBudgetUsd: budgetOf(item.budget_usd) });
    if (!fit.ok) {
      const reason = fit.overBudget ? `${fit.reason} The batch stopped here, so this video and the ones after it were not started.` : fit.reason;
      await setRefusal(sql, item.session_id, [reason]);
      refused += 1;
      if (fit.overBudget) stopped = true;
      continue;
    }
    const outcome = await startRun(sql, userId, { sessionId: item.session_id }, ports);
    if (outcome.status === "started") {
      started += 1;
      committed += budgetOf(item.budget_usd) ?? 0;
    } else {
      refused += 1;
    }
  }
  await auditBatch(sql, {
    organizationId: batch.organization_id,
    brandId: batch.brand_id,
    actorId: userId,
    action: "content_factory.batch_started",
    objectId: batch.id,
    metadata: { started: String(started), refused: String(refused), stoppedAtBudget: String(stopped) },
  });
  return { started, refused, stoppedAtBudget: stopped, batch: await getBatch(sql, userId, { batchId: batch.id }) };
}

/**
 * Retries one failed item of a batch. Only a failed item with attempts left can be retried. The retry is refused when it would take the
 * committed spend past the budget; the failed attempt's budget is still counted, so the check is conservative. Its siblings are not changed.
 */
export async function retryBatchItem(sql: Sql, userId: string, input: { batchId: string; sessionId: string }, ports?: StartPorts): Promise<BatchSummary> {
  const { batch, items } = await loadBatch(sql, input.batchId);
  await requireBrand(sql, userId, batch.brand_id, "admin");
  const item = items.find((candidate) => candidate.session_id === input.sessionId);
  if (!item) throw new Error("That video is not in this batch.");
  const current = (await summarize(sql, batch, items)).items.find((candidate) => candidate.sessionId === input.sessionId);
  if (!current?.retryable) throw new Error(`Only a failed video with attempts left can be retried. This one is ${current?.state ?? "unknown"}.`);
  const fit = fitsBatchBudget({ batchBudgetUsd: Number(batch.budget_usd), committedUsd: committedUsd(items.map(spendOf)), itemBudgetUsd: budgetOf(item.budget_usd) });
  if (!fit.ok) throw new Error(fit.reason);
  // The revision changes the video's state, not the committed spend, and it runs its own transaction, so it is made before the batch lock.
  const revised = await reviseSession(sql, userId, { sessionId: input.sessionId });
  if (revised.status === "refused") throw new Error(revised.reason);
  // The start is what spends. The committed spend is read again under the batch lock, and the start runs in the same transaction.
  return withTransaction(sql, async (tx) => {
    await lockBatch(tx, input.batchId);
    const locked = await loadBatch(tx, input.batchId);
    const lockedFit = fitsBatchBudget({
      batchBudgetUsd: Number(locked.batch.budget_usd),
      committedUsd: committedUsd(locked.items.map(spendOf)),
      itemBudgetUsd: budgetOf(item.budget_usd),
    });
    if (!lockedFit.ok) throw new Error(lockedFit.reason);
    // A refused start is stored on the item by startRun, so the item shows why it is not running.
    await startRun(tx, userId, { sessionId: input.sessionId }, ports);
    await auditBatch(tx, {
      organizationId: batch.organization_id,
      brandId: batch.brand_id,
      actorId: userId,
      action: "content_factory.item_retried",
      objectId: input.sessionId,
      metadata: { batchId: batch.id, attempt: String(current.attempts + 1) },
    });
    return getBatch(tx, userId, { batchId: batch.id });
  });
}
