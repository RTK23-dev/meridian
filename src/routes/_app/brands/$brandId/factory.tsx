import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, Field, ScreenSkeleton, SelectInput, Tabs, TabsContent, TabsList, TabsTrigger, Input } from "@/components/ui";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { factoryControlsPayload, factoryControlsSchema, type FactoryControlsInput } from "@/components/factory/factory-forms";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { hasRole } from "@/lib/meridian/access";
import { FACTORY_LEVEL_DETAIL, FACTORY_LEVEL_LABELS, type FactoryLevel } from "@/lib/meridian/factory/autopilot";
import { useFactoryQuery, useDistributionChannelsQuery, useOrganicDistributionQuery, usePipelineConfigQuery, useProviderSettingsQuery, useScopedMutation } from "@/lib/query/hooks";
import { approveFactoryStage, attestFactoryLicence, checkFactoryLearning, confirmFactoryAiLabel, resumeFactoryRun, revokeFactoryAiLabel, revokeFactoryLicence, saveFactoryRunDefaults, startFactoryRun, setFactoryControls, setKillSwitch } from "@/lib/meridian/factory/actions";
import type { LicenceKind } from "@/lib/meridian/factory/rights-wording";
import { organicMetricsLine } from "@/components/studio/organic-metrics";
import { metricLine, receiptLine } from "@/components/factory/measurement-model";
import { gateText, planText, predictionStatusText, predictionText, variantHeading } from "@/components/factory/grades-model";
import { HeldReservationsPanel } from "@/components/held-reservations-panel";
import { FACTORY_GRAPH } from "@/lib/meridian/factory/pipeline";
import { usdOfMicros } from "@/lib/meridian/factory/spend-lines";
import { PipelineEditor } from "@/components/factory/pipeline-editor";
import { RunBuilder } from "@/components/factory/run-builder";
import { RunList, type RunListItem, type RunPickLine } from "@/components/factory/run-list";
import type { RunSettings } from "@/lib/meridian/factory/run-settings";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/brands/$brandId/factory")({ staticData: { pageTitle: "Factory" }, component: Page });

