import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Term } from "@/components/glossary";
import { TechnicalDetails } from "@/components/plain-error";
import { describeQuestion } from "@/components/studio/jev-question-text";
import { Badge, Button, Field, Kbd, Panel, SelectInput, TextInput } from "@/components/ui";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { decisionOutcome, percentOrUnknown } from "@/lib/copy";
import { REVIEW_REASON_CODES } from "@/lib/meridian/machine";
import { ageBadge, confidenceBadge, formatOpened, reviewNoteFieldId, reviewPriority, reviewReasonFieldId, type ReviewDraft, type ReviewRow } from "./review-model";

/** The note is optional and stored with the decision. The server takes at most 500 characters. */
const reviewNoteSchema = z.object({
  reason: z.string(),
  note: z.string().max(500, "Use 500 characters or fewer."),
});

type ReviewNoteInput = z.input<typeof reviewNoteSchema>;

/**
 * The open review in the detail pane. The fields are a form for this review. Its values are mirrored into the reviews route's
 * draft store, so a draft survives moving between reviews and the keyboard decisions read it.
 * The reject reason starts empty, so a rejection always records a reason the reviewer
 * chose. Approve and reject are hidden for viewers, who can read the review but not decide it.
 */
export function ReviewDetail({
  item,
  now,
  canEdit,
  pending,
  draft,
  reasonError,
  onDraftChange,
  onApprove,
  onReject,
}: {
  item: ReviewRow;
  now: Date;
  canEdit: boolean;
  pending: boolean;
  draft: ReviewDraft;
  /** Show the "choose a reason" message. It is set after a reject was attempted without a reason. */
  reasonError: boolean;
  onDraftChange: (patch: Partial<ReviewDraft>) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const form = useForm<ReviewNoteInput>({
    resolver: zodResolver(reviewNoteSchema),
    defaultValues: { reason: draft.reason, note: draft.note },
    mode: "onChange",
  });
  const { register, formState: { errors, isDirty } } = form;
  useEffect(() => {
    const subscription = form.watch((values) => onDraftChange({ reason: values.reason ?? "", note: values.note ?? "" }));
    return () => subscription.unsubscribe();
  }, [form, onDraftChange]);
  const age = ageBadge(item.createdAt, now);
  const priority = reviewPriority({ createdAt: item.createdAt, confidence: item.confidence, now });
  const confidence = confidenceBadge(item.confidence);
  const reasonId = reviewReasonFieldId(item.id);
  const noteId = reviewNoteFieldId(item.id);
  return (
    <Panel aria-labelledby="review-detail-title" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={age.tone}>{age.label}</Badge>
        <Badge variant={priority.high ? "warning" : "neutral"}>{priority.label}</Badge>
        <Badge variant={confidence.tone}>{confidence.label}</Badge>
      </div>
      <p className="text-xs font-semibold uppercase tracking-widest text-brass">
        {describeQuestion(item.question)} · {decisionOutcome(item.decision)} · answer {item.answer || "unrecorded"} · probability {percentOrUnknown(item.probability)} · <Term id="confidence" /> {percentOrUnknown(item.confidence)}
      </p>
      <TechnicalDetails>Question {item.question}. Decision code {item.decision || "none"}.</TechnicalDetails>
      <h2 id="review-detail-title" className="font-display text-2xl">{item.label || "Untitled"}</h2>
      <p className="text-sm text-muted">Opened {formatOpened(item.createdAt)}. {priority.because}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        {item.reasons.map((reasonLine, index) => <li key={`${index}-${reasonLine}`}>{reasonLine}</li>)}
      </ul>
      {canEdit ? (
        <div className="grid gap-4">
          <UnsavedChangesGuard dirty={isDirty} />
          <Field
            id={reasonId}
            label="If you reject, why"
            hint="Required to reject. It is stored with the rejection."
            error={errors.reason?.message ?? (reasonError && !draft.reason ? "Choose a rejection reason before you reject." : undefined)}
          >
            <SelectInput {...register("reason")} id={reasonId}>
              <option value="">Choose a reason</option>
              {REVIEW_REASON_CODES.map((code) => <option key={code} value={code}>{code.replaceAll("_", " ")}</option>)}
            </SelectInput>
          </Field>
          <Field id={noteId} label="Note" hint="Optional. Stored with the decision." error={errors.note?.message}>
            <TextInput {...register("note")} id={noteId} maxLength={500} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={pending} onClick={onApprove}>Approve</Button>
            <Button variant="danger" disabled={pending} onClick={onReject}>Reject</Button>
          </div>
          <p className="text-xs text-muted">
            Keys: <Kbd>a</Kbd> approves, <Kbd>r</Kbd> rejects, <Kbd>j</Kbd> and <Kbd>k</Kbd> move. Keys do not act while you type in a field.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">Viewers can read reviews. A member can approve or reject.</p>
      )}
    </Panel>
  );
}
