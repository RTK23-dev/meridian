import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Button, Field, Panel, ScreenSkeleton, SelectInput, Tabs, TabsContent, TabsList, TabsTrigger,
  TextInput,
} from "@/components/ui";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { hasRole } from "@/lib/meridian/access";
import { FACTORY_LEVEL_DETAIL, FACTORY_LEVEL_LABELS, type FactoryLevel } from "@/lib/meridian/factory/autopilot";
import { useFactoryQuery, useDistributionChannelsQuery, useOrganicDistributionQuery, usePipelineConfigQuery, useProviderSettingsQuery, useScopedMutation } from "@/lib/query/hooks";
import { startFactoryRun, setFactoryControls, setKillSwitch } from "@/lib/meridian/factory/actions";
import { PipelineEditor } from "@/components/factory/pipeline-editor";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/brands/$brandId/factory")({ staticData: { pageTitle: "Factory" }, component: Page });

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
  const channelsQuery = useDistributionChannelsQuery(brandId);
  const organicQuery = useOrganicDistributionQuery(brandId);
  const pipelineQuery = usePipelineConfigQuery(brandId);
  // Workspace provider summary: the Gemini production key and the Google Drive setting, for the engine states.
  const settingsQuery = useProviderSettingsQuery(board?.organizationId ?? "", Boolean(board));
  const [niche, setNiche] = useState("");
  const [daily, setDaily] = useState("");
  const [total, setTotal] = useState("");
  const [level, setLevel] = useState("0");
  const [ceiling, setCeiling] = useState("1");
  const [note, setNote] = useState<string | null>(null);
  const factoryKey = (name: string) => ["mutation", `factory.${name}`, brandId] as const;
  const startRun = useScopedMutation({
    mutationKey: factoryKey("run"),
    mutationFn: (vars: { niche: string; level: FactoryLevel }) => startFactoryRun({ data: { brandId, niche: vars.niche, level: vars.level } }),
    // A run queues jobs and may produce research and creatives, so the jobs, market and studio screens change with it.
    invalidate: () => [qk.factory(brandId), qk.jobs(board?.organizationId ?? ""), qk.market(brandId), qk.studio(brandId)],
    onSuccess: (result) => {
      setNote(`Queued ${result.jobs} factory jobs as run ${result.runId}.`);
      setNiche("");
    },
  });
  const saveControls = useScopedMutation({
    mutationKey: factoryKey("controls"),
    mutationFn: (controls: { level: number; ceiling: number; dailyCents: number; totalCents: number }) => setFactoryControls({ data: { brandId, ...controls } }),
    invalidate: () => [qk.factory(brandId), qk.pipelineConfig(brandId)],
    onSuccess: () => setNote("Factory controls saved."),
  });
  const killSwitch = useScopedMutation({
    mutationKey: factoryKey("kill-switch"),
    mutationFn: (engage: boolean) => setKillSwitch({ data: { organizationId: board?.organizationId ?? "", brandId, engage } }),
    invalidate: () => [qk.factory(brandId), qk.jobs(board?.organizationId ?? "")],
    onSuccess: (result) => setNote(result.engaged ? "Brand kill switch engaged. Live ads must pause." : "Brand kill switch cleared."),
  });
  const failures = [startRun, saveControls, killSwitch].map((action) => action.error).filter((error): error is Error => Boolean(error));

  if (query.isError && !board) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!board) return <ScreenSkeleton label="Loading factory" shape="cards" />;

  const canEdit = hasRole(board.role, "member");
  const canAdmin = hasRole(board.role, "admin");
  const canOwnControls = board.role === "owner";
  const killOn = board.killSwitch.workspace || board.killSwitch.brand;

  return (
    <div className="space-y-6">
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
      {failures.map((error, index) => <PlainErrorNotice key={index} error={error} />)}

      <Tabs defaultValue="pipeline">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-7">
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm font-medium" value="pipeline">Factory Line</TabsTrigger>
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm" value="discover">Discover</TabsTrigger>
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm" value="templates">Templates</TabsTrigger>
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm" value="production">Production</TabsTrigger>
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm" value="review">Review</TabsTrigger>
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm" value="tests">Live tests</TabsTrigger>
          <TabsTrigger className="px-2 text-xs sm:px-3 sm:text-sm" value="learnings">Learnings</TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline" className="space-y-6">
          <PipelineEditor
            brandId={brandId}
            initialConfig={pipelineQuery.data}
            canEdit={canEdit}
            savedState={pipelineQuery.isPending ? "loading" : pipelineQuery.isError ? "error" : "ready"}
            currentLevel={board.level}
            engineSources={{
              hypit: board.video,
              settings: {
                state: settingsQuery.data ? "ready" : settingsQuery.isError ? "error" : "loading",
                production: settingsQuery.data?.production,
                storage: settingsQuery.data?.storage,
              },
            }}
          />
        </TabsContent>

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
                  void startRun.mutateAsync({ niche, level: board.level }).catch(() => undefined);
                }}
              >
                <Field label="Niche" required>
                  <TextInput value={niche} onChange={(event) => setNiche(event.currentTarget.value)} maxLength={80} required placeholder="skincare" />
                </Field>
                <Button type="submit" disabled={startRun.isPending || !niche.trim()}>{startRun.isPending ? "Queueing…" : "Queue factory run"}</Button>
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
            {canOwnControls ? (
              <form
                className="grid gap-3 md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveControls.mutateAsync({
                    level: Number(level),
                    ceiling: Number(ceiling),
                    dailyCents: Math.round(Number(daily || board.cap.dailyCents / 100) * 100),
                    totalCents: Math.round(Number(total || board.cap.totalCents / 100) * 100),
                  }).catch(() => undefined);
                }}
              >
                <Field label="Running level">
                  <SelectInput value={level} onChange={(event) => setLevel(event.currentTarget.value)}>
                    {([0, 1] as const).map((value) => <option key={value} value={String(value)}>{value} · {FACTORY_LEVEL_LABELS[value]} — {FACTORY_LEVEL_DETAIL[value]}</option>)}
                  </SelectInput>
                </Field>
                <Field label="Ceiling">
                  <SelectInput value={ceiling} onChange={(event) => setCeiling(event.currentTarget.value)}>
                    {([0, 1] as const).map((value) => <option key={value} value={String(value)}>{value} · {FACTORY_LEVEL_LABELS[value]}</option>)}
                  </SelectInput>
                </Field>
                <Field label="Daily spend cap (USD)"><TextInput type="number" min="0" step="0.01" value={daily} onChange={(event) => setDaily(event.currentTarget.value)} placeholder={String(board.cap.dailyCents / 100)} /></Field>
                <Field label="Total spend cap (USD)"><TextInput type="number" min="0" step="0.01" value={total} onChange={(event) => setTotal(event.currentTarget.value)} placeholder={String(board.cap.totalCents / 100)} /></Field>
                <Button type="submit" disabled={saveControls.isPending}>Save caps and level</Button>
              </form>
            ) : <p className="text-sm text-muted">Only workspace owners set factory levels and spend caps.</p>}
            {canAdmin ? (
              <Button
                type="button"
                variant="quiet"
                disabled={killSwitch.isPending}
                onClick={() => void killSwitch.mutateAsync(!board.killSwitch.brand).catch(() => undefined)}
              >
                {board.killSwitch.brand ? "Clear brand kill switch" : "Engage brand kill switch"}
              </Button>
            ) : null}
          </Panel>

          <Panel className="space-y-4 p-5">
            <h2 className="font-display text-2xl">Multi-Channel Distribution & Organic Telemetry</h2>
            <p className="text-muted">
              Creatives are selectively dispatched to paid ad networks and organic social accounts. JEV learns from paid conversions and organic engagement without requiring every account to be connected.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(channelsQuery.data ?? []).map((channel) => (
                <div key={channel.id} className="rounded-md border border-line p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{channel.name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${channel.connected ? "bg-accent/20 text-accent font-medium" : "bg-muted/20 text-muted"}`}>
                      {channel.connected ? "Connected" : "Optional"}
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-1">{channel.description}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-line">
              <h3 className="font-semibold text-lg">Organic Post Queue & Performance</h3>
              {organicQuery.data && organicQuery.data.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {organicQuery.data.map((post) => (
                    <li key={post.id} className="rounded-md border border-line p-3 text-sm flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold uppercase text-xs tracking-wider text-brass">{post.platform}</span>
                          <span className="text-xs text-muted">· {post.status}</span>
                        </div>
                        <p className="font-medium mt-0.5">{post.title || (post.caption ? post.caption.slice(0, 50) : "Creative post")}</p>
                        {post.postUrl ? <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent underline mt-0.5 inline-block">External post link</a> : null}
                      </div>
                      <div className="text-xs text-muted text-right">
                        <div>{post.views.toLocaleString()} views · {post.threeSecondViews.toLocaleString()} 3s views</div>
                        <div className="font-mono mt-0.5">{(post.completionRate * 100).toFixed(1)}% completion · {post.shares} shares · {post.likes} likes</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted mt-2">No organic posts published yet. Select organic channels in Studio Review to publish.</p>
              )}
            </div>
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