function dollars(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/**
 * One cost row, in plain words. A provider row shows its cents. A token row shows its tokens and its priced cost, or says it is tokens
 * only and not priced, because no price exists for its model. Its cost is unknown then, not zero.
 */
function costLine(row: FactoryBoard["costs"][number]): string {
  if (row.basis !== "tokens") return `${row.stage}: ${dollars(row.cents ?? 0)} · ${row.seconds}s`;
  const priced = row.micros === null ? "tokens only, not priced" : usdOfMicros(row.micros);
  return `${row.stage} · ${row.engine} ${row.model || "model not reported"} · ${row.tokens ?? 0} tokens · ${priced}`;
}

type FactoryBoard = NonNullable<ReturnType<typeof useFactoryQuery>["data"]>;

/**
 * Each run's picks, as the run view shows them: the grade each was made under, its status, its variants, and the receipts and measured
 * rows of the creatives those variants produced. The creatives' rows come from the board's publishing list, read once per creative.
 */
function picksOf(board: FactoryBoard, runPicks: FactoryBoard["runs"][number]["picks"]): RunPickLine[] {
  return runPicks.map((pick) => {
    const variants = pick.variants.map((variant) => ({
      heading: variantHeading(variant),
      gate: gateText(variant.gateResult),
      // The rights gate's reason, when it blocks the variant: a missing licence is named, and a licence that is attested is not.
      rightsLine: variant.rights.blockedBy,
      aiLabel: { variantId: variant.id, confirmed: variant.rights.aiLabel.confirmed, canConfirm: variant.rights.aiLabel.canConfirm },
      creatives: variant.creatives.map((created) => {
        const publishing = board.publishing.find((item) => item.creativeId === created.creativeId);
        const licence = variant.rights.creatives.find((item) => item.creativeId === created.creativeId);
        return {
          label: `${created.format || publishing?.format || "creative"} creative`,
          receiptLines: (publishing?.receipts ?? []).map((receipt) => receiptLine(receipt)),
          measurementLines: (publishing?.measurements ?? []).map((row) => `${row.surface} ${row.platform}: ${metricLine(row.surface, row.metrics)}`),
          licence: licence ? { creativeId: licence.creativeId, music: licence.music, footage: licence.footage } : undefined,
        };
      }),
    }));
    return {
      concept: pick.concept,
      surface: pick.surface === "organic" ? "Organic" : pick.surface === "paid" ? "Paid" : "",
      prediction: predictionText(pick.prediction),
      predictionNote: predictionStatusText(pick.predictionStatus),
      plan: planText(pick.plan, pick.planReason),
      measuredLines: variants.flatMap((variant) => variant.creatives.flatMap((creative) => creative.measurementLines)),
      variants,
    };
  });
}

/** Each run with its picks, and the receipts and measured rows of its own creatives, as the run view shows them. */
function runListItems(board: FactoryBoard): RunListItem[] {
  return board.runs.map((run) => {
    const creatives = board.publishing.filter((item) => item.runId === run.id);
    return {
      id: run.id,
      status: run.status,
      stage: run.stage,
      niche: run.niche,
      error: run.error,
      settings: run.settings,
      spend: run.spend,
      runSources: run.runSources,
      runCandidates: run.runCandidates,
      picks: picksOf(board, run.picks),
      receiptLines: creatives.flatMap((item) => item.receipts.map((receipt) => `${item.format} creative: ${receiptLine(receipt)}`)),
      measurementLines: creatives.flatMap((item) => item.measurements.map((row) => `${row.surface} ${row.platform}: ${metricLine(row.surface, row.metrics)}`)),
    };
  });
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
  const [note, setNote] = useState<string | null>(null);
  // The run builder keeps its own draft and reports whether it differs from the brand's defaults, so the page can guard it.
  const [builderDirty, setBuilderDirty] = useState(false);
  // A queued run resets the builder to the brand's defaults. Remounting it is how the draft returns to them.
  const [builderKey, setBuilderKey] = useState(0);
  const controlsForm = useForm<FactoryControlsInput>({
    resolver: zodResolver(factoryControlsSchema),
    defaultValues: { level: "0", ceiling: "1", daily: "", total: "" },
    mode: "onBlur",
  });
  const factoryFormsDirty = builderDirty || controlsForm.formState.isDirty;
  const factoryKey = (name: string) => ["mutation", `factory.${name}`, brandId] as const;
  const startRun = useScopedMutation({
    mutationKey: factoryKey("run"),
    mutationFn: (vars: { niche: string; settings: RunSettings }) => startFactoryRun({ data: { brandId, niche: vars.niche, level: 0, settings: vars.settings } }),
    // A run queues jobs and may produce research and creatives, so the jobs, market and studio screens change with it.
    invalidate: () => [qk.factory(brandId), qk.jobs(board?.organizationId ?? ""), qk.market(brandId), qk.studio(brandId)],
    onSuccess: (result) => {
      setNote(`Queued ${result.jobs} factory jobs as run ${result.runId}.`);
      setBuilderKey((key) => key + 1);
    },
  });
  const saveRunDefaults = useScopedMutation({
    mutationKey: factoryKey("run-defaults"),
    mutationFn: (settings: RunSettings) => saveFactoryRunDefaults({ data: { brandId, settings } }),
    invalidate: () => [qk.factory(brandId)],
    onSuccess: () => setNote("Saved as the brand's run defaults. A run already started keeps the settings it was started with."),
  });
  const startAgain = useScopedMutation({
    mutationKey: factoryKey("start-again"),
    mutationFn: (runId: string) => resumeFactoryRun({ data: { brandId, runId } }),
    invalidate: () => [qk.factory(brandId), qk.jobs(board?.organizationId ?? "")],
    onSuccess: (result) => setNote(`Started again from ${FACTORY_GRAPH.find((spec) => spec.type === result.stage)?.label ?? result.stage}. ${result.requeued} steps are queued.`),
  });
  const checkLearning = useScopedMutation({
    mutationKey: factoryKey("check-learning"),
    mutationFn: (runId: string) => checkFactoryLearning({ data: { brandId, runId } }),
    invalidate: () => [qk.factory(brandId), qk.jobs(board?.organizationId ?? "")],
    onSuccess: () => setNote("Learning is queued for this run. The run updates when the learn step finishes."),
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
  const approveStage = useScopedMutation({
    mutationKey: factoryKey("approve"),
    mutationFn: (vars: { runId: string; stage: string }) => approveFactoryStage({ data: { brandId, runId: vars.runId, stage: vars.stage } }),
    // An approval queues the stage and every stage after it, so the jobs and the run list change.
    invalidate: () => [qk.factory(brandId), qk.jobs(board?.organizationId ?? "")],
    onSuccess: (result) => setNote(`Approved. ${result.requeued} steps are queued again from ${FACTORY_GRAPH.find((spec) => spec.type === result.stage)?.label ?? result.stage}.`),
  });
  const attestLicence = useScopedMutation({
    mutationKey: factoryKey("attest-licence"),
    mutationFn: (vars: { creativeId: string; kind: LicenceKind }) => attestFactoryLicence({ data: { brandId, creativeId: vars.creativeId, kind: vars.kind } }),
    // An attested licence changes the variant's rights and gate result, so the run list changes.
    invalidate: () => [qk.factory(brandId)],
    onSuccess: (result) => setNote(result.created ? "Licence attested. The variant is gated again." : "That licence was already attested."),
  });
  const revokeLicence = useScopedMutation({
    mutationKey: factoryKey("revoke-licence"),
    mutationFn: (attestationId: string) => revokeFactoryLicence({ data: { brandId, attestationId } }),
    invalidate: () => [qk.factory(brandId)],
    onSuccess: () => setNote("Licence revoked. The variant is gated again."),
  });
  const confirmAiLabel = useScopedMutation({
    mutationKey: factoryKey("confirm-ai-label"),
    mutationFn: (variantId: string) => confirmFactoryAiLabel({ data: { brandId, variantId } }),
    // A confirmed AI label changes the variant's rights and gate result, so the run list changes.
    invalidate: () => [qk.factory(brandId)],
    onSuccess: (result) => setNote(result.created > 0 ? "AI label confirmed. The variant is gated again." : "The AI label was already confirmed."),
  });
  const revokeAiLabel = useScopedMutation({
    mutationKey: factoryKey("revoke-ai-label"),
    mutationFn: (variantId: string) => revokeFactoryAiLabel({ data: { brandId, variantId } }),
    invalidate: () => [qk.factory(brandId)],
    onSuccess: () => setNote("AI label revoked. The variant is gated again."),
  });
  const failures = [startRun, saveRunDefaults, startAgain, checkLearning, saveControls, killSwitch, approveStage, attestLicence, revokeLicence, confirmAiLabel, revokeAiLabel]
    .map((action) => action.error).filter((error): error is Error => Boolean(error));

  if (query.isError && !board) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!board) return <ScreenSkeleton label="Loading factory" shape="cards" />;

  const canEdit = hasRole(board.role, "member");
  const canAdmin = hasRole(board.role, "admin");
  const canOwnControls = board.role === "owner";
  const killOn = board.killSwitch.workspace || board.killSwitch.brand;

  return (
    <div className="space-y-6">
      <UnsavedChangesGuard dirty={factoryFormsDirty} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <p className="eyebrow">Factory</p>
          <h1 className="page-title">Watch, copy the framework, never the ad</h1>
          <p className="text-muted">{board.levelDetail} Autopilot is {FACTORY_LEVEL_LABELS[board.level as FactoryLevel]} (ceiling {FACTORY_LEVEL_LABELS[board.ceiling as FactoryLevel]}).</p>
        </div>
        {killOn ? <p className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm font-semibold" role="status">Kill switch is on. Live ads stay paused.</p> : null}
      </header>
      {board.note ? <p className="text-sm text-muted">{board.note}</p> : null}
      {note ? <p className="text-sm text-muted" role="status">{note}</p> : null}
      {failures.map((error, index) => <PlainErrorNotice key={index} error={error} />)}

      <Tabs defaultValue="pipeline" className="space-y-6">
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
          <section className="space-y-4">
            <h2 className="text-section font-semibold">Sources</h2>
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
          </section>

          <section className="space-y-4">
            <h2 className="text-section font-semibold">Start a run</h2>
            <p className="text-muted">A run starts from the brand's defaults. Every choice you change here is stored with the run, so a later change to the defaults does not change it.</p>
            <RunBuilder
              key={builderKey}
              defaults={board.runDefaults}
              channels={(channelsQuery.data ?? []).map((channel) => ({ id: channel.id, name: channel.name, connected: channel.connected }))}
              channelsState={channelsQuery.isPending ? "loading" : channelsQuery.isError ? "error" : "ready"}
              canEdit={canEdit}
              canAdmin={canAdmin}
              busy={startRun.isPending}
              savingDefaults={saveRunDefaults.isPending}
              onStart={({ niche, settings }) => { void startRun.mutateAsync({ niche, settings }).catch(() => undefined); }}
              onSaveDefaults={(settings) => { void saveRunDefaults.mutateAsync(settings).catch(() => undefined); }}
              onDirtyChange={setBuilderDirty}
            />
            <h3 className="font-semibold">Runs</h3>
            <RunList
              runs={runListItems(board)}
              actions={{
                canEdit,
                killSwitchOn: killOn,
                busy: {
                  approve: approveStage.isPending,
                  startAgain: startAgain.isPending,
                  checkLearning: checkLearning.isPending,
                  attest: attestLicence.isPending,
                  revoke: revokeLicence.isPending,
                  confirmAiLabel: confirmAiLabel.isPending,
                  revokeAiLabel: revokeAiLabel.isPending,
                },
                onApprove: (runId, stage) => void approveStage.mutateAsync({ runId, stage }).catch(() => undefined),
                onStartAgain: (runId) => void startAgain.mutateAsync(runId).catch(() => undefined),
                onCheckLearning: (runId) => void checkLearning.mutateAsync(runId).catch(() => undefined),
                onAttest: (creativeId, kind) => void attestLicence.mutateAsync({ creativeId, kind }).catch(() => undefined),
                onRevoke: (attestationId) => void revokeLicence.mutateAsync(attestationId).catch(() => undefined),
                onConfirmAiLabel: (variantId) => void confirmAiLabel.mutateAsync(variantId).catch(() => undefined),
                onRevokeAiLabel: (variantId) => void revokeAiLabel.mutateAsync(variantId).catch(() => undefined),
              }}
            />
          </section>

          <section className="space-y-4">
            <h2 className="text-section font-semibold">Likely winners</h2>
            {board.winners.length === 0 ? <p className="text-muted">No tracked ads yet. Nothing is invented to fill this list.</p> : (
              <ul className="space-y-3">
                {board.winners.map((item) => (
                  <li key={item.id} className="rounded-md border border-line p-4">
                    <p className="eyebrow">{item.advertiser}</p>
                    {item.score == null || item.low == null || item.high == null ? (
                      <p className="text-xl text-muted">Not graded yet</p>
                    ) : (
                      <p className="text-xl tabular-nums">Score {item.score.toFixed(2)} <span className="text-sm font-normal text-muted">range {item.low.toFixed(2)}–{item.high.toFixed(2)}</span></p>
                    )}
                    <p className="text-sm text-muted">{item.evidence.join(" · ")}</p>
                    {item.copy ? <p className="mt-2 text-sm">{item.copy}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-section font-semibold">Trends</h2>
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
          </section>

          <section className="space-y-3">
            <h2 className="text-section font-semibold">Ad Library yield</h2>
            {board.yieldRows.length === 0 ? <p className="text-muted">No collection runs are stored, so yield is unknown.</p> : (
              <ul className="space-y-2 text-sm">
                {board.yieldRows.map((row, index) => (
                  <li key={`${row.niche}-${index}`}>
                    {row.niche || "unspecified"}: {row.adsFound} ads, {row.videosDownloaded} videos, {row.transcriptsProduced} transcripts, {row.snapshotWithoutVideo} without video
                  </li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <section className="space-y-3">
            <h2 className="text-section font-semibold">Storyboard templates</h2>
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
          </section>
        </TabsContent>

        <TabsContent value="production" className="space-y-4">
          <section className="space-y-3">
            <h2 className="text-section font-semibold">Production queue</h2>
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
                  <li key={`${row.stage}-${index}`}>{costLine(row)}</li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>

        <TabsContent value="review" className="space-y-4">
          <section className="space-y-3">
            <h2 className="text-section font-semibold">Gate results</h2>
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
          </section>
          <section className="space-y-3">
            <h2 className="text-section font-semibold">Publishing and measurement</h2>
            <p className="text-muted">Each receipt is what a channel or the paid publisher returned. A channel with no connection is listed as not connected. A metric the source did not report reads not reported.</p>
            {board.publishing.length === 0 ? <p className="text-muted">No Factory creative has a receipt yet.</p> : (
              <ul className="space-y-2">
                {board.publishing.map((item) => (
                  <li key={item.creativeId} className="rounded-md border border-line p-3 text-sm">
                    <span className="font-semibold">{item.format} creative</span> · run {item.runId}
                    <ul className="mt-1">
                      {item.receipts.map((receipt, index) => (
                        <li key={`${receipt.surface}-${receipt.platform}-${index}`}>{receiptLine(receipt)}</li>
                      ))}
                    </ul>
                    {item.measurements.length === 0 ? <p className="mt-1 text-muted">Not measured yet.</p> : (
                      <ul className="mt-1">
                        {item.measurements.map((row, index) => (
                          <li key={`${row.surface}-${row.recordedAt}-${index}`}>{row.surface} {row.platform}: {metricLine(row.surface, row.metrics)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </TabsContent>

        <TabsContent value="tests" className="space-y-4">
          <section className="space-y-4">
            <h2 className="text-section font-semibold">Caps and kill switch</h2>
            <p className="text-muted">Daily cap {dollars(board.cap.dailyCents)} · total cap {dollars(board.cap.totalCents)}. Spending starts only after the owner sets a cap. Automation never invents a live campaign.</p>
            {canOwnControls ? (
              <form
                className="grid gap-3 md:grid-cols-2"
                onSubmit={controlsForm.handleSubmit((values) => {
                  void saveControls.mutateAsync(factoryControlsPayload(values, board.cap)).then(() => controlsForm.reset(values, { keepValues: true }), () => undefined);
                })}
                onKeyDown={(event) => submitOnShortcut(event)}
              >
                <Field label="Running level" error={controlsForm.formState.errors.level?.message}>
                  <SelectInput {...controlsForm.register("level")}>
                    {([0, 1] as const).map((value) => <option key={value} value={String(value)}>{value} · {FACTORY_LEVEL_LABELS[value]} — {FACTORY_LEVEL_DETAIL[value]}</option>)}
                  </SelectInput>
                </Field>
                <Field label="Ceiling" error={controlsForm.formState.errors.ceiling?.message}>
                  <SelectInput {...controlsForm.register("ceiling")}>
                    {([0, 1] as const).map((value) => <option key={value} value={String(value)}>{value} · {FACTORY_LEVEL_LABELS[value]}</option>)}
                  </SelectInput>
                </Field>
                <Field label="Daily spend cap (USD)" error={controlsForm.formState.errors.daily?.message}><Input {...controlsForm.register("daily")} type="number" min="0" step="0.01" placeholder={String(board.cap.dailyCents / 100)} /></Field>
                <Field label="Total spend cap (USD)" error={controlsForm.formState.errors.total?.message}><Input {...controlsForm.register("total")} type="number" min="0" step="0.01" placeholder={String(board.cap.totalCents / 100)} /></Field>
                <FormDiscardBar dirty={controlsForm.formState.isDirty} subject="factory controls" onDiscard={() => controlsForm.reset()} className="md:col-span-2" />
                <Button type="submit" disabled={saveControls.isPending || controlsForm.formState.isSubmitting}>{saveControls.isPending || controlsForm.formState.isSubmitting ? "Saving…" : "Save caps and level"}</Button>
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
          </section>

          <section className="space-y-3">
            <h2 className="text-section font-semibold">Held budget</h2>
            <p className="text-muted">
              A provider call whose outcome is unknown keeps its reserved budget held. Nothing releases it automatically, not even when its submission expires. An admin releases it here.
            </p>
            {canAdmin ? <HeldReservationsPanel brandId={brandId} /> : (
              <p className="text-sm text-muted">
                Only a workspace admin or owner can see and release held budget. Releasing it returns the reserved budget to the ledger, so the control is limited to them. Your role is {board.role}.
              </p>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-section font-semibold">Multi-Channel Distribution & Organic Telemetry</h2>
            <p className="text-muted">
              Creatives are selectively dispatched to paid ad networks and organic social accounts. JEV learns from paid conversions and organic engagement without requiring every account to be connected.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(channelsQuery.data ?? []).map((channel) => (
                <div key={channel.id} className="rounded-md border border-line p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{channel.name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${channel.connected ? "bg-success-soft font-medium text-success" : "bg-surface-2 text-muted"}`}>
                      {channel.connected ? "Connected" : "Optional"}
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-1">{channel.description}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-line">
              <h3 className="font-semibold text-base">Organic Post Queue & Performance</h3>
              {organicQuery.data && organicQuery.data.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {organicQuery.data.map((post) => (
                    <li key={post.id} className="rounded-md border border-line p-3 text-sm flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="eyebrow">{post.platform}</span>
                          <span className="text-xs text-muted">· {post.status}</span>
                        </div>
                        <p className="font-medium mt-0.5">{post.title || (post.caption ? post.caption.slice(0, 50) : "Creative post")}</p>
                        {post.postUrl ? <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-fg underline mt-0.5 inline-block">External post link</a> : null}
                      </div>
                      <div className="text-xs text-muted text-right">
                        <div className="font-mono">{organicMetricsLine(post)}</div>
                        <div className="font-mono mt-0.5">{post.likes == null ? "likes not reported" : `${post.likes} likes`}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted mt-2">No organic posts published yet. Select organic channels in Studio Review to publish.</p>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="learnings" className="space-y-4">
          <section className="space-y-3">
            <h2 className="text-section font-semibold">Weekly strategist report</h2>
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
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
