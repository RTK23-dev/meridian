import { useEffect, useState, type FormEvent } from "react";
import { acknowledgeStoredAlert, getAlerts, refreshAlerts, saveDeliveryTarget } from "@/lib/meridian/alerts/actions";
import { Button, Notice, Panel, TextInput, errorText } from "@/components/ui";
import { StatusText } from "@/components/status";

export function AlertsPanel({ organizationId }: { organizationId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getAlerts>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reload() {
    return getAlerts({ data: { organizationId } }).then(setData);
  }

  useEffect(() => {
    let cancelled = false;
    getAlerts({ data: { organizationId } })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  async function run(task: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel>
      <h2 className="font-display text-2xl">Alerts</h2>
      <p className="mt-2 text-sm text-muted">
        These are in-app records. External paging is {data?.target ?? "not configured"}. A webhook is queued for the worker only after you save an https target. Nothing is marked delivered until that target accepts it.
      </p>
      {note ? <p className="mt-2 text-sm" role="status">{note}</p> : null}
      {error ? <Notice>{error}</Notice> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="quiet"
          disabled={pending}
          onClick={() => {
            void run(async () => {
              const result = await refreshAlerts({ data: { organizationId } });
              setNote(result.raised === 0
                ? "No alert condition is currently true."
                : `${result.raised} alert condition${result.raised === 1 ? "" : "s"} recorded. Paging: ${result.paging}.`);
              await reload();
            });
          }}
        >
          Check systems
        </Button>
      </div>
      {data && data.alerts.length === 0 ? <p className="mt-3 text-sm text-muted">No stored alerts.</p> : null}
      <ul className="mt-3 space-y-3">
        {data?.alerts.map((alert) => (
          <li key={alert.id} className="rounded-md border border-line p-3">
            <StatusText status={alert.severity} label={alert.code} description={`${alert.detail} First seen ${alert.firstSeen}. Last seen ${alert.lastSeen}. Delivery: ${alert.deliveryStatus}.`} />
            <p className="text-sm">{alert.acknowledged ? "Acknowledged" : "Open"}</p>
            {alert.acknowledged ? null : (
              <Button
                type="button"
                className="mt-2"
                variant="quiet"
                disabled={pending}
                onClick={() => {
                  void run(async () => {
                    await acknowledgeStoredAlert({ data: { organizationId, alertId: alert.id } });
                    setNote("Acknowledged. Thresholds and providers were not changed.");
                    await reload();
                  });
                }}
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
          void run(async () => {
            const result = await saveDeliveryTarget({ data: { organizationId, url } });
            setNote(result.status === "saved" ? "Webhook target saved. It has not been called yet." : "Delivery target cleared.");
            await reload();
          });
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
