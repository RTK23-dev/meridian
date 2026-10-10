import { Check, Minus } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { MediaPlayer } from "@/components/media-player";
import { Badge, Button, ErrorState, Field, Sheet, SheetContent, SheetDescription, SheetTitle, TextInput } from "@/components/ui";
import type { ManualPerformance, ManualPerformanceFields } from "@/lib/meridian/schemas/performance";
import { downloadHref, previewBox, type LibraryMediaVariant } from "./library-model";
import type { TraceStage } from "./trace-model";

export type TraceDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  summary: string;
  /** The trace is still loading. */
  loading: boolean;
  /** Plain words for a failed trace read, or null. */
  error: string | null;
  onRetry: () => void;
  /** The timeline, or null before the trace has loaded. */
  stages: TraceStage[] | null;
  script: string;
  learnedSummary: string;
  /** The stored media to preview, or null when nothing is stored. */
  preview: LibraryMediaVariant | null;
  canEdit: boolean;
  performanceForm: UseFormReturn<ManualPerformanceFields, unknown, ManualPerformance>;
  onRecordPerformance: (values: ManualPerformance) => Promise<void>;
  recordPending: boolean;
  onGenerateImage: () => void;
  imagePending: boolean;
};

function formatWhen(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleDateString();
}

/**
 * The trace of one creative as a timeline, in a sheet. Stages with no record say so. The performance form and the
 * image action are shown only to members, as they were in the inline panel.
 */
export function TraceDrawer(props: TraceDrawerProps) {
  const {
    open,
    onOpenChange,
    title,
    summary,
    loading,
    error,
    onRetry,
    stages,
    script,
    learnedSummary,
    preview,
    canEdit,
    performanceForm,
    onRecordPerformance,
    recordPending,
    onGenerateImage,
    imagePending,
  } = props;
  const { formState, register, reset } = performanceForm;
  const box = preview ? previewBox(preview) : { width: 1, height: 1 };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* One explicit scroll region holds the whole body, so the performance form and its button are always reachable. */}
      <SheetContent className="flex max-h-[90vh] w-full flex-col overflow-hidden p-0 sm:mx-auto sm:max-w-xl">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <div className="space-y-1 pr-8">
          <SheetTitle className="font-display text-2xl">{title}</SheetTitle>
          <SheetDescription className="text-sm text-muted">{summary}</SheetDescription>
        </div>
        {error ? <ErrorState message={error} onRetry={onRetry} /> : null}
        {stages === null ? (error || !loading ? null : <p role="status" className="text-sm text-muted">Loading trace</p>) : (
          <>
            <section aria-labelledby="trace-timeline-title" className="space-y-3">
              <h3 id="trace-timeline-title" className="font-semibold">Timeline</h3>
              <ol className="space-y-5 border-l border-border pl-5">
                {stages.map((stage) => (
                  <li key={stage.id} className="relative space-y-2">
                    <span
                      aria-hidden="true"
                      className={`absolute -left-[1.8rem] top-0.5 grid size-4 place-items-center rounded-full border ${stage.recorded ? "border-success bg-success-soft text-success" : "border-border-strong bg-surface text-muted"}`}
                    >
                      {stage.recorded ? <Check className="size-3" /> : <Minus className="size-3" />}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold">{stage.label}</h4>
                      <Badge variant={stage.recorded ? "success" : "neutral"}>{stage.recorded ? "Recorded" : "Not recorded"}</Badge>
                    </div>
                    {stage.entries.length ? (
                      <ul className="space-y-2 text-sm">
                        {stage.entries.map((entry) => (
                          <li key={entry.key}>
                            <span className="font-medium">{entry.title}</span>
                            <span className="block text-muted">{entry.detail}</span>
                            {entry.at ? <time dateTime={entry.at} className="block text-xs text-muted">{formatWhen(entry.at)}</time> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted">{stage.note}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>

            {preview ? (
              <section aria-labelledby="trace-media-title" className="space-y-2">
                <h3 id="trace-media-title" className="font-semibold">Stored {preview.kind === "video" ? "video" : "image"}</h3>
                {preview.kind === "video" ? (
                  <MediaPlayer assetId={preview.assetId} durationMs={preview.durationMs} width={preview.width} height={preview.height} />
                ) : (
                  <div className="space-y-2">
                    <MediaPlayer kind="image" assetId={preview.assetId} alt={`Stored image of ${title}`} width={box.width} height={box.height} />
                    <a className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent" href={downloadHref(preview.assetId)} aria-label={`Download image for ${title}`}>Download image</a>
                  </div>
                )}
              </section>
            ) : null}

            {script ? (
              <section aria-labelledby="trace-script-title" className="space-y-2">
                <h3 id="trace-script-title" className="font-semibold">Script</h3>
                <p className="whitespace-pre-wrap text-sm">{script}</p>
              </section>
            ) : null}

            <section aria-labelledby="trace-learned-title" className="space-y-2">
              <h3 id="trace-learned-title" className="font-semibold">Learned patterns</h3>
              <p className="text-sm text-muted">{learnedSummary}</p>
            </section>

            {canEdit ? (
              <section aria-labelledby="trace-record-title" className="space-y-4 border-t border-border pt-6">
                <h3 id="trace-record-title" className="font-semibold">Add performance for this creative</h3>
                <form className="grid gap-3 sm:grid-cols-2" onSubmit={performanceForm.handleSubmit(onRecordPerformance)}>
                  <Field label="Date" error={formState.errors.observedOn?.message}><TextInput {...register("observedOn")} type="date" required /></Field>
                  <Field label="Platform" error={formState.errors.platform?.message}><TextInput {...register("platform")} maxLength={80} /></Field>
                  <Field label="Reach" error={formState.errors.reach?.message}><TextInput {...register("reach")} type="text" inputMode="numeric" /></Field>
                  <Field label="Impressions" error={formState.errors.impressions?.message}><TextInput {...register("impressions")} type="text" inputMode="numeric" required /></Field>
                  <Field label="Clicks" error={formState.errors.clicks?.message}><TextInput {...register("clicks")} type="text" inputMode="numeric" required /></Field>
                  <Field label="Conversions" error={formState.errors.conversions?.message}><TextInput {...register("conversions")} type="text" inputMode="numeric" required /></Field>
                  <Field label="Spend (cents)" error={formState.errors.spendCents?.message}><TextInput {...register("spendCents")} type="text" inputMode="numeric" required /></Field>
                  <Field label="Revenue (cents)" error={formState.errors.revenueCents?.message}><TextInput {...register("revenueCents")} type="text" inputMode="numeric" required /></Field>
                  {formState.isDirty ? (
                    <div className="flex items-center justify-between rounded-md border border-warning bg-warning-soft p-3 text-sm sm:col-span-2" role="status">
                      <span>Unsaved changes</span>
                      <Button type="button" variant="quiet" onClick={() => reset()}>Discard</Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <Button type="submit" disabled={recordPending || formState.isSubmitting}>Record performance</Button>
                    <Button type="button" variant="quiet" disabled={imagePending} onClick={onGenerateImage}>Generate image</Button>
                  </div>
                </form>
              </section>
            ) : null}
          </>
        )}
      </div>
      </SheetContent>
    </Sheet>
  );
}

