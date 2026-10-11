import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Card, DisabledReason, EmptyState, ErrorState, Field, SelectInput, Skeleton, Stat, Input } from "@/components/ui";
import { PlainErrorMessage, PlainErrorNotice } from "@/components/plain-error";
import { copy, plainError, type PlainError } from "@/lib/copy";
import { downloadCsv } from "@/lib/csv";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getPerformanceRowsForExport } from "@/lib/meridian/performance/actions";
import { useRecordTelemetry, useScopedMutation, useSyncTelemetry, useTelemetryQuery } from "@/lib/query/hooks";
import { userScopedQueryKey } from "@/lib/query/keys";
import { ChartFigure, ValueBarChart, ValueLineChart, ValueTable } from "./charts";
import { hasSample, formatSignedPercent } from "./lift";
import { NOT_ENOUGH_RESULTS, PERFORMANCE_METRICS, formatImpressions, formatMetric, groupByCreative, groupByDay, sumRows, type PerformanceMetric } from "./metrics";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { telemetryFormSchema, telemetryPayload, type TelemetryFormFields } from "./telemetry-input";

const ROW_LIMIT = 10_000;
const TELEMETRY_SUMMARY_LIMIT = 100;

/** Stored performance rows for the charts. The server allows members only, so this is never called for viewers. */
function usePerformanceRows(brandId: string, enabled: boolean) {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id ?? null;
  return useQuery({
    queryKey: userScopedQueryKey(userId, ["performance-rows", brandId]),
    queryFn: () => getPerformanceRowsForExport({ data: { brandId } }),
    enabled: !isPending && !!user && enabled && !!brandId,
  });
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Not recorded";
}

