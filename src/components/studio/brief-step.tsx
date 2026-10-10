import { type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { BriefReviewPanel } from "@/components/brief-review-panel";
import { Button, Card } from "@/components/ui";
import { briefChanges, BRIEF_FIELD_LABELS, type BriefChange } from "./brief-diff.ts";
import { DIRECTION_REASON_MIN, DirectionReasonField, directionReasonSchema, type DirectionReasonInput } from "./direction-step.tsx";
import type { StudioBrief, StudioData } from "./types.ts";

type BriefStepProps = {
  brandId: string;
  session: StudioData;
  brief: StudioBrief | null;
  previous: StudioBrief | null;
  canEdit: boolean;
  changed: boolean;
  pending: boolean;
  onWriteNext: (reason: string) => Promise<unknown>;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function ChangeList({ changes, hasPrevious }: { changes: BriefChange[]; hasPrevious: boolean }) {
  if (!hasPrevious) return <p className="mt-2 text-sm text-fg-muted">There is no earlier brief to compare with.</p>;
  if (changes.length === 0) return <p className="mt-2 text-sm text-fg-muted">No field changed since the previous brief.</p>;
  return (
    <ul className="mt-2 space-y-3 text-sm">
      {changes.map((change) => (
        <li key={change.field} className="rounded-md border border-border p-3">
          <p className="font-semibold">{change.label}</p>
          <p className="text-fg-muted">Before: {change.before || "Not stored."}</p>
          <p>Now: {change.after || "Not stored."}</p>
        </li>
      ))}
    </ul>
  );
}

/** Step 2. The stored brief in sections, what changed since the previous brief, and writing the next brief. */
export function BriefStep({ brandId, session, brief, previous, canEdit, changed, pending, onWriteNext }: BriefStepProps) {
  const reasonForm = useForm<DirectionReasonInput>({ resolver: zodResolver(directionReasonSchema), defaultValues: { reason: "" }, mode: "onChange" });
  const reason = reasonForm.watch("reason");
  const reasonDirty = reasonForm.formState.isDirty;
  const changes = brief && previous ? briefChanges(brief, previous) : [];

  return (
    <div className="space-y-5">
      {session.briefs.filter((item) => item.status === "awaiting_review").map((item) => (
        <BriefReviewPanel key={item.id} brandId={brandId} briefId={item.id} title={item.title} role={session.role} />
      ))}

      {brief ? (
        <>
          <Card>
            <h2 className="font-display text-2xl">Brief</h2>
            <p className="mt-1 text-sm text-fg-muted">{brief.title}</p>
            {changed ? <p className="mt-2 text-sm font-semibold">These findings changed the next recommendation.</p> : null}
            <p className="mt-2 text-sm text-fg-muted">Editing a stored brief is not available on this screen. Write the next brief to get a new one.</p>

            <div className="mt-4 grid gap-5 md:grid-cols-2">
              <Section title="Objective">{brief.why[0] ?? "Not stored."}</Section>
              <Section title="Audience">{brief.audience || "Not stored."}</Section>
              <Section title="Angle">{brief.angle || "Not stored."}</Section>
              <Section title="Hook">{brief.hook || "Not stored."}</Section>
              <Section title="Promise">{brief.promise || "Not stored."}</Section>
              <Section title="Proof">{brief.proofType || "Not stored."}</Section>
              <Section title="Offer">{brief.offer || "None stored."}</Section>
              <Section title="Call to action">{brief.cta || "Not stored."}</Section>
              <Section title="Format">{brief.format || "Not stored."}</Section>
            </div>

            <h3 className="mt-5 font-semibold">Why this, why now</h3>
            <ul className="mt-2 space-y-1 text-sm">{brief.why.map((line) => <li key={line}>{line}</li>)}</ul>
            <h3 className="mt-5 font-semibold">Visual direction</h3>
            <p className="mt-2 text-sm">{brief.format}. Proof: {brief.proofType || "Not stored."}</p>
            <h3 className="mt-5 font-semibold">What not to do</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm" data-testid="brief-constraints">{brief.constraints || "No stored constraint."}</p>

            <h3 className="mt-5 font-semibold">Learned positives</h3>
            {session.learned.some((pattern) => pattern.direction === "POSITIVE") ? (
              <ul className="mt-2 text-sm">
                {session.learned.filter((pattern) => pattern.direction === "POSITIVE").map((pattern) => <li key={`${pattern.attribute}:${pattern.value}:up`}>POSITIVE · {pattern.summary}</li>)}
              </ul>
            ) : <p className="mt-2 text-sm text-fg-muted">No positive pattern is stored.</p>}
            <h3 className="mt-5 font-semibold">Learned negatives</h3>
            {session.learned.some((pattern) => pattern.direction === "NEGATIVE") ? (
              <ul className="mt-2 text-sm">
                {session.learned.filter((pattern) => pattern.direction === "NEGATIVE").map((pattern) => <li key={`${pattern.attribute}:${pattern.value}:down`}>NEGATIVE · {pattern.summary}</li>)}
              </ul>
            ) : <p className="mt-2 text-sm text-fg-muted">No negative pattern is stored.</p>}
            {session.rejections.length > 0 ? (
              <>
                <h3 className="mt-5 font-semibold">Rejected directions</h3>
                <ul className="mt-2 text-sm">{session.rejections.map((line) => <li key={line}>{line}</li>)}</ul>
              </>
            ) : null}
            {brief.learningNotes.length > 0 ? (
              <ul className="mt-4 text-sm">{brief.learningNotes.map((line) => <li key={line}>Learned: {line}</li>)}</ul>
            ) : <p className="mt-4 text-sm text-fg-muted">No learned pattern is attached to this brief yet.</p>}

            {canEdit && brief.status !== "ready" ? (
              <div className="mt-5 space-y-3">
                <UnsavedChangesGuard dirty={reasonDirty} />
                <DirectionReasonField id="next-brief-reason" registration={reasonForm.register("reason")} error={reasonForm.formState.errors.reason?.message} />
                <FormDiscardBar dirty={reasonDirty} subject="next brief reason" onDiscard={() => reasonForm.reset({ reason: "" })} />
                <Button
                  type="button"
                  variant="quiet"
                  disabled={pending || (reason ?? "").trim().length < DIRECTION_REASON_MIN}
                  onClick={() => {
                    void reasonForm.handleSubmit(async (values) => {
                      await onWriteNext(values.reason).then(() => reasonForm.reset({ reason: "" }), () => undefined);
                    })();
                  }}
                >
                  Write the next brief
                </Button>
              </div>
            ) : null}
          </Card>

          <Card>
            <h2 className="font-display text-2xl">What changed since the last brief</h2>
            <p className="mt-1 text-sm text-fg-muted">Compared field by field with the brief written before this one. Only stored text is compared.</p>
            <ChangeList changes={changes} hasPrevious={!!previous} />
            <p className="mt-3 text-xs text-fg-muted">Fields compared: {Object.values(BRIEF_FIELD_LABELS).join(", ")}.</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
