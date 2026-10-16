// Writes learning events (Video Engine Bible 16.1 and 16.2). Each event is validated against its schema before it reaches the
// store, so a malformed event is refused and nothing is stored. A dedupe key that is already stored changes nothing, so a
// retried job emits its events once. The stage that owns an event calls emit; the store decides where the row goes.

import { EngineError } from "../contracts/index.ts";
import { learningEventSchema, type LearningEvent } from "./schema.ts";
import type { EventStore } from "./store.ts";

export type EventScope = { organizationId: string; requestId: string };

export type EmitMeta = {
  /** ISO time of the event (the clock of the caller, so tests and replays choose it). */
  at: string;
  /** The job that emitted it, when a job did. */
  jobId?: string;
};

export type EmitOutcome = { created: number; duplicate: number };

/** Validates one event and appends it. A body that does not match its contract is refused as invalid_input, before any write. */
export async function emitLearningEvent(store: EventStore, scope: EventScope, event: LearningEvent, meta: EmitMeta): Promise<{ created: boolean }> {
  const parsed = learningEventSchema.safeParse(event);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError(
      "invalid_input",
      `learning event ${String(event.kind)} is not valid: ${issue ? issue.path.join(".") || "value" : "unknown"} ${issue?.message ?? ""}`.trim(),
      { stage: event.stage },
    );
  }
  if (!Number.isFinite(Date.parse(meta.at))) {
    throw new EngineError("invalid_input", "a learning event needs an ISO time", { stage: parsed.data.stage });
  }
  return store.append({
    organizationId: scope.organizationId,
    requestId: scope.requestId,
    kind: parsed.data.kind,
    stage: parsed.data.stage,
    subjectId: parsed.data.subjectId,
    jobId: meta.jobId ?? "",
    dedupeKey: parsed.data.dedupeKey,
    body: parsed.data.body,
    at: meta.at,
  });
}

/** Emits events in order. Each one is validated first; the first refusal stops the batch and throws. */
export async function emitLearningEvents(store: EventStore, scope: EventScope, events: readonly LearningEvent[], meta: EmitMeta): Promise<EmitOutcome> {
  let created = 0;
  let duplicate = 0;
  for (const event of events) {
    const outcome = await emitLearningEvent(store, scope, event, meta);
    if (outcome.created) created += 1;
    else duplicate += 1;
  }
  return { created, duplicate };
}
