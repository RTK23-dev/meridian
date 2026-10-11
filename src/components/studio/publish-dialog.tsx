import { useId } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, DisabledReason, Dialog, DialogContent, DialogDescription, DialogTitle, Field, Textarea } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { useDirtyDismiss } from "@/components/forms/use-dirty-dismiss";
import { PlainErrorMessage } from "@/components/plain-error";
import { copy, providerLabel, serverCodeMessage, statusLabel } from "@/lib/copy";
import { cn } from "@/lib/cn";
import { CopyButton } from "./copy-button.tsx";
import { frameShape } from "./aspect.ts";
import type { PublishReceipt } from "./types.ts";

export type PublishTarget = {
  creativeId: string;
  title: string;
  kind: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  defaultCaption: string;
};

export type PublishChannel = {
  id: string;
  name: string;
  type: "organic" | "paid";
  description: string;
  connected: boolean;
  accountName?: string;
};

const CAPTION_MAX = 1000;

/** distribution publish: at least one destination, and the caption is trimmed and cut at 1000 characters. */
const publishFormSchema = z.object({
  channelIds: z.array(z.string()).min(1, "Select at least one destination channel."),
  caption: z.string().trim().max(CAPTION_MAX, `Use ${CAPTION_MAX} characters or fewer.`),
});

type PublishFormValues = z.output<typeof publishFormSchema>;

type PublishDialogProps = {
  target: PublishTarget | null;
  channels: readonly PublishChannel[];
  pending: boolean;
  results: readonly PublishReceipt[] | null;
  onClose: () => void;
  onConfirm: (channelIds: string[], caption: string) => void;
};

/**
 * Destinations for one variant. Only connected destinations start selected, and a destination that is not connected cannot
 * be chosen. The parent remounts the dialog for each opening, so the selection and caption start from the stored values.
 */
