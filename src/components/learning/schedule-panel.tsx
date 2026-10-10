import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button, Card, Field, SelectInput, TextInput } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { setPerformanceSchedule } from "@/lib/meridian/performance/actions";
import { useScopedMutation } from "@/lib/query/hooks";
import { performanceScheduleSchema, type PerformanceSchedule, type PerformanceScheduleFields } from "@/lib/meridian/schemas/performance-schedule";

const defaults: PerformanceScheduleFields = {
  provider: "meta",
  creativeId: "",
  externalAdId: "",
  currency: "USD",
  timezone: "UTC",
  startDate: "",
  endDate: "",
  everySeconds: "3600",
};

export function SchedulePanel({ brandId, organizationId, canAdmin }: { brandId: string; organizationId: string; canAdmin: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const saveSchedule = useScopedMutation({
    mutationKey: ["mutation", "learning.schedule", brandId],
    mutationFn: (values: PerformanceSchedule) => setPerformanceSchedule({ data: { organizationId, brandId, ...values } }),
    onSuccess: (result) => {
      setNote(`${result.reason} Schedule ${result.id}.`);
      form.reset();
    },
  });
  const form = useForm<PerformanceScheduleFields, unknown, PerformanceSchedule>({
    resolver: zodResolver(performanceScheduleSchema),
    defaultValues: defaults,
    mode: "onBlur",
  });
  const dirty = form.formState.isDirty;
  const errors = form.formState.errors;

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [dirty]);

  async function submit(values: PerformanceSchedule) {
    await saveSchedule.mutateAsync(values).catch(() => undefined);
  }

  if (!canAdmin) {
    return <Card>
      <h2 className="text-section font-semibold">Performance schedule</h2>
      <p className="mt-2 text-sm text-fg-muted">Only workspace admins can set a performance schedule. The schedule enqueues a provider sync after a successful connection.</p>
    </Card>;
  }

  return <Card className="space-y-4">
    <div className="space-y-1">
      <h2 className="text-section font-semibold">Performance schedule</h2>
      <p className="max-w-2xl text-sm text-fg-muted">This only enqueues a sync after the provider has a successful connection. The worker fetches the metrics. Disconnect stops the schedule.</p>
    </div>
    <form
      className="grid gap-6"
      onSubmit={form.handleSubmit(submit)}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}
    >
      <fieldset className="grid gap-4 md:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold text-fg">Ad to sync</legend>
        <Field label="Provider" error={errors.provider?.message}>
          <SelectInput {...form.register("provider")}>
            <option value="meta">Meta</option>
            <option value="tiktok">TikTok</option>
            <option value="google">Google Ads</option>
          </SelectInput>
        </Field>
        <Field label="Creative ID" error={errors.creativeId?.message} required>
          <TextInput {...form.register("creativeId")} required />
        </Field>
        <Field label="Provider ad ID" error={errors.externalAdId?.message} required>
          <TextInput {...form.register("externalAdId")} required />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <legend className="mb-2 text-sm font-semibold text-fg">Dates and cadence</legend>
        <Field label="Start date" error={errors.startDate?.message} required>
          <TextInput {...form.register("startDate")} type="date" required />
        </Field>
        <Field label="End date" error={errors.endDate?.message} required>
          <TextInput {...form.register("endDate")} type="date" required />
        </Field>
        <Field label="Cadence in seconds" hint="60 to 2,592,000 seconds" error={errors.everySeconds?.message}>
          <TextInput {...form.register("everySeconds")} type="text" inputMode="numeric" required />
        </Field>
        <Field label="Timezone" error={errors.timezone?.message} required>
          <TextInput {...form.register("timezone")} required />
        </Field>
        <Field label="Currency" hint="Three-letter code" error={errors.currency?.message} required>
          <TextInput {...form.register("currency")} required maxLength={3} />
        </Field>
      </fieldset>

      {note ? <p role="status" className="text-sm text-fg-muted">{note}</p> : null}
      {saveSchedule.error ? <PlainErrorNotice error={saveSchedule.error} /> : null}
      {dirty ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm">
          <span>Unsaved changes</span>
          <Button type="button" variant="secondary" onClick={() => form.reset()}>Discard</Button>
        </div>
      ) : null}
      <div>
        <Button type="submit" disabled={saveSchedule.isPending || form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Saving…" : "Save performance schedule"}
        </Button>
      </div>
    </form>
  </Card>;
}