export function PerformancePanel({ brandId, canEdit, active }: { brandId: string; canEdit: boolean; active: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [metric, setMetric] = useState<PerformanceMetric>("ctr");
  const [showForm, setShowForm] = useState(false);
  // Queries wait until this tab is open, so the page does not load every tab's data at once.
  const telemetryQuery = useTelemetryQuery(brandId, undefined, active);
  const rowsQuery = usePerformanceRows(brandId, active && canEdit);
  const syncTelemetry = useSyncTelemetry(brandId);
  const exportRows = useScopedMutation({
    mutationKey: ["mutation", "learning.export", brandId],
    mutationFn: () => getPerformanceRowsForExport({ data: { brandId } }),
    onSuccess: (rows) => {
      if (!rows.length) {
        setNote("No performance rows are stored for this brand.");
        return;
      }
      downloadCsv("meridian-performance.csv", [
        { key: "id", label: "Observation ID" }, { key: "creativeId", label: "Creative ID" }, { key: "experimentId", label: "Experiment ID" },
        { key: "platform", label: "Platform" }, { key: "impressions", label: "Impressions" }, { key: "reach", label: "Reach" },
        { key: "clicks", label: "Clicks" }, { key: "conversions", label: "Conversions" }, { key: "spendCents", label: "Spend cents" },
        { key: "revenueCents", label: "Revenue cents" }, { key: "observedOn", label: "Observed on" }, { key: "source", label: "Source" },
        { key: "createdAt", label: "Recorded at" },
      ], rows);
      setNote(`Exported ${rows.length} stored performance rows.`);
    },
  });

  const summary = telemetryQuery.data?.summary;
  const records = telemetryQuery.data?.records ?? [];
  const telemetryLoaded = telemetryQuery.isSuccess;
  const rows = rowsQuery.data ?? [];
  // The chart sums take numbers. A value that was never recorded adds nothing, so it is passed as 0 to these sums only. The
  // export reads the rows as they are, so an unrecorded value stays an empty cell there.
  const chartRows = rows.map((row) => ({
    ...row,
    impressions: row.impressions ?? 0,
    reach: row.reach ?? 0,
    clicks: row.clicks ?? 0,
    conversions: row.conversions ?? 0,
    spendCents: row.spendCents ?? 0,
    revenueCents: row.revenueCents ?? 0,
  }));
  const metricName = PERFORMANCE_METRICS.find((entry) => entry.key === metric)?.label ?? "Metric";
  const metricShort = metric === "ctr" ? "CTR" : metric === "conversion_rate" ? "Conversion rate" : "ROAS";

  async function handleSync() {
    try {
      const result = await syncTelemetry.mutateAsync();
      setNote(`Synchronized ${result.syncedRecords} records to Bayesian flywheel. Learned ${result.patternsLearned} patterns. Top hooks: ${result.topHooks.join(", ") || "none"}.`);
    } catch (error) {
      setNote(plainError(error).message);
    }
  }

  // Summary figures: a missing or zero-sample value is "Not enough results", never 0.
  const loadingText = telemetryQuery.isError ? "Not loaded" : "Loading";
  const kpiViews = !telemetryLoaded ? loadingText : summary && summary.totalViews > 0 ? summary.totalViews.toLocaleString() : NOT_ENOUGH_RESULTS;
  const kpiRetention = !telemetryLoaded ? loadingText : summary && summary.avgHookRetention3s > 0 ? `${(summary.avgHookRetention3s * 100).toFixed(1)}%` : NOT_ENOUGH_RESULTS;
  const kpiCompletion = !telemetryLoaded ? loadingText : summary && summary.avgCompletionRate > 0 ? `${(summary.avgCompletionRate * 100).toFixed(1)}%` : NOT_ENOUGH_RESULTS;
  const platforms = summary ? Object.keys(summary.byPlatform) : [];
  const kpiPlatforms = !telemetryLoaded ? loadingText : platforms.length > 0 ? platforms.map(humanize).join(", ") : NOT_ENOUGH_RESULTS;

  // Performance charts, from stored rows.
  const creativePoints = groupByCreative(chartRows, metric).slice(0, 12);
  const dayPoints = groupByDay(chartRows, metric);
  const rowTotals = sumRows(chartRows);
  const creativeSummary = `${metricName} by creative, for the ${creativePoints.length} creatives with the most impressions: ${creativePoints.map((point) => `${point.label} ${formatMetric(metric, point.value)}`).join("; ")}.`;
  const daySummary = `${metricName} by day, oldest first: ${dayPoints.map((point) => `${point.label} ${formatMetric(metric, point.value)}`).join("; ")}.`;

  // Attribute chart, from the telemetry posteriors (hook type).
  const posteriors = summary?.posteriorsByHookType ?? [];
  const hookData = posteriors.map((item) => ({
    label: humanize(item.featureValue),
    value: hasSample(item.sampleCount) ? item.posterior.mean : null,
  }));
  const hookSummary = `Average 3-second hook retention by hook type: ${hookData.map((item) => `${item.label} ${item.value === null ? NOT_ENOUGH_RESULTS : `${(item.value * 100).toFixed(1)}%`}`).join("; ")}.`;

  return <div className="space-y-8">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-section font-semibold">Performance</h2>
        <p className="text-sm text-fg-muted">Stored results for this brand's creatives, plus telemetry rows you record. A blank value stays blank. It is not counted as zero.</p>
      </div>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={exportRows.isPending} onClick={() => void exportRows.mutateAsync().catch(() => undefined)}>Export performance rows</Button>
          <Button type="button" variant="secondary" aria-expanded={showForm} aria-controls={showForm ? "telemetry-form" : undefined} onClick={() => setShowForm((open) => !open)}>
            {showForm ? "Close telemetry form" : "Add telemetry row"}
          </Button>
          <Button type="button" disabled={syncTelemetry.isPending || records.length === 0} aria-describedby={records.length === 0 ? "telemetry-sync-reason" : undefined} onClick={() => void handleSync()}>
            {syncTelemetry.isPending ? "Syncing to JEV Brain…" : "Sync to JEV Brain"}
          </Button>
          {records.length === 0 ? <DisabledReason id="telemetry-sync-reason" className="basis-full">Add a telemetry row first. There is nothing to sync yet.</DisabledReason> : null}
        </div>
      ) : null}
    </div>
    {note ? <p role="status" className="text-sm text-fg-muted">{note}</p> : null}
    {exportRows.error ? <PlainErrorNotice error={exportRows.error} /> : null}
    {syncTelemetry.error ? <PlainErrorNotice error={syncTelemetry.error} /> : null}

    {telemetryQuery.isError && !telemetryLoaded ? <ErrorState message="Telemetry could not be loaded." onRetry={() => void telemetryQuery.refetch()} /> : null}
    <section aria-labelledby="telemetry-summary-title" className="space-y-3">
      <div>
        <h3 id="telemetry-summary-title" className="text-base font-semibold">Telemetry summary</h3>
        <p className="text-sm text-fg-muted">Uses up to the latest {TELEMETRY_SUMMARY_LIMIT} telemetry rows. {copy.learning.startingEstimates} Older rows count for less, with a 14-day half-life.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Card><Stat label="Tracked views" value={kpiViews} description={telemetryLoaded ? `${summary?.totalRecords ?? 0} telemetry rows` : undefined} /></Card>
        <Card><Stat label="Average 3-second hook retention" value={kpiRetention} description="Simple average of rows that have a value" /></Card>
        <Card><Stat label="Average completion rate" value={kpiCompletion} description="Simple average of rows that have a value" /></Card>
        <Card><Stat label="Platforms" value={<span className="text-base font-semibold">{kpiPlatforms}</span>} /></Card>
      </div>
    </section>

    {canEdit && showForm ? <ManualTelemetryForm brandId={brandId} onSaved={(message) => { setShowForm(false); setNote(message); }} onCancel={() => setShowForm(false)} /> : null}

    <section aria-labelledby="performance-charts-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-1">
          <h3 id="performance-charts-title" className="text-base font-semibold">Charts</h3>
          <p className="text-sm text-fg-muted">
            Built from stored performance rows{rows.length >= ROW_LIMIT ? `, the most recent ${ROW_LIMIT.toLocaleString()}` : ""}. A creative or day with no impressions is left blank, not plotted as zero.
          </p>
        </div>
        {canEdit ? (
          <Field label="Metric" className="min-w-64">
            <SelectInput value={metric} onChange={(event) => setMetric(event.target.value as PerformanceMetric)}>
              {PERFORMANCE_METRICS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
            </SelectInput>
          </Field>
        ) : null}
      </div>

      {!canEdit ? (
        <EmptyState title="Stored performance rows are for members" reason="Your role can see the telemetry summary above. Ask a workspace member to review creative-level rows." />
      ) : rowsQuery.isError ? (
        <ErrorState message={plainError(rowsQuery.error).message} detail={plainError(rowsQuery.error).raw} onRetry={() => void rowsQuery.refetch()} />
      ) : rowsQuery.isPending ? (
        <Skeleton variant="card" className="h-72" />
      ) : rows.length === 0 ? (
        <EmptyState title="No performance rows stored" reason="Enter results on a creative in Library, or wait for a scheduled sync. Nothing is filled in for you." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartFigure
            id="performance-by-creative"
            title={`${metricShort} by creative`}
            description={`Top ${creativePoints.length} creatives by impressions. ${rowTotals.rows.toLocaleString()} stored rows in total.`}
            summary={creativeSummary}
            table={<ValueTable
              caption={`${metricName} by creative`}
              headers={["Creative", "Impressions", "Clicks", "Conversions", "Spend (cents)", metricShort]}
              rows={creativePoints.map((point) => [point.label, formatImpressions(point.totals.impressions), point.totals.clicks.toLocaleString(), point.totals.conversions.toLocaleString(), point.totals.spendCents.toLocaleString(), formatMetric(metric, point.value)])}
            />}
          >
            <ValueBarChart data={creativePoints.map((point) => ({ label: point.label, value: point.value }))} name={metricShort} format={(value) => formatMetric(metric, value)} />
          </ChartFigure>
          <ChartFigure
            id="performance-over-time"
            title={`${metricShort} over time`}
            description="One point per observed day. Days with no impressions are gaps."
            summary={daySummary}
            table={<ValueTable
              caption={`${metricName} by day`}
              headers={["Day", "Impressions", metricShort]}
              rows={dayPoints.map((point) => [point.label, formatImpressions(point.totals.impressions), formatMetric(metric, point.value)])}
            />}
          >
            <ValueLineChart data={dayPoints.map((point) => ({ label: point.label, value: point.value }))} name={metricShort} format={(value) => formatMetric(metric, value)} />
          </ChartFigure>
        </div>
      )}

      {telemetryQuery.isError ? null : !telemetryLoaded ? <Skeleton variant="card" className="h-72" /> : posteriors.length === 0 ? (
        <EmptyState title="No hook-type results yet" reason="Record telemetry rows with a hook type and a 3-second retention value to compare hook types." />
      ) : (
        <ChartFigure
          id="hook-type-retention"
          title="Hook retention by hook type"
          description="Posterior mean of 3-second hook retention, from recorded telemetry. Samples with no value are gaps."
          summary={hookSummary}
          table={<ValueTable
            caption="Hook retention by hook type"
            headers={["Hook type", "Samples", "Mean retention", "90% credible interval", "Lift vs baseline", "Chance it beats baseline"]}
            rows={posteriors.map((item) => [
              humanize(item.featureValue),
              item.sampleCount.toLocaleString(),
              hasSample(item.sampleCount) ? `${(item.posterior.mean * 100).toFixed(1)}%` : NOT_ENOUGH_RESULTS,
              hasSample(item.sampleCount) ? `${(item.credibleInterval90.low * 100).toFixed(1)}% to ${(item.credibleInterval90.high * 100).toFixed(1)}%` : NOT_ENOUGH_RESULTS,
              hasSample(item.sampleCount) ? formatSignedPercent(item.lift) : NOT_ENOUGH_RESULTS,
              hasSample(item.sampleCount) ? `${(item.probabilityBeatsBaseline * 100).toFixed(0)}%` : NOT_ENOUGH_RESULTS,
            ])}
          />}
        >
          <ValueBarChart data={hookData} name="Mean 3-second retention" format={(value) => `${(value * 100).toFixed(0)}%`} />
        </ChartFigure>
      )}
    </section>
  </div>;
}

