import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { refreshAlerts, saveDeliveryTarget } from "@/lib/meridian/alerts/actions";
import { Button, ErrorState, Field, Panel, Skeleton, TextInput } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { deliveryTargetSchema, type DeliveryTargetInput } from "@/components/forms/client-schemas";
import { StatusText } from "@/components/status";
import { qk } from "@/lib/query/keys";
import { useAcknowledgeAlert, useAlertsQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";

const ACKNOWLEDGE_KEY = (organizationId: string) => ["mutation", "alert.acknowledge", organizationId] as const;

export function AlertsPanel({ organizationId }: { organizationId: string }) {
  const alerts = useAlertsQuery(organizationId);
  const data = alerts.data ?? null;
  const [note, setNote] = useState<string | null>(null);
  const acknowledge = useAcknowledgeAlert(organizationId);
  const acknowledging = usePendingVariables<string>(ACKNOWLEDGE_KEY(organizationId));
  const check = useScopedMutation({
    mutationKey: ["mutation", "alerts.check", organizationId],
    mutationFn: () => refreshAlerts({ data: { organizationId } }),
    // A check can write alert rows and queue a delivery job, so both keys refresh.
    invalidate: () => [qk.alerts(organizationId), qk.jobs(organizationId)],
    onSuccess: (result) => {
      setNote(result.raised === 0
        ? "No alert condition is currently true."
        : `${result.raised} alert condition${result.raised === 1 ? "" : "s"} recorded. Paging: ${result.paging}.`);
    },
  });
  const saveTarget = useScopedMutation({
    mutationKey: ["mutation", "alerts.target", organizationId],
    mutationFn: (url: string) => saveDeliveryTarget({ data: { organizationId, url } }),
    invalidate: () => [qk.alerts(organizationId)],
    onSuccess: (result) => {
      setNote(result.status === "saved" ? "Webhook target saved. It has not been called yet." : "Delivery target cleared.");
    },
  });
  const pending = check.isPending || saveTarget.isPending;
  const error = [check.error, saveTarget.error, acknowledge.error].find(Boolean);
  const targetForm = useForm<DeliveryTargetInput>({ resolver: zodResolver(deliveryTargetSchema), defaultValues: { url: "" }, mode: "onBlur" });

  // A failed read is shown as a failure. It is never shown as "not configured", because that would be a claim about the target.
  if (alerts.isError && !data) {
    return <ErrorState message="Alerts could not be loaded." onRetry={() => void alerts.refetch()} />;
  }
  if (!data) {
    return <Panel><div role="status" aria-label="Loading alerts" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div></Panel>;
  }

  return (
    <Panel>
      <UnsavedChangesGuard dirty={targetForm.formState.isDirty} />
      <h2 className="font-display text-2xl">Alerts</h2>
      <p className="mt-2 text-sm text-muted">
        These are in-app records. External paging is {data.target}. A webhook is queued for the worker only after you save an https target. Nothing is marked delivered until that target accepts it.
      </p>
      {note ? <p className="mt-2 text-sm" role="status">{note}</p> : null}
      {error ? <PlainErrorNotice error={error} /> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="quiet"
          disabled={pending}
          onClick={() => void check.mutateAsync().catch(() => undefined)}
        >
          Check systems
        </Button>
      </div>
      {data.alerts.length === 0 ? <p className="mt-3 text-sm text-muted">No stored alerts.</p> : null}
      <ul className="mt-3 space-y-3">
        {data.alerts.map((alert) => (
          <li key={alert.id} className="rounded-md border border-line p-3">
            <StatusText status={alert.severity} label={alert.code} description={`${alert.detail} First seen ${alert.firstSeen}. Last seen ${alert.lastSeen}. Delivery: ${alert.deliveryStatus}.`} />
            <p className="text-sm">{alert.acknowledged ? "Acknowledged" : "Open"}</p>
            {alert.acknowledged ? null : (
              <Button
                type="button"
                className="mt-2"
                variant="quiet"
                disabled={acknowledging.includes(alert.id)}
                onClick={() => void acknowledge.mutateAsync(alert.id).catch(() => undefined)}
              >
                Acknowledge
              </Button>
            )}
          </li>
        ))}
      </ul>
      {/* noValidate: the rule is shown next to the field in plain words, not by the browser's own popup. */}
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        noValidate
        onSubmit={targetForm.handleSubmit((values) => {
          void saveTarget.mutateAsync(values.url).then(() => targetForm.reset({ url: values.url }, { keepValues: true }), () => undefined);
        })}
        onKeyDown={(event) => submitOnShortcut(event)}
      >
        <Field label="Webhook URL" error={targetForm.formState.errors.url?.message} className="min-w-64 flex-1">
          <TextInput {...targetForm.register("url")} type="url" placeholder="https://example.com/alerts" />
        </Field>
        <Button type="submit" variant="quiet" disabled={pending || targetForm.formState.isSubmitting}>{pending || targetForm.formState.isSubmitting ? "Saving…" : "Save target"}</Button>
        <FormDiscardBar dirty={targetForm.formState.isDirty} subject="webhook target" onDiscard={() => targetForm.reset({ url: "" })} className="basis-full" />
      </form>
    </Panel>
  );
}
