import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BrandNav } from "@/components/brand-nav";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { getPerformanceRowsForExport, setPerformanceSchedule } from "@/lib/meridian/performance/actions";
import { refreshLearning, setOrganizationLearning, sharePatternWithOrganization } from "@/lib/meridian/machine";
import { useLearningQuery, useScopedMutation, useTelemetryQuery, useRecordTelemetry, useSyncTelemetry, usePendingVariables } from "@/lib/query/hooks";
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
  const learningKey = (name: string) => ["mutation", `learning.${name}`, brandId] as const;
  const exportRows = useScopedMutation({
    mutationKey: learningKey("export"),
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
  const saveScheduleMutation = useScopedMutation({
    mutationKey: learningKey("schedule"),
    mutationFn: (values: PerformanceSchedule) => setPerformanceSchedule({ data: { organizationId: data?.organizationId ?? "", brandId, ...values } }),
    onSuccess: (result) => {
      setNote(`${result.reason} Schedule ${result.id}.`);
      scheduleForm.reset();
    },
  });
  const recompute = useScopedMutation({
    mutationKey: learningKey("recompute"),
    mutationFn: () => refreshLearning({ data: { brandId } }),
    // Recomputing rewrites the stored patterns, which studio and the brand overview read.
    invalidate: () => [qk.learning(brandId), qk.studio(brandId), qk.machine(brandId)],
    onSuccess: (result) => setNote(result.patterns === 0
      ? "No pattern met the sample rule. Queued learning jobs for this brand were still closed. Nothing was invented."
      : `${result.patterns} pattern${result.patterns === 1 ? "" : "s"} stored. Queued learning jobs were drained. Score opportunities again to use them.`),
  });
  const toggleSharedPatterns = useScopedMutation({
    mutationKey: learningKey("organization-toggle"),
    mutationFn: (enabled: boolean) => setOrganizationLearning({ data: { brandId, enabled } }),
    invalidate: () => [qk.learning(brandId), qk.studio(brandId)],
    success: (enabled) => enabled ? "Shared workspace patterns are on." : "Shared workspace patterns are off.",
  });
  const sharePattern = useScopedMutation({
    mutationKey: learningKey("share"),
    mutationFn: (patternId: string) => sharePatternWithOrganization({ data: { brandId, patternId } }),
    invalidate: () => [qk.learning(brandId)],
    onSuccess: (result) => setNote(result.status === "shared" ? "Shared with this workspace. Other brands still ignore it until they opt in." : "That pattern was already shared."),
  });
  const sharingPatterns = usePendingVariables<string>(learningKey("share"));
  const learningActions = [exportRows, saveScheduleMutation, recompute, toggleSharedPatterns, sharePattern];
  const failures = learningActions.map((action) => action.error).filter((error): error is Error => Boolean(error));
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
    await saveScheduleMutation.mutateAsync(values).catch(() => undefined);
  }

  if (learningQuery.isError && !data) return <ErrorState message={errorText(learningQuery.error)} onRetry={() => void learningQuery.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading learning" shape="cards" />;
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
          <Button type="button" variant="quiet" disabled={exportRows.isPending} onClick={() => void exportRows.mutateAsync().catch(() => undefined)}>Export performance rows</Button>
          <Button
            disabled={recompute.isPending}
            onClick={() => {
              void recompute.mutateAsync().catch(() => undefined);
            }}
          >
            Recompute patterns
          </Button>
          </div>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {failures.map((error, index) => <Notice key={index}>{errorText(error)}</Notice>)}
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
              disabled={toggleSharedPatterns.isPending}
              onChange={(event) => {
                void toggleSharedPatterns.mutateAsync(event.target.checked).catch(() => undefined);
              }}
            />
            Use shared workspace patterns
          </label>
        ) : null}
      </Panel>

      <TelemetryFlywheelPanel brandId={brandId} canEdit={canEdit} />

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
                  disabled={sharingPatterns.includes(pattern.id)}
                  onClick={() => {
                    void sharePattern.mutateAsync(pattern.id).catch(() => undefined);
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
              <Button type="submit" disabled={saveScheduleMutation.isPending || scheduleForm.formState.isSubmitting}>{scheduleForm.formState.isSubmitting ? "Saving…" : "Save performance schedule"}</Button>
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

function TelemetryFlywheelPanel({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const telemetryQuery = useTelemetryQuery(brandId);
  const recordTelemetry = useRecordTelemetry(brandId);
  const syncTelemetry = useSyncTelemetry(brandId);
  const [showIngestForm, setShowIngestForm] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const [platform, setPlatform] = useState("tiktok");
  const [sourceType, setSourceType] = useState<"organic" | "paid" | "hybrid">("organic");
  const [creativeId, setCreativeId] = useState("");
  const [views, setViews] = useState("10000");
  const [hookRetention3s, setHookRetention3s] = useState("0.65");
  const [completionRate, setCompletionRate] = useState("0.35");
  const [engagements, setEngagements] = useState("850");
  const [shares, setShares] = useState("210");
  const [hookType, setHookType] = useState("contrarian");
  const [angle, setAngle] = useState("founder_story");

  const summary = (telemetryQuery.data as any)?.summary;
  const records = (telemetryQuery.data as any)?.records ?? [];
  // Until telemetry loads, the figures are unknown, not zero. A failed load is shown as a failure.
  const telemetryLoaded = telemetryQuery.isSuccess;

  async function handleRecord(e: React.FormEvent) {
    e.preventDefault();
    try {
      await recordTelemetry.mutateAsync({
        platform,
        sourceType,
        creativeId: creativeId.trim() || undefined,
        views: Number(views) || 0,
        hookRetention3s: Number(hookRetention3s) || 0,
        completionRate: Number(completionRate) || 0,
        engagements: Number(engagements) || 0,
        shares: Number(shares) || 0,
        hookType: hookType.trim() || undefined,
        angle: angle.trim() || undefined,
      });
      setShowIngestForm(false);
      setSyncMessage("Recorded new performance observation into telemetry store.");
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Failed to record telemetry");
    }
  }

  async function handleSync() {
    try {
      const res = await syncTelemetry.mutateAsync();
      setSyncMessage(
        `Synchronized ${res.syncedRecords} records to Bayesian flywheel. Learned ${res.patternsLearned} patterns. Top hooks: ${res.topHooks.join(", ") || "none"}.`
      );
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    }
  }

  return (
    <Panel className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl">Multi-Channel Telemetry & JEV Bayesian Flywheel</h2>
          <p className="mt-1 text-sm text-muted">
            Continuous Bayesian parameter updating with exponential recency decay (14-day half-life).
            Feeds organic viral retention and paid attribution directly into JEV cognitive priors.
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="quiet"
              onClick={() => setShowIngestForm(!showIngestForm)}
            >
              {showIngestForm ? "Close Form" : "Ingest Telemetry"}
            </Button>
            <Button
              type="button"
              disabled={syncTelemetry.isPending || records.length === 0}
              onClick={() => void handleSync()}
            >
              {syncTelemetry.isPending ? "Syncing Flywheel…" : "Sync to JEV Brain"}
            </Button>
          </div>
        )}
      </div>

      {syncMessage && (
        <div className="rounded-md border border-line bg-surface p-3 text-sm text-foreground">
          {syncMessage}
        </div>
      )}

      {telemetryQuery.isError && !telemetryLoaded ? <ErrorState message="Telemetry could not be loaded." onRetry={() => void telemetryQuery.refetch()} /> : null}
      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-line bg-surface p-3">
          <p className="text-xs uppercase tracking-wider text-muted">Tracked Views</p>
          <p className="mt-1 font-display text-2xl font-semibold">
            {!telemetryLoaded ? "—" : summary?.totalViews ? summary.totalViews.toLocaleString() : "0"}
          </p>
          <p className="text-xs text-muted">{telemetryLoaded ? `${summary?.totalRecords ?? 0} observation rows` : telemetryQuery.isError ? "Not loaded" : "Loading"}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <p className="text-xs uppercase tracking-wider text-muted">Avg 3s Hook Retention</p>
          <p className="mt-1 font-display text-2xl font-semibold text-accent">
            {summary?.avgHookRetention3s ? `${(summary.avgHookRetention3s * 100).toFixed(1)}%` : "—"}
          </p>
          <p className="text-xs text-muted">Decay-weighted</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <p className="text-xs uppercase tracking-wider text-muted">Avg Completion Rate</p>
          <p className="mt-1 font-display text-2xl font-semibold">
            {summary?.avgCompletionRate ? `${(summary.avgCompletionRate * 100).toFixed(1)}%` : "—"}
          </p>
          <p className="text-xs text-muted">Full video watches</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <p className="text-xs uppercase tracking-wider text-muted">Active Platforms</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {!telemetryLoaded ? (
              <span className="text-sm text-muted">—</span>
            ) : summary?.byPlatform && Object.keys(summary.byPlatform).length > 0 ? (
              Object.keys(summary.byPlatform).map((plat) => (
                <span key={plat} className="rounded bg-line/40 px-1.5 py-0.5 text-xs font-mono capitalize">
                  {plat}
                </span>
              ))
            ) : (
              <span className="text-sm text-muted">None</span>
            )}
          </div>
        </div>
      </div>

      {/* Quick Ingest Form */}
      {showIngestForm && canEdit && (
        <form onSubmit={handleRecord} className="rounded-lg border border-line bg-surface p-4 space-y-4">
          <h3 className="font-semibold text-sm uppercase tracking-wider text-brass">Manual Telemetry Ingest</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Platform">
              <SelectInput value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="tiktok">TikTok</option>
                <option value="instagram">Instagram</option>
                <option value="meta">Meta (Reels / Ads)</option>
                <option value="youtube">YouTube Shorts</option>
                <option value="x">X / Twitter</option>
              </SelectInput>
            </Field>
            <Field label="Source Type">
              <SelectInput value={sourceType} onChange={(e) => setSourceType(e.target.value as any)}>
                <option value="organic">Organic Social</option>
                <option value="paid">Paid Campaign</option>
                <option value="hybrid">Hybrid / Whitelisted</option>
              </SelectInput>
            </Field>
            <Field label="Creative ID (Optional)">
              <TextInput value={creativeId} onChange={(e) => setCreativeId(e.target.value)} placeholder="cr_..." />
            </Field>
            <Field label="Views">
              <TextInput type="number" value={views} onChange={(e) => setViews(e.target.value)} required />
            </Field>
            <Field label="3s Hook Retention (0 - 1.0)">
              <TextInput type="number" step="0.01" value={hookRetention3s} onChange={(e) => setHookRetention3s(e.target.value)} required />
            </Field>
            <Field label="Completion Rate (0 - 1.0)">
              <TextInput type="number" step="0.01" value={completionRate} onChange={(e) => setCompletionRate(e.target.value)} />
            </Field>
            <Field label="Engagements">
              <TextInput type="number" value={engagements} onChange={(e) => setEngagements(e.target.value)} />
            </Field>
            <Field label="Shares">
              <TextInput type="number" value={shares} onChange={(e) => setShares(e.target.value)} />
            </Field>
            <Field label="Hook Type">
              <SelectInput value={hookType} onChange={(e) => setHookType(e.target.value)}>
                <option value="contrarian">Contrarian</option>
                <option value="question">Question</option>
                <option value="statistic">Statistic</option>
                <option value="visual_shock">Visual Shock</option>
                <option value="pov">POV</option>
                <option value="curiosity_gap">Curiosity Gap</option>
              </SelectInput>
            </Field>
            <Field label="Creative Angle">
              <TextInput value={angle} onChange={(e) => setAngle(e.target.value)} placeholder="founder_story, how_to..." />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="quiet" onClick={() => setShowIngestForm(false)}>Cancel</Button>
            <Button type="submit" disabled={recordTelemetry.isPending}>
              {recordTelemetry.isPending ? "Recording…" : "Save Telemetry Row"}
            </Button>
          </div>
        </form>
      )}

      {/* Bayesian Feature Posteriors: Hook Types */}
      {summary?.posteriorsByHookType && summary.posteriorsByHookType.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm uppercase tracking-wider text-brass">
              Bayesian Hook Retention Posteriors
            </h3>
            <span className="text-xs text-muted">Baseline: {(summary.posteriorsByHookType[0].baselineRate * 100).toFixed(1)}%</span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface/50 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="p-3">Hook Archetype</th>
                  <th className="p-3 text-right">Samples</th>
                  <th className="p-3 text-right">Effective Views</th>
                  <th className="p-3 text-right">Posterior Mean</th>
                  <th className="p-3 text-right">90% Credible Interval</th>
                  <th className="p-3 text-right">Lift vs Base</th>
                  <th className="p-3 text-right">P(Beat Base)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {summary.posteriorsByHookType.map((post: any) => (
                  <tr key={post.featureValue} className="hover:bg-surface/30">
                    <td className="p-3 font-medium capitalize">{post.featureValue.replaceAll("_", " ")}</td>
                    <td className="p-3 text-right text-muted">{post.sampleCount}</td>
                    <td className="p-3 text-right text-muted">{post.effectiveTrials.toLocaleString()}</td>
                    <td className="p-3 text-right font-mono font-semibold text-accent">
                      {(post.posterior.mean * 100).toFixed(1)}%
                    </td>
                    <td className="p-3 text-right font-mono text-xs text-muted">
                      [{(post.credibleInterval90.low * 100).toFixed(1)}% – {(post.credibleInterval90.high * 100).toFixed(1)}%]
                    </td>
                    <td className={`p-3 text-right font-mono text-sm ${post.lift >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                      {post.lift >= 0 ? `+${(post.lift * 100).toFixed(1)}%` : `${(post.lift * 100).toFixed(1)}%`}
                    </td>
                    <td className="p-3 text-right font-mono text-xs">
                      {(post.probabilityBeatsBaseline * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}

