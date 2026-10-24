// What a brand has already decided about an idea, so a refresh does not put it back in front of the person as new (portfolio triage).
// An idea is identified by its fingerprint: the hypothesis, the product, the angle and the format. The same fingerprint from a later refresh
// is the same idea. Three outcomes keep an idea out of the open list:
//   - declined: a person declined the idea (a decline decision, with the reason they gave, when one exists);
//   - held: a person saved, deferred or sent the idea for more research. It is set aside on purpose, and reopen returns it;
//   - explored: the idea was accepted or already briefed. It has been pursued, so it is not new.
// A refresh that matches a prior idea writes nothing for it, and counts it as suppressed, so the count shows what was kept out. Ideas that
// differ in any part of the fingerprint are new. A product that was deleted changes the fingerprint, so its ideas can return: that is stated,
// not hidden.

export type IdeaFingerprint = { hypothesisId: string; productId: string | null; angle: string; format: string };

export type PriorIdea = IdeaFingerprint & {
  opportunityId: string;
  label: string;
  outcome: "declined" | "held" | "explored";
  /** The reason a person gave when they declined or held it. Null when no reason was recorded (an older decision) or when it was explored. */
  reason: string | null;
  decidedAt: string | null;
};

export function fingerprintKey(idea: IdeaFingerprint): string {
  return [idea.hypothesisId, idea.productId ?? "", idea.angle, idea.format].join("|");
}

/**
 * The prior idea an incoming draft matches, or null. When several prior rows share the fingerprint, an explored one wins (it was pursued),
 * then a held one (a person meant to come back to it), then the newest decision.
 */
export function priorIdeasByFingerprint(prior: readonly PriorIdea[]): Map<string, PriorIdea> {
  const byKey = new Map<string, PriorIdea>();
  for (const idea of prior) {
    const key = fingerprintKey(idea);
    const current = byKey.get(key);
    if (current === undefined || preferred(idea, current) === idea) byKey.set(key, idea);
  }
  return byKey;
}

const OUTCOME_RANK: Record<PriorIdea["outcome"], number> = { explored: 2, held: 1, declined: 0 };

function preferred(a: PriorIdea, b: PriorIdea): PriorIdea {
  if (a.outcome !== b.outcome) return OUTCOME_RANK[a.outcome] > OUTCOME_RANK[b.outcome] ? a : b;
  return (a.decidedAt ?? "") >= (b.decidedAt ?? "") ? a : b;
}

export function priorIdeaFor(draft: IdeaFingerprint, byKey: ReadonlyMap<string, PriorIdea>): PriorIdea | null {
  return byKey.get(fingerprintKey(draft)) ?? null;
}
