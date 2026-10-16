import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, errorText, Field, Input } from "@/components/ui";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { getSleepMode, saveSleepMode, type SleepNightView } from "@/lib/meridian/factory/sleep-actions";

/**
 * Sleep mode: a nightly gather, grade and plan that stops before production. An admin turns it on, sets the night time, the time
 * zone and the niche. Everyone sees the morning summaries. Nothing here produces or publishes.
 */
export function SleepModePanel({ brandId, canAdmin }: { brandId: string; canAdmin: boolean }) {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const key = userScopedQueryKey(user?.id, ["sleep-mode", brandId]);
  const sleep = useQuery({ queryKey: key, queryFn: () => getSleepMode({ data: { brandId } }) });

  const [enabled, setEnabled] = useState(false);
  const [nightTime, setNightTime] = useState("03:00");
  const [timeZone, setTimeZone] = useState("UTC");
  const [niche, setNiche] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded || !sleep.data) return;
    const saved = sleep.data.settings;
    setEnabled(saved?.enabled ?? false);
    setNightTime(saved?.nightTime ?? "03:00");
    setTimeZone(saved?.timeZone ?? browserZone());
    setNiche(saved?.niche ?? "");
    setLoaded(true);
  }, [loaded, sleep.data]);

  const save = useMutation({
    mutationFn: () => saveSleepMode({ data: { brandId, enabled, nightTime, timeZone, niche } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <section aria-labelledby="sleep-mode-heading" className="space-y-4 rounded-lg border border-border p-4">
      <div className="space-y-1">
        <h2 id="sleep-mode-heading" className="text-base font-semibold">Sleep mode</h2>
        <p className="text-sm text-muted">
          Each night Meridian gathers, grades and plans for the niche below, and stops before production. A person approves produce
          in the run. Ten per cent of planned items are held out and recorded for the learning step.
        </p>
      </div>

      {sleep.isPending ? <p className="text-sm text-muted">Loading sleep mode...</p> : null}
      {sleep.error ? <p role="alert" className="text-sm text-danger">{errorText(sleep.error)}</p> : null}

      {sleep.data ? (
        <div className="space-y-2 text-sm">
          <p>
            {sleep.data.nextRun
              ? `Sleep mode is on. The next night is at ${formatInstant(sleep.data.nextRun)}.`
              : "Sleep mode is off. No night runs until an admin turns it on."}
          </p>
          {canAdmin ? (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <label className="flex items-center gap-2 sm:col-span-2">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                <span>Turn sleep mode on</span>
              </label>
              <Field label="Night time" hint="HH:MM, 24-hour clock">
                <Input value={nightTime} onChange={(event) => setNightTime(event.target.value)} placeholder="03:00" />
              </Field>
              <Field label="Time zone" hint="An IANA zone, such as Europe/London">
                <Input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="Europe/London" />
              </Field>
              <Field label="Niche" hint="The default niche the nightly gather uses">
                <Input value={niche} onChange={(event) => setNiche(event.target.value)} placeholder="for example, sleep aids" />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving..." : "Save sleep mode"}</Button>
              </div>
              {save.error ? <p role="alert" className="text-sm text-danger sm:col-span-2">{errorText(save.error)}</p> : null}
            </form>
          ) : (
            <p className="text-muted">Only an admin can change sleep mode. You can read its mornings below.</p>
          )}
        </div>
      ) : null}

      {sleep.data && sleep.data.nights.length === 0 ? (
        <p className="text-sm text-muted">No night has run yet. The first morning summary appears here.</p>
      ) : null}
      {sleep.data && sleep.data.nights.length > 0 ? (
        <ul className="space-y-3">
          {sleep.data.nights.map((night) => (
            <NightLine key={night.id} night={night} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function NightLine({ night }: { night: SleepNightView }) {
  const counts = night.counts;
  return (
    <li className="space-y-1 rounded-md border border-border p-3 text-sm">
      <p className="font-medium">
        {night.nightKey}: {statusWords(night.status)}
      </p>
      {night.summary ? <p>{night.summary}</p> : null}
      {night.reason && night.reason !== night.summary ? <p className="text-muted">{night.reason}</p> : null}
      <p className="text-muted">
        Picked {counts.picks ?? "not recorded"}, planned {counts.planned ?? "not recorded"}, held out {counts.holdout ?? "not recorded"}.
      </p>
      {night.failures.length > 0 ? (
        <ul className="list-disc pl-5 text-danger">
          {night.failures.map((failure) => (
            <li key={failure}>{failure}</li>
          ))}
        </ul>
      ) : null}
      {night.holdoutItemIds.length > 0 ? (
        <p className="break-all text-muted">Holdout items: {night.holdoutItemIds.join(", ")}</p>
      ) : null}
    </li>
  );
}

function statusWords(status: string): string {
  if (status === "planned") return "planned, waiting for approval of produce";
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return status;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatInstant(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}