export function PublishDialog({ target, channels, pending, results, onClose, onConfirm }: PublishDialogProps) {
  const defaults = { channelIds: channels.filter((channel) => channel.connected).map((channel) => channel.id), caption: target?.defaultCaption ?? "" };
  const form = useForm<{ channelIds: string[]; caption: string }, unknown, PublishFormValues>({
    resolver: zodResolver(publishFormSchema),
    defaultValues: defaults,
    mode: "onChange",
  });
  const { register, formState: { errors, isDirty } } = form;
  const selected = form.watch("channelIds");
  const descriptionId = useId();
  const captionId = useId();
  const frame = frameShape(target?.width, target?.height);
  const names = new Map(channels.map((channel) => [channel.id, channel.name] as const));
  const selectedNames = selected.map((id) => names.get(id) ?? id);
  const dismiss = useDirtyDismiss({
    dirty: isDirty && !!target,
    onOpenChange: (open) => { if (!open && !pending) onClose(); },
    onDiscard: () => form.reset(defaults),
  });

  return (
    <Dialog open={!!target} onOpenChange={dismiss.requestOpenChange}>
      {target ? (
        <DialogContent aria-describedby={descriptionId} className="max-w-2xl">
          <DialogTitle className="font-display text-2xl">Publish this variant</DialogTitle>
          <DialogDescription id={descriptionId} className="mt-2 text-sm text-fg-muted">
            Choose where it goes. Nothing is sent to a destination you do not select. Each destination returns its own receipt.
          </DialogDescription>

          <form
            noValidate
            className="contents"
            onSubmit={form.handleSubmit((values) => {
              onConfirm(values.channelIds, values.caption);
              // The dialog stays open to show the receipts, so the sent choice becomes the baseline. Closing does not ask.
              form.reset(values, { keepValues: true });
            })}
          >
          <div className="mt-4 space-y-4">
            {(["paid", "organic"] as const).map((type) => {
              const group = channels.filter((channel) => channel.type === type);
              if (group.length === 0) return null;
              return (
                <fieldset key={type} className="space-y-2">
                  <legend className="text-sm font-semibold">{type === "paid" ? "Paid advertising" : "Organic social"}</legend>
                  {group.map((channel) => {
                    const reasonId = `${captionId}-${channel.id}-reason`;
                    const checked = selected.includes(channel.id);
                    return (
                      <label
                        key={channel.id}
                        className={cn(
                          "flex min-h-11 items-start gap-3 rounded-md border p-3 text-sm",
                          checked ? "border-accent bg-accent-soft" : "border-border bg-surface",
                          !channel.connected && "opacity-80",
                        )}
                      >
                        <input
                          type="checkbox"
                          value={channel.id}
                          {...register("channelIds")}
                          className="mt-1 size-4 shrink-0"
                          disabled={!channel.connected || pending}
                          aria-describedby={channel.connected ? undefined : reasonId}
                        />
                        <span className="min-w-0 space-y-0.5">
                          <span className="block font-semibold">{channel.name}</span>
                          <span className="block text-fg-muted">{channel.description}</span>
                          <span className={cn("block text-xs", channel.connected ? "text-success" : "text-fg-muted")}>
                            {channel.connected ? "Connected" : "Not connected"}{channel.accountName ? ` · ${channel.accountName}` : ""}
                          </span>
                          {!channel.connected ? <span id={reasonId} className="block text-xs text-fg-muted">This destination is not connected, so it cannot be chosen.</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              );
            })}
            {channels.length === 0 ? <p className="text-sm text-fg-muted">No destination is listed for this brand.</p> : null}
            {errors.channelIds?.message ? <p role="alert" className="text-sm text-danger">{errors.channelIds.message}</p> : null}
          </div>

          <dl className="mt-4 grid gap-2 rounded-md border border-border bg-surface-2 p-3 text-sm sm:grid-cols-2">
            <div><dt className="text-fg-muted">Creative</dt><dd className="font-semibold">{target.title || target.kind}</dd></div>
            <div><dt className="text-fg-muted">Format</dt><dd>{target.kind} · {frame.label}{target.durationMs ? ` · ${(target.durationMs / 1000).toFixed(1)} s` : ""}</dd></div>
            <div className="sm:col-span-2"><dt className="text-fg-muted">Destinations</dt><dd>{selectedNames.length > 0 ? selectedNames.join(", ") : "None selected"}</dd></div>
          </dl>

          <div className="mt-4 space-y-2">
            <Field label="Caption and hashtags" hint="Organic channels send this caption. The test publisher records an id and does not use it." error={errors.caption?.message}>
              <Textarea {...register("caption")} rows={3} maxLength={CAPTION_MAX} disabled={pending} />
            </Field>
            <UnsavedChangesBar
              dirty={isDirty}
              subject="publish"
              confirming={dismiss.confirming}
              onConfirmingChange={dismiss.setConfirming}
              onDiscard={dismiss.discard}
            />
          </div>

          {results ? (
            <div role="status" aria-live="polite" className="mt-4 space-y-2 rounded-md border border-border p-3 text-sm">
              <p className="font-semibold">Publish receipts</p>
              <ul className="space-y-3">
                {results.map((receipt, index) => (
                  <li key={`${receipt.channelId}-${index}`} className="space-y-1">
                    <p>
                      <span className="font-semibold">{names.get(receipt.channelId) ?? providerLabel(receipt.platform)}</span>: {statusLabel(receipt.status)}
                    </p>
                    {receipt.error ? <PlainErrorMessage message={serverCodeMessage(receipt.error) ?? copy.studio.publicationProblem} raw={receipt.error} /> : null}
                    {receipt.url ? <a href={receipt.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">View the post</a> : null}
                    {receipt.externalId ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{copy.studio.publisherId} <code className="break-all font-mono text-xs">{receipt.externalId}</code></span>
                        <CopyButton value={receipt.externalId} label={copy.studio.copyPublisherId} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            {selected.length === 0 && !pending ? <DisabledReason id="publish-destination-reason" className="basis-full text-right">Choose at least one destination to publish to.</DisabledReason> : null}
            <Button type="button" variant="quiet" disabled={pending} onClick={() => dismiss.requestOpenChange(false)}>Close</Button>
            <Button type="submit" disabled={pending || selected.length === 0} aria-describedby={selected.length === 0 && !pending ? "publish-destination-reason" : undefined}>
              {pending ? "Publishing…" : `Publish to ${selected.length} destination${selected.length === 1 ? "" : "s"}`}
            </Button>
          </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