function ManualTelemetryForm({ brandId, onSaved, onCancel }: { brandId: string; onSaved: (message: string) => void; onCancel: () => void }) {
  const recordTelemetry = useRecordTelemetry(brandId);
  const [formError, setFormError] = useState<PlainError | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const form = useForm<TelemetryFormFields>({
    resolver: zodResolver(telemetryFormSchema),
    defaultValues: { platform: "", sourceType: "organic", creativeId: "", views: "", hookRetention3s: "", completionRate: "", engagements: "", shares: "", hookType: "", angle: "" },
    mode: "onBlur",
  });
  const { register, formState } = form;
  const dirty = formState.isDirty;

  async function submit(values: TelemetryFormFields) {
    setFormError(null);
    try {
      await recordTelemetry.mutateAsync(telemetryPayload(values));
      onSaved("Recorded new performance observation into telemetry store.");
    } catch (error) {
      setFormError(plainError(error));
    }
  }

  // Cancel closes the row. A row with typed values asks first.
  function requestCancel() {
    if (dirty) setCancelRequested(true);
    else onCancel();
  }

  return <form id="telemetry-form" onSubmit={form.handleSubmit(submit)} onKeyDown={(event) => submitOnShortcut(event)} noValidate aria-labelledby="telemetry-form-title" className="space-y-6 rounded-lg border border-border bg-surface p-5">
    <UnsavedChangesGuard dirty={dirty} />
    <div className="space-y-1">
      <h3 id="telemetry-form-title" className="text-base font-semibold text-fg">Add a telemetry row</h3>
      <p className="text-sm text-fg-muted">Enter numbers you measured. Leave an optional field blank if you do not have it; it is stored as unknown, not as 0.</p>
    </div>
    {formError ? <PlainErrorMessage message={formError.message} raw={formError.raw} /> : null}

    <fieldset className="grid gap-4 sm:grid-cols-3">
      <legend className="mb-2 text-sm font-semibold text-fg">Where it ran</legend>
      <Field label="Platform" required error={formState.errors.platform?.message}>
        <SelectInput {...register("platform")} required>
          <option value="">Choose a platform</option>
          <option value="tiktok">TikTok</option>
          <option value="instagram">Instagram</option>
          <option value="meta">Meta (Reels / Ads)</option>
          <option value="youtube">YouTube Shorts</option>
          <option value="x">X / Twitter</option>
        </SelectInput>
      </Field>
      <Field label="Source type">
        <SelectInput {...register("sourceType")}>
          <option value="organic">Organic social</option>
          <option value="paid">Paid campaign</option>
          <option value="hybrid">Hybrid / whitelisted</option>
        </SelectInput>
      </Field>
      <Field label="Creative ID (optional)">
        <Input {...register("creativeId")} placeholder="cr_..." />
      </Field>
    </fieldset>

    <fieldset className="grid gap-4 sm:grid-cols-3">
      <legend className="mb-2 text-sm font-semibold text-fg">Measured results</legend>
      <Field label="Views" required error={formState.errors.views?.message}>
        <Input {...register("views")} type="number" inputMode="numeric" required />
      </Field>
      <Field label="3-second hook retention (0 to 1)" required error={formState.errors.hookRetention3s?.message}>
        <Input {...register("hookRetention3s")} type="number" step="0.01" inputMode="decimal" required />
      </Field>
      <Field label="Completion rate (0 to 1, optional)" error={formState.errors.completionRate?.message}>
        <Input {...register("completionRate")} type="number" step="0.01" inputMode="decimal" />
      </Field>
      <Field label="Engagements (optional)" error={formState.errors.engagements?.message}>
        <Input {...register("engagements")} type="number" inputMode="numeric" />
      </Field>
      <Field label="Shares (optional)" error={formState.errors.shares?.message}>
        <Input {...register("shares")} type="number" inputMode="numeric" />
      </Field>
    </fieldset>

    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-semibold text-fg">Creative attributes</legend>
      <Field label="Hook type">
        <SelectInput {...register("hookType")}>
          <option value="">Not recorded</option>
          <option value="contrarian">Contrarian</option>
          <option value="question">Question</option>
          <option value="statistic">Statistic</option>
          <option value="visual_shock">Visual shock</option>
          <option value="pov">POV</option>
          <option value="curiosity_gap">Curiosity gap</option>
        </SelectInput>
      </Field>
      <Field label="Creative angle (optional)">
        <Input {...register("angle")} placeholder="founder_story, how_to..." />
      </Field>
    </fieldset>

    <UnsavedChangesBar
      dirty={dirty}
      subject="telemetry row"
      confirming={cancelRequested}
      onConfirmingChange={setCancelRequested}
      onDiscard={onCancel}
    />
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="secondary" onClick={requestCancel}>Cancel</Button>
      <Button type="submit" disabled={recordTelemetry.isPending || formState.isSubmitting}>{recordTelemetry.isPending || formState.isSubmitting ? "Recording…" : "Save telemetry row"}</Button>
    </div>
  </form>;
}
