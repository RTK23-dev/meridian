import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, ErrorState, Notice, Panel, Skeleton, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { getPerformanceRowsForExport, setPerformanceSchedule } from "@/lib/meridian/performance/actions";
import { refreshLearning, setOrganizationLearning, sharePatternWithOrganization } from "@/lib/meridian/machine";
import { useLearningQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { downloadCsv } from "@/lib/csv";

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
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const provider = form.get("provider");
              if (provider !== "meta" && provider !== "tiktok" && provider !== "google") return;
              void busy.run(async () => {
                const result = await setPerformanceSchedule({
                  data: {
                    organizationId: data.organizationId,
                    brandId,
                    provider,
                    creativeId: String(form.get("creativeId") ?? ""),
                    externalAdId: String(form.get("externalAdId") ?? ""),
                    currency: String(form.get("currency") ?? ""),
                    timezone: String(form.get("timezone") ?? ""),
                    startDate: String(form.get("startDate") ?? ""),
                    endDate: String(form.get("endDate") ?? ""),
                    everySeconds: Number(form.get("everySeconds") ?? 3600),
                  },
                });
                setNote(`${result.reason} Schedule ${result.id}.`);
              });
            }}
          >
            <label className="block text-sm font-semibold">
              Provider
              <select name="provider" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" defaultValue="meta">
                <option value="meta">Meta</option>
                <option value="tiktok">TikTok</option>
                <option value="google">Google Ads</option>
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Cadence in seconds
              <input name="everySeconds" type="text" inputMode="decimal" defaultValue={3600} required autoComplete="off" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Creative id
              <input name="creativeId" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              External ad id
              <input name="externalAdId" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Currency
              <input name="currency" required defaultValue="USD" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Timezone
              <input name="timezone" required defaultValue="UTC" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Start date
              <input name="startDate" type="date" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              End date
              <input name="endDate" type="date" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy.pending}>Save performance schedule</Button>
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
