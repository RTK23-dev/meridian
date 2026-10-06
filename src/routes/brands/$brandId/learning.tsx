import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Notice, Panel, SelectInput, Skeleton, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { getPerformanceRowsForExport, setPerformanceSchedule } from "@/lib/meridian/performance/actions";
import { refreshLearning, setOrganizationLearning, sharePatternWithOrganization } from "@/lib/meridian/machine";
import { useLearningQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { downloadCsv } from "@/lib/csv";
import { performanceScheduleSchema, type PerformanceSchedule, type PerformanceScheduleFields } from "@/lib/meridian/schemas/performance-schedule";

export const Route = createFileRoute("/brands/$brandId/learning")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Learning brandId={brandId} />
  );
}

function Learning({ brandId }: { brandId: string }) {
  const learningQuery = useLearningQuery(brandId);
  const data = learningQuery.data ?? null;
  const [note, setNote] = useState<string | null>(null);
  const busy = useBusy([qk.learning(brandId), qk.studio(brandId), qk.opportunities(brandId)]);
  const scheduleForm = useForm<PerformanceScheduleFields, unknown, PerformanceSchedule>({
    resolver: zodResolver(performanceScheduleSchema),
    defaultValues: { provider: "meta", creativeId: "", externalAdId: "", currency: "USD", timezone: "UTC", startDate: "", endDate: "", everySeconds: "3600" },
    mode: "onBlur",
  });
  const scheduleDirty = scheduleForm.formState.isDirty;
  useEffect(() => {
    if (!scheduleDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [scheduleDirty]);

  async function saveSchedule(values: PerformanceSchedule) {
    if (!data?.organizationId) return;
    const saved = await busy.run(async () => {
      const result = await setPerformanceSchedule({ data: { organizationId: data.organizationId!, brandId, ...values } });
      setNote(`${result.reason} Schedule ${result.id}.`);
    });
    if (saved) scheduleForm.reset();
  }

  if (learningQuery.error) return <ErrorState message={errorText(learningQuery.error)} onRetry={() => void learningQuery.refetch()} />;
  if (!data) return <div role="status" aria-label="Loading learning" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(data.role, "member");
  const canAdmin = hasRole(data.role, "admin");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-3">
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Learning</p>
          <h1 className="font-display text-4xl">What the results changed</h1>
          <p className="text-muted">{data.policy}</p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
          <Button type="button" variant="quiet" disabled={busy.pending} onClick={() => void busy.run(async () => {
            const rows = await getPerformanceRowsForExport({ data: { brandId } });
            if (!rows.length) { setNote("No performance rows are stored for this brand."); return; }
            downloadCsv("meridian-performance.csv", [
              { key: "id", label: "Observation ID" }, { key: "creativeId", label: "Creative ID" }, { key: "experimentId", label: "Experiment ID" },
              { key: "platform", label: "Platform" }, { key: "impressions", label: "Impressions" }, { key: "reach", label: "Reach" },
              { key: "clicks", label: "Clicks" }, { key: "conversions", label: "Conversions" }, { key: "spendCents", label: "Spend cents" },
              { key: "revenueCents", label: "Revenue cents" }, { key: "observedOn", label: "Observed on" }, { key: "source", label: "Source" },
              { key: "createdAt", label: "Recorded at" },
            ], rows);
            setNote(`Exported ${rows.length} stored performance rows.`);
          })}>Export performance rows</Button>
          <Button
            disabled={busy.pending}
            onClick={() => {
              void busy.run(async () => {
                const result = await refreshLearning({ data: { brandId } });
                setNote(result.patterns === 0
                  ? "No pattern met the sample rule. Queued learning jobs for this brand were still closed. Nothing was invented."
                  : `${result.patterns} pattern${result.patterns === 1 ? "" : "s"} stored. Queued learning jobs were drained. Score opportunities again to use them.`);
              });
            }}
          >
            Recompute patterns
          </Button>
          </div>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      <Panel>
        <h2 className="font-display text-2xl">Whose results count</h2>
        <p className="mt-2 text-sm text-muted">
          This brand's own patterns are always used. Patterns another brand in this workspace explicitly shared are used only if you turn that on. Global patterns are never used.
        </p>
        {canEdit ? (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.useOrganizationLearning}
              onChange={(event) => {
                const enabled = event.target.checked;
                void busy.run(async () => {
                  await setOrganizationLearning({ data: { brandId, enabled } });
                });
              }}
            />
            Use shared workspace patterns
          </label>
        ) : null}
      </Panel>
      {data.patterns.length === 0 ? (
        <Panel>No learned patterns. Enter performance on at least three creatives that share an attribute, with 300 impressions in that bucket, then recompute. CTR, conversion rate, and ROAS are calculated from those rows. Nothing is filled in for you.</Panel>
      ) : (
        <>
        <Panel>
          <h2 className="font-display text-2xl">Stored pattern lift</h2>
          <p className="mt-1 text-sm text-muted">Values use the stored lift field as-is; no confidence interval is shown because this data does not contain one.</p>
          <div role="img" aria-label={`Stored pattern lift values: ${data.patterns.slice(0, 8).map((pattern) => `${pattern.attribute} ${pattern.value}: ${pattern.lift}`).join("; ")}`} className="mt-4 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.patterns.slice(0, 8).map((pattern) => ({ label: `${pattern.attribute}: ${pattern.value}`, lift: pattern.lift }))} margin={{ left: 8, right: 12, bottom: 42 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" angle={-24} textAnchor="end" interval={0} height={64} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="lift" name="Stored lift" fill="var(--color-accent)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <ul className="space-y-3">
          {data.patterns.map((pattern) => (
            <li key={pattern.id} className="rounded-lg border border-line bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">{pattern.scope} · {pattern.state} · {pattern.metric} · n={pattern.sampleSize}</p>
              <p className="mt-2">{pattern.summary}</p>
              {canAdmin && pattern.scope === "brand" ? (
                <Button
                  className="mt-3"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = await sharePatternWithOrganization({ data: { brandId, patternId: pattern.id } });
                      setNote(result.status === "shared" ? "Shared with this workspace. Other brands still ignore it until they opt in." : "That pattern was already shared.");
                    });
                  }}
                >
                  Share with workspace
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        </>
      )}
      {canAdmin && data.organizationId ? (
        <Panel>
          <h2 className="font-display text-2xl">Performance schedule</h2>
          <p className="mt-2 text-sm text-muted">This only enqueues a sync after the provider has a successful connection. The worker fetches the metrics. Disconnect stops the schedule.</p>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2"
            onSubmit={scheduleForm.handleSubmit(saveSchedule)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}
          >
            <Field label="Provider" error={scheduleForm.formState.errors.provider?.message}>
              <SelectInput {...scheduleForm.register("provider")}>
                <option value="meta">Meta</option>
                <option value="tiktok">TikTok</option>
                <option value="google">Google Ads</option>
              </SelectInput>
            </Field>
            <Field label="Cadence in seconds" error={scheduleForm.formState.errors.everySeconds?.message}><TextInput {...scheduleForm.register("everySeconds")} type="text" inputMode="numeric" required /></Field>
            <Field label="Creative id" error={scheduleForm.formState.errors.creativeId?.message}><TextInput {...scheduleForm.register("creativeId")} required /></Field>
            <Field label="External ad id" error={scheduleForm.formState.errors.externalAdId?.message}><TextInput {...scheduleForm.register("externalAdId")} required /></Field>
            <Field label="Currency" error={scheduleForm.formState.errors.currency?.message}><TextInput {...scheduleForm.register("currency")} required maxLength={3} /></Field>
            <Field label="Timezone" error={scheduleForm.formState.errors.timezone?.message}><TextInput {...scheduleForm.register("timezone")} required /></Field>
            <Field label="Start date" error={scheduleForm.formState.errors.startDate?.message}><TextInput {...scheduleForm.register("startDate")} type="date" required /></Field>
            <Field label="End date" error={scheduleForm.formState.errors.endDate?.message}><TextInput {...scheduleForm.register("endDate")} type="date" required /></Field>
            {scheduleDirty ? <div role="status" className="md:col-span-2 flex items-center justify-between rounded-md border border-warning bg-warning-soft p-3 text-sm"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => scheduleForm.reset()}>Discard</Button></div> : null}
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy.pending || scheduleForm.formState.isSubmitting}>{scheduleForm.formState.isSubmitting ? "Saving…" : "Save performance schedule"}</Button>
            </div>
          </form>
        </Panel>
      ) : null}
      <Panel>
        {data.rejections.length === 0 ? <p className="mt-2 text-muted">No stored rejections.</p> : (
          <ul className="mt-3 space-y-1 text-sm">
            {data.rejections.map((item) => (
              <li key={item.reasonCode}>{item.reasonCode.replaceAll("_", " ")} · {item.count}</li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Decision log</h2>
        {data.decisions.length === 0 ? <p className="mt-2 text-muted">No decisions yet.</p> : (
          <ul className="mt-3 space-y-3 text-sm">
            {data.decisions.map((item) => (
              <li key={item.id}>
                <span className="font-semibold">{item.decision}</span> · {item.question} · {item.subject} · p {item.probability.toFixed(2)}
                <span className="block text-muted">{item.reasons[0]}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
