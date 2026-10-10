import { useState } from "react";
import { Button, Panel, TextArea } from "@/components/ui";
import { Term } from "@/components/term";
import { alternativeDirections, directionSourceLabel, type DirectionCandidate } from "./direction.ts";
import { decisionPlainLabel, formatUnitInterval } from "./evidence.ts";
import type { StudioData } from "./types.ts";

/** The shortest reason that can accept a direction. The server enforces the same length. */
export const DIRECTION_REASON_MIN = 20;

/**
 * The required reason for accepting a direction. It is recorded with the decision, who made it and when. It does not mean
 * the brief has passed its gate: the brief is judged separately when it is written.
 */
export function DirectionReasonField({ value, onChange, id }: { value: string; onChange: (value: string) => void; id: string }) {
  return (
    <label htmlFor={id} className="block text-sm">
      <span className="text-fg-muted">
        Why accept this direction (at least {DIRECTION_REASON_MIN} characters). This is recorded with your decision. It does not
        mean the brief has passed its gate.
      </span>
      <TextArea id={id} className="mt-1" rows={2} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

type DirectionStepProps = {
  session: StudioData;
  canEdit: boolean;
  pending: boolean;
  opportunities: readonly DirectionCandidate[] | undefined;
  opportunitiesFailed: boolean;
  onAccept: (reason: string) => Promise<unknown>;
};

/** Step 1. The recommended direction, the alternatives the stored opportunities show, and the accept action. */
export function DirectionStep({ session, canEdit, pending, opportunities, opportunitiesFailed, onAccept }: DirectionStepProps) {
  const [reason, setReason] = useState("");
  const recommendation = session.recommendation;
  const alternatives = recommendation ? alternativeDirections(opportunities ?? [], recommendation.opportunityId) : [];

  return (
    <div className="space-y-5">
      {recommendation ? (
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">
            Discovered · {recommendation.posture === "exploitation" ? "Exploitation" : "Exploration"} · {recommendation.angle}
          </p>
          <h2 className="mt-2 font-display text-3xl">{recommendation.label}</h2>
          <p className="mt-3">{recommendation.reason}</p>
          <p className="mt-2 text-sm">{recommendation.because}</p>
          <p className="mt-2 text-sm text-fg-muted">{recommendation.uncertainty}</p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-fg-muted">Market density</dt><dd>{recommendation.marketSignal.toFixed(2)} signal, {recommendation.saturation.toFixed(2)} saturation</dd></div>
            <div><dt className="text-fg-muted">Brand fit</dt><dd>{recommendation.brandFit.toFixed(2)}</dd></div>
            <div><dt className="text-fg-muted">Novelty</dt><dd>{recommendation.novelty.toFixed(2)}</dd></div>
            <div><dt className="text-fg-muted">Historical learning</dt><dd>{recommendation.historicalEvidence.toFixed(2)}</dd></div>
            <div><dt className="text-fg-muted">Rank</dt><dd>{recommendation.expectedValue.toFixed(2)}</dd></div>
            <div>
              <dt className="text-fg-muted">JEV decision</dt>
              <dd>
                {recommendation.decision
                  ? `${decisionPlainLabel(recommendation.decision)} · probability ${formatUnitInterval(recommendation.probability)}`
                  : "Not stored yet"}
              </dd>
            </div>
          </dl>
          <ul className="mt-4 space-y-2 text-sm">
            {recommendation.evidence.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {canEdit ? (
            <div className="mt-4 space-y-3">
              <DirectionReasonField id="direction-reason" value={reason} onChange={setReason} />
              <Button
                type="button"
                disabled={pending || reason.trim().length < DIRECTION_REASON_MIN}
                onClick={() => {
                  void onAccept(reason.trim()).then(() => setReason(""), () => undefined);
                }}
              >
                Accept direction and write the brief
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : (
        <Panel>
          <h2 className="font-display text-2xl">No discovered opportunity</h2>
          <p className="mt-2 text-sm text-fg-muted">
            {session.observationCount === 0
              ? "Add competitor ads you have seen. An empty library is not whitespace."
              : "Stored creatives do not yet show a direction outside the exploration seeds. Nothing was invented."}
          </p>
        </Panel>
      )}

      {session.exploration ? (
        <p className="text-sm text-fg-muted">Exploration, not a finding: {session.exploration.label}. {session.exploration.reason}</p>
      ) : null}

      {recommendation ? (
        <Panel>
          <h2 className="font-display text-2xl">Other directions</h2>
          <p className="mt-2 text-sm text-fg-muted">
            The brief is always written from the recommended direction. These are the other open opportunities, for comparison.
            Choosing one here is not available: the server writes the brief from the recommendation.
          </p>
          {opportunitiesFailed ? (
            <p role="alert" className="mt-3 text-sm text-danger">The other opportunities could not be read. Nothing is shown in their place.</p>
          ) : opportunities === undefined ? (
            <p role="status" className="mt-3 text-sm text-fg-muted">Loading the other opportunities…</p>
          ) : alternatives.length === 0 ? (
            <p className="mt-3 text-sm text-fg-muted">No other open opportunity is stored for this brand.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {alternatives.map((item) => (
                <li key={item.id} className="rounded-md border border-border p-3">
                  <p className="font-semibold">{item.label}</p>
                  <p className="text-fg-muted">{item.angle} · {directionSourceLabel(item.source)} · rank {item.expectedValue.toFixed(2)}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      {session.semantic.clusters.length > 0 ? (
        <Panel>
          <h2 className="font-display text-2xl">Semantic clusters</h2>
          <p className="mt-2 text-sm text-fg-muted">{session.semantic.note}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {session.semantic.clusters.map((cluster) => <li key={cluster.label}>{cluster.summary}</li>)}
          </ul>
        </Panel>
      ) : (
        <p className="text-sm text-fg-muted">{session.semantic.note}</p>
      )}

      {session.whitespace.length > 0 ? (
        <Panel>
          <h2 className="font-display text-2xl">Whitespace in the stored set</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {session.whitespace.map((item) => <li key={item.underused}>{item.whyTest}</li>)}
          </ul>
        </Panel>
      ) : null}

      <p className="text-xs text-fg-muted">
        Scores are read from stored evidence. <Term id="jev" /> evaluates the evidence and <Term id="hypit" /> renders approved briefs.
      </p>
    </div>
  );
}
