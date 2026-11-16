import { OffNotice } from "@/components/off-notice";
import { isOff } from "@/lib/meridian/providers/off";
import { useId } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, DisabledReason, Dialog, DialogContent, DialogDescription, DialogTitle, Field, SelectInput, Textarea } from "@/components/ui";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { useDirtyDismiss } from "@/components/forms/use-dirty-dismiss";
import { PlainErrorMessage } from "@/components/plain-error";
import { copy, providerLabel, serverCodeMessage, statusLabel } from "@/lib/copy";
import { cn } from "@/lib/cn";
import { CopyButton } from "./copy-button.tsx";
import { frameShape } from "./aspect.ts";
import { confirmRetryLabel, deliverByHandOnly, publishBlockReason, uncertainDestinations } from "./publish-state.ts";
import type { PublishReceipt } from "./types.ts";

/** The built-in channels whose posting is gated in this version (Facebook Page posting is on). Any other destination (a test publisher, a registered channel) is not. */
const OFF_CHANNELS: Record<string, Parameters<typeof isOff>[0]> = { "instagram-reels": "publish.instagram", "youtube-shorts": "publish.youtube", "tiktok-organic": "publish.tiktok" };
const channelOff = (id: string) => id in OFF_CHANNELS && isOff(OFF_CHANNELS[id]!);

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
  /** Why the destination is not connected. Shown on its row. */
  reason?: string;
};

const CAPTION_MAX = 1000;

/**
 * The Instagram trial choice for this post: null is an ordinary publish. A trial names its graduation strategy, which Meta documents as
 * MANUAL or SS_PERFORMANCE (distribution/trial.ts).
 */
export type PublishTrial = { graduationStrategy: "MANUAL" | "SS_PERFORMANCE" } | null;

/**
 * distribution publish: at least one destination, and the caption is trimmed and cut at 1000 characters. A trial first needs its graduation
 * strategy, and no strategy is chosen for the person.
 */
const publishFormSchema = z
  .object({
    channelIds: z.array(z.string()).min(1, "Select at least one destination channel."),
    caption: z.string().trim().max(CAPTION_MAX, `Use ${CAPTION_MAX} characters or fewer.`),
    trialFirst: z.boolean(),
    trialGraduation: z.enum(["", "MANUAL", "SS_PERFORMANCE"]),
    confirmRetry: z.boolean(),
  })
  .refine((values) => !values.trialFirst || !values.channelIds.includes("instagram-reels") || values.trialGraduation !== "", {
    path: ["trialGraduation"],
    message: "Choose how the trial reel graduates to the feed.",
  });

type PublishFormValues = z.output<typeof publishFormSchema>;

type PublishDialogProps = {
  target: PublishTarget | null;
  channels: readonly PublishChannel[];
  pending: boolean;
  results: readonly PublishReceipt[] | null;
  onClose: () => void;
  /** `confirmRetry` is true only when a destination was uncertain and the person ticked that they checked the platform. */
  onConfirm: (channelIds: string[], caption: string, trial: PublishTrial, confirmRetry: boolean) => void;
  /** Starts the export package for manual posting. Shown as the way to deliver when no destination is connected. */
  onExportPackage?: () => void;
};

/**
 * Destinations for one variant. Only connected destinations start selected, and a destination that is not connected cannot
 * be chosen. The parent remounts the dialog for each opening, so the selection and caption start from the stored values.
 */
