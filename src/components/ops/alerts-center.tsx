import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { AlertCircle, CheckCheck, Clock3, Info, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, Field, PageHeader, ScreenSkeleton, SelectInput, StatusBadge, TextInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { deliveryTargetSchema, type DeliveryTargetInput } from "@/components/forms/client-schemas";
import { useWorkspace } from "@/components/workspace";
import { ALERT_LIST_LIMIT } from "@/lib/navigation/model";
import { hasRole } from "@/lib/meridian/access";
import { refreshAlerts, saveDeliveryTarget } from "@/lib/meridian/alerts/actions";
import { qk } from "@/lib/query/keys";
import { useAcknowledgeAlert, useAlertsQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { AdminOnlyNotice, RefusalNotice } from "./ops-shared";
import {
  ALERT_FILTER_OPTIONS, type AlertFilter, type AlertRow, deliveryCopy, filterAlerts, openAlertSummary, readableTime, severityCopy, targetCopy,
} from "./alerts-model";

const ACKNOWLEDGE_KEY = (organizationId: string) => ["mutation", "alert.acknowledge", organizationId] as const;

export function AlertsCenter() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const alerts = useAlertsQuery(organizationId, canAdmin && !!organizationId);
  const acknowledge = useAcknowledgeAlert(organizationId);
  const acknowledging = usePendingVariables<string>(ACKNOWLEDGE_KEY(organizationId));
  const [filter, setFilter] = useState<AlertFilter>("open");
  const [note, setNote] = useState<string | null>(null);
  // The webhook URL is checked with the server's own delivery rule, so a refused URL shows next to the field.
  const targetForm = useForm<DeliveryTargetInput>({ resolver: zodResolver(deliveryTargetSchema), defaultValues: { url: "" }, mode: "onChange" });
  const urlValue = targetForm.watch("url");

  const check = useScopedMutation({
    mutationKey: ["mutation", "alerts.check", organizationId],
    mutationFn: () => refreshAlerts({ data: { organizationId } }),
    // A check can write alert rows and queue a delivery job, so both keys refresh.
    invalidate: () => [qk.alerts(organizationId), qk.jobs(organizationId)],
    onSuccess: (result) => {
      setNote(result.raised === 0
        ? "No alert condition is true right now."
        : `${result.raised} alert condition${result.raised === 1 ? "" : "s"} recorded. Paging: ${result.paging}.`);
    },
  });
  const saveTarget = useScopedMutation({
    mutationKey: ["mutation", "alerts.target", organizationId],
    mutationFn: (url: string) => saveDeliveryTarget({ data: { organizationId, url } }),
    invalidate: () => [qk.alerts(organizationId)],
    onSuccess: (result) => {
      // The URL is cleared once saved. It is not shown again, as the copy below says.
      targetForm.reset({ url: "" });
      setNote(result.status === "saved" ? "Webhook target saved. It has not been called yet." : "Webhook target removed. Alerts are not sent anywhere.");
    },
  });
  const busy = check.isPending || saveTarget.isPending;
  const failures = [check.error, saveTarget.error, acknowledge.error].filter((error): error is Error => Boolean(error));

  if (!workspace?.active) return null;
  if (!canAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Alerts center" description="Alerts Meridian raised for this workspace." />
        <AdminOnlyNotice screen="The alerts center" role={role} />
      </div>
    );
  }

  // A failed read is shown as a failure. It is never shown as "not configured", because that would be a claim about the target.
  if (alerts.isError && !alerts.data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Alerts center" />
        <PlainErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
      </div>
    );
  }
  if (!alerts.data) return <ScreenSkeleton label="Loading alerts" shape="rows" />;

  const data = alerts.data;
  const target = targetCopy(data.target);
  const visible = filterAlerts(data.alerts, filter);

  const submitTarget = targetForm.handleSubmit((values) => {
    setNote(null);
    void saveTarget.mutateAsync(values.url).catch(() => undefined);
  });

  return (
    <div className="space-y-8">
      <UnsavedChangesGuard dirty={targetForm.formState.isDirty} />
      <PageHeader
        title="Alerts center"
        description="Alerts Meridian raised for this workspace. Acknowledging one records that a person has seen it. It changes no threshold and no provider setting."
        actions={<Button type="button" variant="secondary" size="md" loading={check.isPending} disabled={busy} onClick={() => void check.mutateAsync().catch(() => undefined)}>Check systems</Button>}
      />

      {note ? <p role="status" className="text-sm">{note}</p> : null}
      {failures.map((error, index) => <RefusalNotice key={index} error={error} />)}

      <section aria-labelledby="alerts-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="alerts-heading" className="text-section font-semibold">Alerts</h2>
            <p className="text-sm text-fg-muted">{openAlertSummary(data.alerts, ALERT_LIST_LIMIT)}</p>
          </div>
          <Field label="Show">
            <SelectInput value={filter} onChange={(event) => setFilter(event.target.value as AlertFilter)}>
              {ALERT_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </SelectInput>
          </Field>
        </div>

        {data.alerts.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">No alerts are stored. Check systems to record any condition that is true now.</p></Card>
        ) : visible.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">No {filter === "open" ? "open" : "acknowledged"} alerts. Change the filter to see the others.</p></Card>
        ) : (
          <ul className="space-y-3">
            {visible.map((alert) => (
              <AlertItem
                key={alert.id}
                alert={alert}
                busy={acknowledging.includes(alert.id)}
                onAcknowledge={() => void acknowledge.mutateAsync(alert.id).catch(() => undefined)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="delivery-heading" className="space-y-4">
        <h2 id="delivery-heading" className="text-section font-semibold">Delivery target</h2>
        <Card className="space-y-4">
          <StatusBadge status={target.connected ? "connected" : "not_connected"} label="Webhook target" />
          <p className="text-sm text-fg-muted">{target.text}</p>
          {/* noValidate: a refused URL is explained next to the field, not by the browser's own popup. */}
          <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={submitTarget} onKeyDown={(event) => submitOnShortcut(event)}>
            <div className="min-w-64 flex-1">
              <Field label="Webhook URL" hint="Must start with https. Plain http is allowed only for localhost. The URL is not shown again after you save it." error={targetForm.formState.errors.url?.message}>
                <TextInput {...targetForm.register("url")} type="url" maxLength={500} placeholder="https://example.com/alerts" />
              </Field>
            </div>
            <Button type="submit" variant="secondary" size="md" loading={saveTarget.isPending} disabled={busy || urlValue.trim() === ""}>Save target</Button>
            {target.connected ? (
              <Button type="button" variant="quiet" size="md" disabled={busy} onClick={() => void saveTarget.mutateAsync("").catch(() => undefined)}>Remove target</Button>
            ) : null}
            <FormDiscardBar dirty={targetForm.formState.isDirty} subject="webhook target" onDiscard={() => targetForm.reset({ url: "" })} className="basis-full" />
          </form>
        </Card>
      </section>
    </div>
  );
}

function AlertItem({ alert, busy, onAcknowledge }: { alert: AlertRow; busy: boolean; onAcknowledge: () => void }) {
  const severity = severityCopy(alert.severity);
  const SeverityIcon = severity.icon === "critical" ? AlertCircle : severity.icon === "warning" ? TriangleAlert : Info;
  return (
    <li className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={severity.tone}><SeverityIcon aria-hidden="true" className="size-3.5" /><span>{severity.label}</span></Badge>
        <span className="break-all font-mono text-xs text-fg-muted">{alert.code}</span>
        <Badge variant={alert.acknowledged ? "success" : "info"}>
          {alert.acknowledged ? <CheckCheck aria-hidden="true" className="size-3.5" /> : <Clock3 aria-hidden="true" className="size-3.5" />}
          <span>{alert.acknowledged ? "Acknowledged" : "Open"}</span>
        </Badge>
      </div>
      <p className="text-sm">{alert.detail || "No detail is recorded for this alert."}</p>
      <dl className="grid gap-2 text-xs text-fg-muted sm:grid-cols-3">
        <div><dt className="font-semibold text-fg">First seen</dt><dd>{readableTime(alert.firstSeen)}</dd></div>
        <div><dt className="font-semibold text-fg">Last seen</dt><dd>{readableTime(alert.lastSeen)}</dd></div>
        <div><dt className="font-semibold text-fg">Delivery</dt><dd>{deliveryCopy(alert.deliveryStatus)}</dd></div>
      </dl>
      {alert.acknowledged ? null : (
        <Button type="button" variant="secondary" size="md" loading={busy} aria-label={`Acknowledge ${alert.code} alert`} onClick={onAcknowledge}>
          Acknowledge
        </Button>
      )}
    </li>
  );
}
