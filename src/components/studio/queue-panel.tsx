import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Badge, Button, Field, Panel, SelectInput } from "@/components/ui";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { queueScheduleSchema, type QueueScheduleInput } from "@/components/forms/client-schemas";
import { CheckCircle2, Clock, RefreshCw, Send, Share2 } from "lucide-react";
import {
  usePlatformAccountsQuery,
  usePublishingQueueQuery,
  useScheduleMultiAccountPublish,
  useCancelPublishJob,
  useRetryPublishJob,
} from "@/lib/query/hooks";
import type { StudioVariant } from "./types.ts";

type QueuePanelProps = {
  brandId: string;
  variants: StudioVariant[];
  canEdit: boolean;
};

/**
 * The publishing queue: schedule a variant to platform accounts, then see the queue and its receipts. Retry and cancel
 * are shown only to a role that may change the queue, and only for jobs in a state that allows them.
 */
export function QueuePanel({ brandId, variants, canEdit }: QueuePanelProps) {
  const accountsQuery = usePlatformAccountsQuery(brandId);
  const queueQuery = usePublishingQueueQuery(brandId);
  const schedulePublishMutation = useScheduleMultiAccountPublish(brandId);
  const cancelJobMutation = useCancelPublishJob(brandId);
  const retryJobMutation = useRetryPublishJob(brandId);

  const blankSchedule: QueueScheduleInput = { creativeId: "", targetType: "organic", targetAccountIds: [], scheduledTime: "" };
  const queueForm = useForm<QueueScheduleInput>({ resolver: zodResolver(queueScheduleSchema), defaultValues: blankSchedule, mode: "onChange" });
  const { register, formState: { errors, isDirty } } = queueForm;
  const queueAccountIds = queueForm.watch("targetAccountIds");
  const queueCreativeId = queueForm.watch("creativeId");

  function enqueue() {
    void queueForm.handleSubmit((values) => {
      schedulePublishMutation.mutate(
        {
          creativeId: values.creativeId,
          targetAccountIds: values.targetAccountIds,
          scheduledTime: values.scheduledTime ? new Date(values.scheduledTime).toISOString() : undefined,
          targetType: values.targetType,
        },
        {
          onSuccess: () => {
            // The creative and target type stay as chosen. The accounts and the time are cleared, as they always were.
            queueForm.reset({ ...queueForm.getValues(), targetAccountIds: [], scheduledTime: "" });
          },
        },
      );
    })();
  }

  const queueItems = ((queueQuery.data as any)?.queue as Array<{
    id: string;
    platform: string;
    creativeId: string;
    targetType: string;
    scheduledTime: string;
    status: string;
    attempts: number;
    maxAttempts: number;
  }>) ?? [];
  const queueReceipts = ((queueQuery.data as any)?.receipts as Array<{
    id: string;
    platform: string;
    externalPostId: string;
    publishedAt: string;
    externalUrl?: string;
  }>) ?? [];

  return (
    <div className="space-y-6">
      <UnsavedChangesGuard dirty={isDirty} />
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-bold">Multi-Account Publishing Queue</h2>
        <p className="text-sm text-fg-muted">
          Orchestrate social publishing across connected platform accounts with rate limiting, automated retries, and idempotency guarantees.
        </p>
      </div>

      <Panel className="space-y-4">
        <h3 className="font-display text-lg font-semibold flex items-center gap-2">
          <Share2 className="h-4 w-4 text-accent" aria-hidden="true" />
          Schedule Variant to Destination Accounts
        </h3>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Choose Creative Variant" error={errors.creativeId?.message}>
            <SelectInput {...register("creativeId")}>
              <option value="">Select a variant…</option>
              {variants.map((v) => (
                <option key={v.creativeId} value={v.creativeId}>
                  {v.title || v.kind} ({v.creativeStatus})
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label="Target Type" error={errors.targetType?.message}>
            <SelectInput {...register("targetType")}>
              <option value="organic">Organic Social Post</option>
              <option value="paid_campaign">Paid Ad Campaign</option>
            </SelectInput>
          </Field>
        </div>

        <div>
          <p className="mb-2 block text-xs font-semibold uppercase tracking-wider text-fg-muted">
            Target Platform Accounts ({queueAccountIds.length} selected)
          </p>
          {errors.targetAccountIds?.message ? <p role="alert" className="mb-2 text-sm text-danger">{errors.targetAccountIds.message}</p> : null}
          {(accountsQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-fg-muted">
              No social accounts connected yet. Go to <a href={`/brands/${brandId}/accounts`} className="underline text-accent">Accounts</a> to connect Instagram, TikTok, or YouTube.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {(accountsQuery.data ?? []).map((acct) => (
                <label key={acct.id} className="flex min-h-11 items-center gap-2.5 rounded-md border border-border bg-surface p-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    value={acct.id}
                    {...register("targetAccountIds")}
                    className="size-4"
                  />
                  <div className="truncate">
                    <span className="font-semibold block truncate">{acct.name}</span>
                    <span className="text-xs text-fg-muted block truncate capitalize">
                      {acct.platform} {acct.handle ? `· ${acct.handle}` : ""}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Schedule Time (optional, leave blank for immediate)" error={errors.scheduledTime?.message}>
            <input
              type="datetime-local"
              {...register("scheduledTime")}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-3 text-base text-fg"
            />
          </Field>
        </div>

        <FormDiscardBar dirty={isDirty} subject="publishing schedule" onDiscard={() => queueForm.reset(blankSchedule)} />
        <div className="flex justify-end pt-2">
          <Button
            variant="primary"
            disabled={!canEdit || !queueCreativeId || queueAccountIds.length === 0 || schedulePublishMutation.isPending}
            onClick={enqueue}
          >
            <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {schedulePublishMutation.isPending ? "Enqueueing…" : `Enqueue to ${queueAccountIds.length} Account(s)`}
          </Button>
        </div>
      </Panel>

      <Panel className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-accent" aria-hidden="true" />
            Live Publishing Queue ({queueItems.length})
          </h3>
          <Button size="sm" variant="secondary" aria-label="Refresh the publishing queue" onClick={() => void queueQuery.refetch()} disabled={queueQuery.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${queueQuery.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        </div>

        {queueItems.length === 0 ? (
          <p className="text-sm text-fg-muted py-4 text-center">Publishing queue is currently empty.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Publishing jobs for this brand</caption>
              <thead className="border-b border-border text-fg-muted uppercase tracking-wider">
                <tr>
                  <th scope="col" className="py-2 pr-3">Target Platform</th>
                  <th scope="col" className="py-2 pr-3">Creative ID</th>
                  <th scope="col" className="py-2 pr-3">Type</th>
                  <th scope="col" className="py-2 pr-3">Scheduled</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2 pr-3">Attempts</th>
                  <th scope="col" className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {queueItems.map((item) => {
                  const badgeVariant =
                    item.status === "published" ? "success"
                    : item.status === "processing" ? "info"
                    : item.status === "failed" ? "danger"
                    : item.status === "cancelled" ? "neutral"
                    : "warning";
                  return (
                    <tr key={item.id} className="hover:bg-surface-2">
                      <td className="py-3 pr-3 font-semibold capitalize">{item.platform}</td>
                      <td className="py-3 pr-3 font-mono text-fg-muted">{item.creativeId}</td>
                      <td className="py-3 pr-3 capitalize text-fg-muted">{item.targetType.replace(/_/g, " ")}</td>
                      <td className="py-3 pr-3 text-fg-muted">{new Date(item.scheduledTime).toLocaleString()}</td>
                      <td className="py-3 pr-3">
                        <Badge variant={badgeVariant} className="capitalize">{item.status}</Badge>
                      </td>
                      <td className="py-3 pr-3 text-fg-muted">{item.attempts} / {item.maxAttempts}</td>
                      <td className="py-3 text-right">
                        {canEdit && (item.status === "failed" || item.status === "cancelled") ? (
                          <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={retryJobMutation.isPending} onClick={() => retryJobMutation.mutate({ queueId: item.id })}>
                            Retry
                          </Button>
                        ) : null}
                        {canEdit && (item.status === "queued" || item.status === "processing") ? (
                          <Button size="sm" variant="danger" className="h-7 text-xs ml-1" disabled={cancelJobMutation.isPending} onClick={() => cancelJobMutation.mutate({ queueId: item.id })}>
                            Cancel
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {queueReceipts.length > 0 ? (
        <Panel className="space-y-3">
          <h3 className="font-display text-lg font-semibold flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
            Live Execution Receipts
          </h3>
          <div className="space-y-2">
            {queueReceipts.map((rec) => (
              <div key={rec.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface p-3 text-xs">
                <div>
                  <span className="font-semibold capitalize">{rec.platform} Post</span>
                  <span className="font-mono text-fg-muted block mt-0.5">ID: {rec.externalPostId}</span>
                  <span className="text-fg-muted block text-[11px]">Published: {new Date(rec.publishedAt).toLocaleString()}</span>
                </div>
                {rec.externalUrl ? (
                  <a href={rec.externalUrl} target="_blank" rel="noopener noreferrer" className="underline text-accent font-semibold">
                    View External Post &rarr;
                  </a>
                ) : (
                  <Badge variant="success">Confirmed Live</Badge>
                )}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
