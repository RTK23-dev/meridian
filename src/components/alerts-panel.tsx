import { useState, type FormEvent } from "react";
import { refreshAlerts, saveDeliveryTarget } from "@/lib/meridian/alerts/actions";
import { Button, ErrorState, Notice, Panel, Skeleton, TextInput, errorText } from "@/components/ui";
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
    success: (_vars, result) => result.raised === 0 ? "No alert condition is currently true." : `${result.raised} alert condition${result.raised === 1 ? "" : "s"} recorded.`,
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
    success: (_vars, result) => result.status === "saved" ? "Webhook target saved." : "Delivery target cleared.",
    onSuccess: (result) => {
      setNote(result.status === "saved" ? "Webhook target saved. It has not been called yet." : "Delivery target cleared.");
    },
  });
  const pending = check.isPending || saveTarget.isPending;
  const error = [check.error, saveTarget.error, acknowledge.error].find(Boolean);

  // A failed read is shown as a failure. It is never shown as "not configured", because that would be a claim about the target.
  if (alerts.isError && !data) {
    return <ErrorState message="Alerts could not be loaded." onRetry={() => void alerts.refetch()} />;
  }
  if (!data) {
    return <Panel><div role="status" aria-label="Loading alerts" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div></Panel>;
  }

  return (
    <Panel>
      <h2 className="font-display text-2xl">Alerts</h2>
      <p className="mt-2 text-sm text-muted">
        These are in-app records. External paging is {data.target}. A webhook is queued for the worker only after you save an https target. Nothing is marked delivered until that target accepts it.
      </p>
      {note ? <p className="mt-2 text-sm" role="status">{note}</p> : null}
      {error ? <Notice>{errorText(error)}</Notice> : null}
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
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const url = String(new FormData(event.currentTarget).get("url") ?? "");
          void saveTarget.mutateAsync(url).catch(() => undefined);
        }}
      >
        <label className="block min-w-64 flex-1 text-sm font-semibold">
          Webhook URL
          <TextInput name="url" type="url" placeholder="https://example.com/alerts" className="mt-1" />
        </label>
        <Button type="submit" variant="quiet" disabled={pending}>Save target</Button>
      </form>
    </Panel>
  );
}
