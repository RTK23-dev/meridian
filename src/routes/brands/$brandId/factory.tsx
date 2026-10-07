import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Panel, SelectInput, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { FACTORY_LEVEL_DETAIL, FACTORY_LEVEL_LABELS, type FactoryLevel } from "@/lib/meridian/factory/autopilot";
import { setFactoryControls, setKillSwitch, startFactoryRun } from "@/lib/meridian/factory/actions";
import { useFactoryQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/brands/$brandId/factory")({ component: Page });

function dollars(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

function Page() {
  const { brandId } = Route.useParams();
  return <FactoryPage brandId={brandId} />;
}

function FactoryPage({ brandId }: { brandId: string }) {
  const query = useFactoryQuery(brandId);
  const board = query.data ?? null;
  const busy = useBusy([qk.factory(brandId), qk.jobs(board?.organizationId ?? ""), qk.market(brandId)]);
  const [niche, setNiche] = useState("");
  const [daily, setDaily] = useState("");
  const [total, setTotal] = useState("");
  const [level, setLevel] = useState("0");
  const [ceiling, setCeiling] = useState("1");
  const [note, setNote] = useState<string | null>(null);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!board) return <div role="status" aria-label="Loading factory" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;

  const canEdit = hasRole(board.role, "member");
  const canAdmin = hasRole(board.role, "admin");
  const killOn = board.killSwitch.workspace || board.killSwitch.brand;

  return (
    <div className="space-y-6">
      <BrandNav brandId={brandId} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Factory</p>
          <h1 className="font-display text-4xl">Watch, copy the framework, never the ad</h1>
          <p className="text-muted">{board.levelDetail} Autopilot is {FACTORY_LEVEL_LABELS[board.level as FactoryLevel]} (ceiling {FACTORY_LEVEL_LABELS[board.ceiling as FactoryLevel]}).</p>
        </div>
        {killOn ? <p className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm font-semibold" role="status">Kill switch is on. Live ads stay paused.</p> : null}
      </header>
      {board.note ? <p className="text-sm text-muted">{board.note}</p> : null}
      {note ? <p className="text-sm text-muted" role="status">{note}</p> : null}

      <Tabs defaultValue="discover">
        <TabsList>
          <TabsTrigger value="discover">Discover</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="production">Production</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="tests">Live tests</TabsTrigger>
          <TabsTrigger value="learnings">Learnings</TabsTrigger>
        </TabsList>

        <TabsContent value="discover" className="space-y-6">
          <Panel className="space-y-4 p-5">
            <h2 className="font-display text-2xl">Sources</h2>
            <ul className="grid gap-3 md:grid-cols-2">
              {board.sources.map((source) => (
                <li key={source.id} className="rounded-md border border-line p-3">
                  <p className="font-semibold">{source.label}</p>
                  <p className="text-sm text-muted">{source.connected ? "CONFIGURED" : "NOT_CONNECTED"} · {source.note}</p>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">Ad Library snapshot video is {board.snapshotMediaEnabled ? "on" : "off"}. Metadata-only is the default after the rights review.</p>
            <p className="text-sm text-muted">Video engine: {board.video.status} ({board.video.provider}). {board.video.detail}</p>
          </Panel>

          <Panel className="space-y-4 p-5">
            <h2 className="font-display text-2xl">Watch a niche</h2>
            {canEdit ? (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void busy.run(async () => {
                    const result = await startFactoryRun({ data: { brandId, niche, level: board.level } });
                    setNote(`Queued ${result.jobs} factory jobs as run ${result.runId}.`);
                    setNiche("");
                  });
                }}
              >
                <Field label="Niche" required>
                  <TextInput value={niche} onChange={(event) => setNiche(event.currentTarget.value)} maxLength={80} required placeholder="skincare" />
                </Field>
                <Button type="submit" disabled={busy.pending || !niche.trim()}>{busy.pending ? "Queueing…" : "Queue factory run"}</Button>
              </form>
            ) : <p className="text-sm text-muted">Viewers cannot queue runs.</p>}
            {board.runs.length === 0 ? <p className="text-sm text-muted">No factory runs are stored.</p> : (
              <ul className="space-y-2">
                {board.runs.map((run) => (
                  <li key={run.id} className="rounded-md border border-line p-3 text-sm">
                    <span className="font-semibold">{run.niche || "unspecified niche"}</span> · {run.status} · {run.stage || "queued"}
                    {run.error ? <span className="block text-muted">{run.error}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="space-y-4 p-5">
            <h2 className="font-display text-2xl">Likely winners</h2>
            {board.winners.length === 0 ? <p className="text-muted">No tracked ads yet. Nothing is invented to fill this list.</p> : (
              <ul className="space-y-3">
                {board.winners.map((item) => (
                  <li key={item.id} className="rounded-md border border-line p-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.advertiser}</p>
                    <p className="font-display text-xl">Score {item.score.toFixed(2)} <span className="text-sm font-normal text-muted">range {item.low.toFixed(2)}–{item.high.toFixed(2)}</span></p>
                    <p className="text-sm text-muted">{item.evidence.join(" · ")}</p>
                    {item.copy ? <p className="mt-2 text-sm">{item.copy}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="space-y-4 p-5">
            <h2 className="font-display text-2xl">Trends</h2>
            {board.trends.length === 0 ? <p className="text-muted">No stored ads to cluster. Rising concepts stay unnamed until ads exist.</p> : (
              <ul className="space-y-3">
                {board.trends.map((trend) => (
                  <li key={trend.concept} className="rounded-md border border-line p-4">
                    <p className="font-semibold">{trend.concept} · {trend.momentum}{trend.whitespace ? " · whitespace" : ""}</p>
                    <p className="text-sm text-muted">{trend.evidence.join(" · ")}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="space-y-3 p-5">
            <h2 className="font-display text-2xl">Ad Library yield</h2>
            {board.yieldRows.length === 0 ? <p className="text-muted">No collection runs are stored, so yield is unknown.</p> : (
              <ul className="space-y-2 text-sm">
                {board.yieldRows.map((row, index) => (
                  <li key={`${row.niche}-${index}`}>
                    {row.niche || "unspecified"}: {row.adsFound} ads, {row.videosDownloaded} videos, {row.transcriptsProduced} transcripts, {row.snapshotWithoutVideo} without video
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <Panel className="space-y-3 p-5">
            <h2 className="font-display text-2xl">Storyboard templates</h2>
            <p className="text-muted">A winner becomes timed beats, shot types, and overlay roles. Footage, slogans, and look are dropped.</p>
            {board.templates.length === 0 ? <p className="text-muted">No templates are stored.</p> : (
              <ul className="space-y-2">
                {board.templates.map((item) => (
                  <li key={item.id} className="rounded-md border border-line p-3 text-sm">
                    Template from {item.sourceAdId || "unspecified source"} · {item.createdAt}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="production" className="space-y-4">
          <Panel className="space-y-3 p-5">
            <h2 className="font-display text-2xl">Production queue</h2>
            <ol className="grid gap-2 md:grid-cols-2">
              {board.stages.map((stage) => (
                <li key={stage.type} className="rounded-md border border-line p-3 text-sm">
                  <span className="font-semibold">{stage.label}</span>
                  <span className="block text-muted">{stage.type} · {stage.pool} pool</span>
                </li>
              ))}
            </ol>
            {board.costs.length === 0 ? <p className="text-muted">No production costs are recorded yet.</p> : (
              <ul className="text-sm">
                {board.costs.map((row, index) => (
                  <li key={`${row.stage}-${index}`}>{row.stage}: {dollars(row.cents)} · {row.seconds}s</li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="review" className="space-y-4">
          <Panel className="space-y-3 p-5">
            <h2 className="font-display text-2xl">Gate results</h2>
            <p className="text-muted">Originality, claims, policy, and rights can block. Brand gaps go to a person. Missing evidence is review, not a pass.</p>
            {board.variants.length === 0 ? <p className="text-muted">No variants are waiting.</p> : (
              <ul className="space-y-2">
                {board.variants.map((item) => (
                  <li key={item.id} className="rounded-md border border-line p-3 text-sm">
                    <span className="font-semibold">{item.gateResult}</span> · hook {item.hook || "unset"} · CTA {item.cta || "unset"} · {item.presenter || "no presenter"} · {item.lengthMs} ms
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="tests" className="space-y-4">
          <Panel className="space-y-4 p-5">
            <h2 className="font-display text-2xl">Caps and kill switch</h2>
            <p className="text-muted">Daily cap {dollars(board.cap.dailyCents)} · total cap {dollars(board.cap.totalCents)}. Spending starts only after the owner sets a cap. Automation never invents a live campaign.</p>
            {canAdmin ? (
              <form
                className="grid gap-3 md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void busy.run(async () => {
                    await setFactoryControls({
                      data: {
                        brandId,
                        level: Number(level),
                        ceiling: Number(ceiling),
                        dailyCents: Math.round(Number(daily || board.cap.dailyCents / 100) * 100),
                        totalCents: Math.round(Number(total || board.cap.totalCents / 100) * 100),
                      },
                    });
                    setNote("Factory controls saved.");
                  });
                }}
              >
                <Field label="Running level">
                  <SelectInput value={level} onChange={(event) => setLevel(event.currentTarget.value)}>
                    {([0, 1, 2, 3] as const).map((value) => <option key={value} value={String(value)}>{value} · {FACTORY_LEVEL_LABELS[value]} — {FACTORY_LEVEL_DETAIL[value]}</option>)}
                  </SelectInput>
                </Field>
                <Field label="Ceiling">
                  <SelectInput value={ceiling} onChange={(event) => setCeiling(event.currentTarget.value)}>
                    {([0, 1, 2, 3] as const).map((value) => <option key={value} value={String(value)}>{value} · {FACTORY_LEVEL_LABELS[value]}</option>)}
                  </SelectInput>
                </Field>
                <Field label="Daily spend cap (USD)"><TextInput type="number" min="0" step="0.01" value={daily} onChange={(event) => setDaily(event.currentTarget.value)} placeholder={String(board.cap.dailyCents / 100)} /></Field>
                <Field label="Total spend cap (USD)"><TextInput type="number" min="0" step="0.01" value={total} onChange={(event) => setTotal(event.currentTarget.value)} placeholder={String(board.cap.totalCents / 100)} /></Field>
                <Button type="submit" disabled={busy.pending}>Save caps and level</Button>
              </form>
            ) : <p className="text-sm text-muted">Only admins set levels and spend caps.</p>}
            {canAdmin ? (
              <Button
                type="button"
                variant="quiet"
                disabled={busy.pending}
                onClick={() => void busy.run(async () => {
                  const result = await setKillSwitch({ data: { organizationId: board.organizationId, brandId, engage: !board.killSwitch.brand } });
                  setNote(result.engaged ? "Brand kill switch engaged. Live ads must pause." : "Brand kill switch cleared.");
                })}
              >
                {board.killSwitch.brand ? "Clear brand kill switch" : "Engage brand kill switch"}
              </Button>
            ) : null}
          </Panel>
        </TabsContent>

        <TabsContent value="learnings" className="space-y-4">
          <Panel className="space-y-3 p-5">
            <h2 className="font-display text-2xl">Weekly strategist report</h2>
            <p className="text-muted">{board.report.note}</p>
            <section>
              <h3 className="font-semibold">Won</h3>
              {board.report.won.length === 0 ? <p className="text-sm text-muted">No stored winners this week.</p> : board.report.won.map((item) => <p key={item.label} className="text-sm">{item.label}: {item.why}</p>)}
            </section>
            <section>
              <h3 className="font-semibold">Ride</h3>
              {board.report.ride.length === 0 ? <p className="text-sm text-muted">No rising concepts with evidence.</p> : board.report.ride.map((item) => <p key={item.concept} className="text-sm">{item.concept}: {item.evidence.join("; ")}</p>)}
            </section>
            <section>
              <h3 className="font-semibold">Drop</h3>
              {board.report.drop.length === 0 ? <p className="text-sm text-muted">No fading concepts with evidence.</p> : board.report.drop.map((item) => <p key={item.concept} className="text-sm">{item.concept}: {item.evidence.join("; ")}</p>)}
            </section>
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
