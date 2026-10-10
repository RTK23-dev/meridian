import type { ReactNode } from "react";
import { Button, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { statusLabel } from "@/lib/copy";
import type { JobDetailView } from "@/lib/meridian/jobs/ops";
import { useJobDetailQuery } from "@/lib/query/hooks";
import { RefusalNotice } from "./ops-shared";
import { attemptsLabel, durationLabel, jobActionState, payloadLines, timestampLabel } from "./jobs-model";

type Message = { jobId: string; text?: string; error?: unknown } | null;

export function JobDetailSheet({ organizationId, jobId, canAdmin, retrying, cancelling, message, onRetry, onCancel, onClose }: {
  organizationId: string;
  jobId: string | null;
  canAdmin: boolean;
  retrying: string[];
  cancelling: string[];
  message: Message;
  onRetry: (job: JobDetailView) => void;
  onCancel: (job: JobDetailView) => void;
  onClose: () => void;
}) {
  const detail = useJobDetailQuery(organizationId, jobId);
  const job = detail.data ?? null;
  const actions = job ? jobActionState(job, canAdmin) : null;
  const notice = message && job && message.jobId === job.id ? message : null;

  return (
    <Sheet open={!!jobId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="max-h-[88vh] sm:mx-auto sm:max-w-2xl sm:rounded-xl sm:border">
        <SheetTitle className="font-display text-2xl">{job ? `${job.jobType || "Job"} · ${statusLabel(job.status)}` : "Job details"}</SheetTitle>
        <SheetDescription className="mt-1 text-sm text-fg-muted">
          Payload values are never shown. Only field names and value types appear here.
        </SheetDescription>

        {detail.isPending && jobId ? (
          <div role="status" aria-label="Loading job" className="mt-4 space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>
        ) : null}
        {detail.isError && !job ? <div className="mt-4"><PlainErrorNotice error={detail.error} /></div> : null}

        {job ? (
          <div className="mt-5 space-y-6">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Job ID"><span className="break-all font-mono text-xs">{job.id}</span></Field>
              <Field label="Brand">{job.brandName}</Field>
              <Field label="Status">{statusLabel(job.status)}{job.cancelRequested ? " · cancellation requested" : ""}</Field>
              <Field label="Attempts">{attemptsLabel(job.attempts, job.maxAttempts)}</Field>
              <Field label="Created">{timestampLabel(job.createdAt)}</Field>
              <Field label="Last updated">{timestampLabel(job.updatedAt)}</Field>
              <Field label="Run after">{timestampLabel(job.runAfter)}</Field>
              <Field label="Duration">{durationLabel(job.durationMs)}</Field>
              <Field label="Lease until">{job.leaseUntil ? timestampLabel(job.leaseUntil) : "No lease"}</Field>
              <Field label="Last heartbeat">{job.heartbeatAt ? timestampLabel(job.heartbeatAt) : "None recorded"}</Field>
              <Field label="Priority">{job.priority}</Field>
              <Field label="Depends on">{job.dependsOn || "Nothing"}</Field>
            </dl>

            <section aria-labelledby="job-payload-heading" className="space-y-2">
              <h3 id="job-payload-heading" className="text-sm font-semibold">Payload fields</h3>
              {job.payloadFields.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {payloadLines(job.payloadFields).map((line) => <li key={line} className="break-words">{line}</li>)}
                </ul>
              ) : <p className="text-sm text-fg-muted">No payload fields are stored for this job.</p>}
            </section>

            <section aria-labelledby="job-error-heading" className="space-y-2">
              <h3 id="job-error-heading" className="text-sm font-semibold">Last error</h3>
              <p className="whitespace-pre-wrap break-words text-sm">{job.error || "None stored"}</p>
            </section>

            <section aria-labelledby="job-result-heading" className="space-y-2">
              <h3 id="job-result-heading" className="text-sm font-semibold">Result</h3>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 text-xs">{job.result || "No result is stored."}</pre>
            </section>

            {notice?.error ? <RefusalNotice error={notice.error} /> : null}
            {notice?.text ? <p role="status" className="text-sm">{notice.text}</p> : null}

            {actions && (actions.retry || actions.cancel || actions.cancelNote) ? (
              <div className="flex flex-wrap items-center gap-2">
                {actions.retry ? (
                  <Button type="button" variant="secondary" size="md" loading={retrying.includes(job.id)} onClick={() => onRetry(job)}>Retry job</Button>
                ) : null}
                {actions.cancel ? (
                  <Button type="button" variant="danger" size="md" loading={cancelling.includes(job.id)} onClick={() => onCancel(job)}>Cancel queued job</Button>
                ) : null}
                {actions.cancelNote ? <span className="text-sm text-fg-muted">{actions.cancelNote}</span> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}