export function PublishDialog({ target, channels, pending, results, onClose, onConfirm, onExportPackage }: PublishDialogProps) {
  const defaults = { channelIds: channels.filter((channel) => channel.connected).map((channel) => channel.id), caption: target?.defaultCaption ?? "" };
  const form = useForm<{ channelIds: string[]; caption: string; trialFirst: boolean; trialGraduation: "" | "MANUAL" | "SS_PERFORMANCE"; confirmRetry: boolean }, unknown, PublishFormValues>({
    resolver: zodResolver(publishFormSchema),
    defaultValues: { ...defaults, trialFirst: false, trialGraduation: "", confirmRetry: false },
    mode: "onChange",
  });
  const { register, formState: { errors, isDirty } } = form;
  const selected = form.watch("channelIds");
  const caption = form.watch("caption");
  const blockReason = publishBlockReason(channels, selected.length);
  // Said only when a destination on this list is one of the gated channels. The server refuses those either way.
  const publishingOff = channels.some((channel) => channelOff(channel.id));
  const handOnly = deliverByHandOnly(channels);
  // A destination whose last receipt is uncertain is not sent again unless the person says they checked the platform.
  const uncertain = uncertainDestinations(results);
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
          <DialogTitle className="text-section font-semibold">Publish this variant</DialogTitle>
          <DialogDescription id={descriptionId} className="mt-2 text-sm text-fg-muted">
            Choose where it goes. Nothing is sent to a destination you do not select. Each destination returns its own receipt.
          </DialogDescription>
          {publishingOff ? <div className="mt-3"><OffNotice what="Posting to Instagram, YouTube and TikTok" instead="Export the video from Library and post it yourself. Those destinations refuse and send nothing." /></div> : null}

          <form
            noValidate
            className="contents"
            onSubmit={form.handleSubmit((values) => {
              // A trial applies only while the Instagram Reel destination is selected. Otherwise the choice is not sent.
              const trial: PublishTrial = values.channelIds.includes("instagram-reels") && values.trialFirst && values.trialGraduation
                ? { graduationStrategy: values.trialGraduation }
                : null;
              // The confirmation counts only while a destination is uncertain, and only for this one send.
              onConfirm(values.channelIds, values.caption, trial, values.confirmRetry && uncertain.length > 0);
              // The dialog stays open to show the receipts, so the sent choice becomes the baseline. Closing does not ask. The confirmation
              // is cleared: a new uncertain receipt needs a new check.
              form.reset({ ...values, confirmRetry: false });
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
                          "flex min-h-11 items-start gap-3 rounded-sharp border p-3 text-sm",
                          checked ? "border-fg-primary bg-overlay" : "border-hairline bg-raised",
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
                          {!channel.connected ? <span id={reasonId} className="block text-xs text-fg-muted">{channel.reason ?? "This destination is not connected, so it cannot be chosen."}</span> : null}
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

          <dl className="mt-4 grid gap-2 rounded-sharp border border-hairline bg-overlay p-3 text-sm sm:grid-cols-2">
            <div><dt className="text-fg-muted">Creative</dt><dd className="font-semibold">{target.title || target.kind}</dd></div>
            <div><dt className="text-fg-muted">Format</dt><dd>{target.kind} · {frame.label}{target.durationMs ? ` · ${(target.durationMs / 1000).toFixed(1)} s` : ""}</dd></div>
            <div className="sm:col-span-2"><dt className="text-fg-muted">Destinations</dt><dd>{selectedNames.length > 0 ? selectedNames.join(", ") : "None selected"}</dd></div>
          </dl>

          {selected.includes("instagram-reels") ? (
            <fieldset className="mt-4 space-y-2 rounded-sharp border border-hairline p-3 text-sm">
              <legend className="text-sm font-semibold">Instagram trial</legend>
              <label className="flex min-h-11 items-start gap-3">
                <input type="checkbox" className="mt-1 size-4 shrink-0" {...register("trialFirst")} disabled={pending} />
                <span>Post the Reel as a trial first. A trial is shared only with people who do not follow the account.</span>
              </label>
              {form.watch("trialFirst") ? (
                <Field
                  label="How the trial graduates"
                  hint="The Graph API does not graduate a trial reel, and it documents no field that reports graduation. A MANUAL trial graduates when a person does it in the Instagram app. An SS_PERFORMANCE trial graduates when Instagram decides it has performed well. Until Meridian observes a graduation, it does not record the feed step as done."
                  error={errors.trialGraduation?.message}
                >
                  <SelectInput {...register("trialGraduation")} disabled={pending}>
                    <option value="">Choose a graduation strategy</option>
                    <option value="MANUAL">MANUAL: a person graduates it in the Instagram app</option>
                    <option value="SS_PERFORMANCE">SS_PERFORMANCE: Instagram graduates it if it performs well</option>
                  </SelectInput>
                </Field>
              ) : null}
            </fieldset>
          ) : null}

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

          {uncertain.length > 0 ? (
            <div role="group" aria-label="Check before sending again" className="mt-4 space-y-2 rounded-sharp border border-border-strong p-3 text-sm">
              <p className="font-semibold">An earlier post may have gone out</p>
              <p className="text-fg-muted">Nothing was sent again. Open the destination, look for the post, and send again only if it is not there.</p>
              <label className="flex min-h-11 items-start gap-3">
                <input type="checkbox" className="mt-1 size-4 shrink-0" {...register("confirmRetry")} disabled={pending} />
                <span>{confirmRetryLabel(uncertain.map((item) => providerLabel(item.platform)))}</span>
              </label>
            </div>
          ) : null}

          {handOnly ? (
            <div className="mt-4 space-y-2 rounded-sharp border border-hairline bg-overlay p-3 text-sm">
              <p className="font-semibold">Deliver by hand</p>
              <p className="text-fg-muted">
                {onExportPackage
                  ? "Nothing is sent while no destination is connected. Post the video yourself with this caption, or export the package for manual posting."
                  : "Nothing is sent while no destination is connected. Post the video yourself with this caption."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {caption.trim() ? <CopyButton value={caption} label="Copy caption" /> : null}
                {onExportPackage ? <Button type="button" variant="quiet" onClick={onExportPackage}>Export package</Button> : null}
              </div>
            </div>
          ) : null}

          {results ? (
            <div role="status" aria-live="polite" className="mt-4 space-y-2 rounded-sharp border border-hairline p-3 text-sm">
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

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-4">
            {blockReason && !pending ? <DisabledReason id="publish-destination-reason" className="basis-full text-right">{blockReason}</DisabledReason> : null}
            <Button type="button" variant="quiet" disabled={pending} onClick={() => dismiss.requestOpenChange(false)}>Close</Button>
            <Button type="submit" disabled={pending || blockReason !== null} aria-describedby={blockReason && !pending ? "publish-destination-reason" : undefined}>
              {pending ? "Publishing…" : `Publish to ${selected.length} destination${selected.length === 1 ? "" : "s"}`}
            </Button>
          </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
