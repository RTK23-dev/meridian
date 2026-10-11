import type { UseFormRegisterReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, DisabledReason, Field, Card, Textarea } from "@/components/ui";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { IdeaToTestBadge, Term } from "@/components/glossary";
import { copy, decisionOutcome, percentOrUnknown } from "@/lib/copy";
import { alternativeDirections, directionSourceLabel, type DirectionCandidate } from "./direction.ts";
import type { StudioData } from "./types.ts";

/** The shortest reason that can accept a direction. The server enforces the same length. */
export const DIRECTION_REASON_MIN = 20;

/** The reason that accepts a direction or asks for the next brief. Trimmed, and at least the server's length. */
export const directionReasonSchema = z.object({
  reason: z.string().trim().min(DIRECTION_REASON_MIN, `Write at least ${DIRECTION_REASON_MIN} characters.`),
});

export type DirectionReasonInput = z.input<typeof directionReasonSchema>;

/**
 * The required reason for accepting a direction. It is recorded with the decision, who made it and when. It does not mean
 * the brief has passed its gate: the brief is judged separately when it is written.
 */
export function DirectionReasonField({ id, registration, error }: { id: string; registration: UseFormRegisterReturn; error?: string }) {
  return (
    <Field
      id={id}
      label={`Why accept this direction (at least ${DIRECTION_REASON_MIN} characters)`}
      hint="This is recorded with your decision. It does not mean the brief has passed its gate."
      error={error}
    >
      <Textarea rows={2} {...registration} />
    </Field>
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
  const reasonForm = useForm<DirectionReasonInput>({ resolver: zodResolver(directionReasonSchema), defaultValues: { reason: "" }, mode: "onChange" });
  const reason = reasonForm.watch("reason");
  const reasonDirty = reasonForm.formState.isDirty;
  const recommendation = session.recommendation;
  const alternatives = recommendation ? alternativeDirections(opportunities ?? [], recommendation.opportunityId) : [];

  return (
    <div className="space-y-5">
      {recommendation ? (
        <Card>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">
            Discovered · {recommendation.posture === "exploitation" ? "Builds on past results" : "Tests something new"} · {recommendation.angle}
          </p>
          <h2 className="mt-2 font-display text-3xl">{recommendation.label}</h2>
          <p className="mt-3">{recommendation.reason}</p>
          <p className="mt-2 text-sm">{recommendation.because}</p>
          <p className="mt-2 text-sm text-fg-muted">{recommendation.uncertainty}</p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-fg-muted">Market density</dt><dd>{recommendation.marketSignal.toFixed(2)} signal, {recommendation.saturation.toFixed(2)} saturation</dd></div>
            <div><dt className="text-fg-muted">Brand fit</dt><dd>{recommendation.brandFit.toFixed(2)}</dd></div>
            <div><dt className="text-fg-muted">Novelty</dt><dd>{recommendation.novelty.toFixed(2)}</dd></div>
            <div><dt className="text-fg-muted">Past results</dt><dd>{recommendation.historicalEvidence.toFixed(2)}</dd></div>
            <div><dt className="text-fg-muted">Rank score</dt><dd>{recommendation.expectedValue.toFixed(2)}</dd></div>
            <div>
              <dt className="text-fg-muted">Decision engine</dt>
              <dd>
                {recommendation.decision
                  ? `${decisionOutcome(recommendation.decision)} (probability ${percentOrUnknown(recommendation.probability)})`
                  : copy.opportunities.decisionNotYet}
                {" · "}<Term id="jev">What is JEV?</Term>
              </dd>
            </div>
          </dl>
          <ul className="mt-4 space-y-2 text-sm">
            {recommendation.evidence.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {canEdit ? (
            <div className="mt-4 space-y-3">
              <UnsavedChangesGuard dirty={reasonDirty} />
              <DirectionReasonField id="direction-reason" registration={reasonForm.register("reason")} error={reasonForm.formState.errors.reason?.message} />
              <FormDiscardBar dirty={reasonDirty} subject="direction reason" onDiscard={() => reasonForm.reset({ reason: "" })} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button
                  type="button"
                  disabled={pending || (reason ?? "").trim().length < DIRECTION_REASON_MIN}
                  aria-describedby={(reason ?? "").trim().length < DIRECTION_REASON_MIN && !pending ? "accept-direction-hint" : undefined}
                  onClick={() => {
                    void reasonForm.handleSubmit(async (values) => {
                      await onAccept(values.reason).then(() => reasonForm.reset({ reason: "" }), () => undefined);
                    })();
                  }}
                >
                  Accept direction and write the brief
                </Button>
                {(reason ?? "").trim().length < DIRECTION_REASON_MIN && !pending ? (
                  <DisabledReason id="accept-direction-hint" className="basis-full">
                    Write at least {DIRECTION_REASON_MIN} characters of reason to accept this direction.
                  </DisabledReason>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      ) : (
        <Card>
          <h2 className="font-display text-2xl">No discovered opportunity</h2>
          <p className="mt-2 text-sm text-fg-muted">
            {session.observationCount === 0
              ? "Add competitor ads you have seen. An empty library is not whitespace."
              : "Stored creatives do not yet show a direction beyond the starting ideas. Nothing was invented."}
          </p>
        </Card>
      )}

      {session.exploration ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted"><IdeaToTestBadge /><span>{session.exploration.label}. {session.exploration.reason}</span></p>
      ) : null}

      {recommendation ? (
        <Card>
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
                  <p className="text-fg-muted">{item.angle} · {item.source === "discovered" ? directionSourceLabel(item.source) : <IdeaToTestBadge />} · rank {item.expectedValue.toFixed(2)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {session.semantic.clusters.length > 0 ? (
        <Card>
          <h2 className="font-display text-2xl">Semantic clusters</h2>
          <p className="mt-2 text-sm text-fg-muted">{session.semantic.note}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {session.semantic.clusters.map((cluster) => <li key={cluster.label}>{cluster.summary}</li>)}
          </ul>
        </Card>
      ) : (
        <p className="text-sm text-fg-muted">{session.semantic.note}</p>
      )}

      {session.whitespace.length > 0 ? (
        <Card>
          <h2 className="font-display text-2xl">Whitespace in the stored set</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {session.whitespace.map((item) => <li key={item.underused}>{item.whyTest}</li>)}
          </ul>
        </Card>
      ) : null}

      <p className="text-xs text-fg-muted">
        Scores are read from stored evidence. <Term id="jev" /> evaluates the evidence and <Term id="hypit" /> renders approved briefs.
      </p>
    </div>
  );
}
