import { useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { BriefReviewPanel } from "@/components/brief-review-panel";
import { Button, Card, DisabledReason, Input, Textarea } from "@/components/ui";
import { frameEditProblem, frameFieldText, PLATFORM_MAX, SUCCESS_MAX, type BriefFrame, type FrameEdit, type FrameSource } from "@/lib/meridian/brief/frame";
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
  framePending: boolean;
  onWriteNext: (reason: string) => Promise<unknown>;
  onSaveFrame: (briefId: string, edit: FrameEdit) => Promise<unknown>;
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
    <ul className="mt-2 divide-y divide-border text-sm">
      {changes.map((change) => (
        <li key={change.field} className="py-3">
          <p className="font-semibold">{change.label}</p>
          <p className="text-fg-muted">Before: {change.before || "Not stored."}</p>
          <p>Now: {change.after || "Not stored."}</p>
        </li>
      ))}
    </ul>
  );
}

const SOURCE_NOTES: Record<FrameSource, string> = {
  "brand brain": "From the brand brain",
  product: "From the product",
  research: "From research",
  person: "Set by a person",
  "not set": "",
};

const budgetFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** One frame field as read: its value, and where the value came from. A field never stored reads as not set, with no source. */
function FrameReadRow({ label, text, source }: { label: string; text: string; source: FrameSource }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
      <dt className="font-semibold">{label}</dt>
      <dd className="min-w-0 text-right">
        {source === "not set" ? <span className="text-fg-muted">Not set</span> : <span className="break-words">{text}</span>}
        {source === "not set" ? null : <span className="ml-2 text-small text-fg-muted">{SOURCE_NOTES[source]}</span>}
      </dd>
    </div>
  );
}

type FrameFormInput = { platform: string; budget: string; visualReferences: string; successCriteria: string };

function frameDefaults(frame: BriefFrame): FrameFormInput {
  return {
    platform: frame.platform.value ?? "",
    budget: frame.budgetUsd.value === null ? "" : String(frame.budgetUsd.value),
    visualReferences: (frame.visualReferences.value ?? []).join("\n"),
    successCriteria: frame.successCriteria.value ?? "",
  };
}

/** The edit a person made: only the fields whose text changed, each as the value it now holds. An empty field returns to not set. */
function frameEditFrom(values: FrameFormInput, dirty: Partial<Record<keyof FrameFormInput, boolean>>): FrameEdit {
  const edit: FrameEdit = {};
  if (dirty.platform) edit.platform = values.platform.trim() || null;
  if (dirty.budget) edit.budgetUsd = values.budget.trim() === "" ? null : Number(values.budget);
  if (dirty.visualReferences) edit.visualReferences = values.visualReferences.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (dirty.successCriteria) edit.successCriteria = values.successCriteria.trim() || null;
  return edit;
}

/**
 * The four fields a person may change on a ready brief. It is keyed on the stored frame, so a frame that changes elsewhere reloads the form.
 * A save changes the constraints only; the copy is judged as written.
 */
function FrameEditForm({ frame, pending, onSave }: { frame: BriefFrame; pending: boolean; onSave: (edit: FrameEdit) => Promise<unknown> }) {
  const form = useForm<FrameFormInput>({ defaultValues: frameDefaults(frame), mode: "onChange" });
  const dirty = Object.values(form.formState.dirtyFields).some(Boolean);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(values: FrameFormInput) {
    const edit = frameEditFrom(values, form.formState.dirtyFields);
    const found = frameEditProblem(edit);
    setProblem(found);
    if (found) return;
    await onSave(edit).then(() => form.reset(values), () => undefined);
  }

  return (
    <form className="space-y-4" onSubmit={form.handleSubmit(save)} noValidate>
      <UnsavedChangesGuard dirty={dirty} />
      <Input id="frame-platform" label="Platform note" hint="Where the video is meant to run, for example Instagram Reels. A note only: it does not change the video's settings." maxLength={PLATFORM_MAX} {...form.register("platform")} />
      <Input id="frame-budget" type="number" min="0" step="0.01" label="Budget note (USD)" hint="A note only: it does not limit spend. The spend cap is set when the video is generated. Leave empty if no budget is noted." {...form.register("budget")} />
      <Textarea id="frame-references" label="Visual references" hint="One per line, up to 10." {...form.register("visualReferences")} />
      <Textarea id="frame-criteria" label="Success criteria" hint="What a result must show to count as a win." maxLength={SUCCESS_MAX} {...form.register("successCriteria")} />
      {problem ? <p role="alert" className="text-small text-danger">{problem}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !dirty} aria-describedby={!dirty && !pending ? "frame-save-hint" : undefined}>
          Save frame
        </Button>
        {!dirty && !pending ? <DisabledReason id="frame-save-hint">Change a field to save the frame.</DisabledReason> : null}
      </div>
      <FormDiscardBar dirty={dirty} subject="brief frame" onDiscard={() => form.reset(frameDefaults(frame))} />
    </form>
  );
}

/** The brief's frame: the constraints it was written under, each with its value and where it came from. */
function BriefFrameSection({ brief, canEdit, pending, onSave }: { brief: StudioBrief; canEdit: boolean; pending: boolean; onSave: (edit: FrameEdit) => Promise<unknown> }) {
  const frame = brief.frame;
  const editable = canEdit && brief.status === "ready";
  return (
    <section aria-labelledby="brief-frame-title" className="mt-5 space-y-3">
      <h3 id="brief-frame-title" className="font-semibold">Brief frame</h3>
      <p className="text-sm text-fg-muted">The constraints this brief was written under. Each value shows where it came from. A field with no stored value reads as not set.</p>
      <p className="text-sm text-fg-muted">Changing the frame does not change the brief's copy. The copy is judged as written.</p>
      <dl className="divide-y divide-border text-sm">
        <FrameReadRow label="Voice" text={frameFieldText(frame.voice)} source={frame.voice.source} />
        <FrameReadRow label="Prohibited claims" text={frameFieldText(frame.prohibitedClaims)} source={frame.prohibitedClaims.source} />
        <FrameReadRow label="Required disclaimers" text={frameFieldText(frame.requiredDisclaimers)} source={frame.requiredDisclaimers.source} />
        <FrameReadRow label="Allowed claims" text={frameFieldText(frame.allowedClaims)} source={frame.allowedClaims.source} />
      </dl>
      {editable ? (
        <FrameEditForm key={JSON.stringify(frame)} frame={frame} pending={pending} onSave={onSave} />
      ) : (
        <>
          <dl className="divide-y divide-border text-sm">
            <FrameReadRow label="Platform note" text={frameFieldText(frame.platform)} source={frame.platform.source} />
            <FrameReadRow
              label="Budget note"
              text={frame.budgetUsd.value === null ? "Not set" : budgetFormat.format(frame.budgetUsd.value)}
              source={frame.budgetUsd.source}
            />
            <FrameReadRow label="Visual references" text={frameFieldText(frame.visualReferences)} source={frame.visualReferences.source} />
            <FrameReadRow label="Success criteria" text={frameFieldText(frame.successCriteria)} source={frame.successCriteria.source} />
          </dl>
          {brief.status !== "ready" ? <p className="text-sm text-fg-muted">A used or rejected brief keeps its frame. Only a ready brief's frame can be changed.</p> : null}
        </>
      )}
    </section>
  );
}

/** Step 2. The stored brief in sections, what changed since the previous brief, and writing the next brief. */
export function BriefStep({ brandId, session, brief, previous, canEdit, changed, pending, framePending, onWriteNext, onSaveFrame }: BriefStepProps) {
  const reasonForm = useForm<DirectionReasonInput>({ resolver: zodResolver(directionReasonSchema), defaultValues: { reason: "" }, mode: "onChange" });
  const reason = reasonForm.watch("reason");
  const reasonDirty = reasonForm.formState.isDirty;
  const changes = brief && previous ? briefChanges(brief, previous) : [];

  return (
    <div className="space-y-5">
      {session.briefs.filter((item) => item.status === "awaiting_review").map((item) => (
        <BriefReviewPanel key={item.id} brandId={brandId} briefId={item.id} title={item.title} role={session.role} />
      ))}

      {!brief ? (
        <Card>
          <h2 className="text-section font-semibold">Brief</h2>
          <p className="mt-1 text-sm text-fg-muted">No brief yet. Accept a direction in step 1 to write one.</p>
        </Card>
      ) : null}

      {brief ? (
        <>
          <Card>
            <h2 className="text-section font-semibold">Brief</h2>
            <p className="mt-1 text-sm text-fg-muted">{brief.title}</p>
            {changed ? <p className="mt-2 text-sm font-semibold">These findings changed the next recommendation.</p> : null}
            <p className="mt-2 text-sm text-fg-muted">The copy of a stored brief is not editable on this screen. {brief.status === "ready" ? "To get a new copy, accept another direction in step 1." : "Write the next brief to get a new copy."} Its frame can be changed while the brief is ready.</p>

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

            <BriefFrameSection brief={brief} canEdit={canEdit} pending={framePending} onSave={(edit) => onSaveFrame(brief.id, edit)} />

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
                  aria-describedby={(reason ?? "").trim().length < DIRECTION_REASON_MIN && !pending ? "next-brief-reason-hint" : undefined}
                  onClick={() => {
                    void reasonForm.handleSubmit(async (values) => {
                      await onWriteNext(values.reason).then(() => reasonForm.reset({ reason: "" }), () => undefined);
                    })();
                  }}
                >
                  Write the next brief
                </Button>
                {(reason ?? "").trim().length < DIRECTION_REASON_MIN && !pending ? (
                  <DisabledReason id="next-brief-reason-hint" className="basis-full">
                    Write at least {DIRECTION_REASON_MIN} characters of reason to write the next brief.
                  </DisabledReason>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card>
            <h2 className="text-section font-semibold">What changed since the last brief</h2>
            <p className="mt-1 text-sm text-fg-muted">Compared field by field with the brief written before this one. Only stored text is compared.</p>
            <ChangeList changes={changes} hasPrevious={!!previous} />
            <p className="mt-3 text-xs text-fg-muted">Fields compared: {Object.values(BRIEF_FIELD_LABELS).join(", ")}.</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
