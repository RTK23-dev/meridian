import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useBusy } from "@/components/gate";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, ErrorState, Field, Notice, Panel, SelectInput, Skeleton, Stepper, Tabs, TabsContent, TabsList, TabsTrigger, TextArea, errorText } from "@/components/ui";
import { BrandNav } from "@/components/brand-nav";
import { MediaPlayer } from "@/components/media-player";
import { Term } from "@/components/term";
import { providerLabel, statusLabel } from "@/lib/copy";
import { hasRole } from "@/lib/meridian/access";
import {
  generateStudioVariants,
  openStudioBrief,
  publishStudioVariant,
  recordStudioTestPerformance,
  reviewStudioVariant,
} from "@/lib/meridian/studio/actions";
import {
  publishMultiChannelVariant,
  recordOrganicTelemetryAction,
} from "@/lib/meridian/distribution/actions";

import {
  useStudioQuery,
  useDistributionChannelsQuery,
  useOrganicDistributionQuery,
  usePublishingQueueQuery,
  useScheduleMultiAccountPublish,
  useCancelPublishJob,
  useRetryPublishJob,
  usePlatformAccountsQuery,
} from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { REVIEW_REASON_CODES } from "@/lib/meridian/machine";
import { studioGenerationSchema, type StudioGeneration } from "@/lib/meridian/schemas/studio-generation";
import { Clock, RefreshCw, Send, CheckCircle2, Share2 } from "lucide-react";

export const Route = createFileRoute("/brands/$brandId/studio")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Studio brandId={brandId} />
  );
}

function Studio({ brandId }: { brandId: string }) {
  const query = useStudioQuery(brandId);
  const session = query.data ?? null;
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [reviewTarget, setReviewTarget] = useState<{ creativeId: string; mode: "reject" | "revision" } | null>(null);
  const [reviewReason, setReviewReason] = useState("other");
  const [reviewNote, setReviewNote] = useState("");
  const [publishTarget, setPublishTarget] = useState<{ creativeId: string; title: string; defaultCaption: string } | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<string[]>(["test-publisher", "instagram-reels", "youtube-shorts"]);
  const [publishCaption, setPublishCaption] = useState("");
  const [publishResults, setPublishResults] = useState<{ channelId: string; platform: string; type: string; status: string; url?: string; error?: string }[] | null>(null);

  const channelsQuery = useDistributionChannelsQuery(brandId);
  const organicQuery = useOrganicDistributionQuery(brandId);
  const accountsQuery = usePlatformAccountsQuery(brandId);
  const queueQuery = usePublishingQueueQuery(brandId);
  const schedulePublishMutation = useScheduleMultiAccountPublish(brandId);
  const cancelJobMutation = useCancelPublishJob(brandId);
  const retryJobMutation = useRetryPublishJob(brandId);

  const [queueCreativeId, setQueueCreativeId] = useState("");
  const [queueAccountIds, setQueueAccountIds] = useState<string[]>([]);
  const [queueScheduledTime, setQueueScheduledTime] = useState("");
  const [queueTargetType, setQueueTargetType] = useState<"organic" | "paid_campaign">("organic");

  const briefAction = useBusy([qk.studio(brandId), qk.opportunities(brandId)]);
  const generationAction = useBusy([qk.studio(brandId), qk.library(brandId)]);
  const reviewAction = useBusy([qk.studio(brandId), qk.reviews(brandId)]);
  const publishAction = useBusy([qk.studio(brandId), qk.library(brandId), qk.organic(brandId)]);
  const performanceAction = useBusy([qk.studio(brandId), qk.learning(brandId)]);
  const organicTelemetryAction = useBusy([qk.studio(brandId), qk.organic(brandId), qk.learning(brandId)]);
  const generationForm = useForm<StudioGeneration>({
    resolver: zodResolver(studioGenerationSchema),
    defaultValues: {
      imageProvider: "none",
      videoProvider: "auto",
      mode: "video",
      source: "new_brief",
      aspectRatio: "9:16",
    },
    mode: "onBlur",
  });
  const generationDirty = generationForm.formState.isDirty;
  useEffect(() => {
    if (!generationDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [generationDirty]);
  const actionErrors = [briefAction.error, generationAction.error, reviewAction.error, publishAction.error, performanceAction.error, organicTelemetryAction.error].filter(Boolean);
  const anyActionPending = briefAction.pending || generationAction.pending || reviewAction.pending || publishAction.pending || performanceAction.pending || organicTelemetryAction.pending;

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!session) return <div role="status" aria-label="Loading studio" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="media" /></div>;
  const canEdit = hasRole(session.role, "member");
  const brief = session.briefs.find((item) => item.status === "ready") ?? session.brief;
  const previous = session.briefs[1];
  const changed = Boolean(brief && previous && brief.constraints !== previous.constraints);
  const recommendation = session.recommendation;

  async function generate(values: StudioGeneration) {
    if (!brief) return;
    const saved = await generationAction.run(async () => {
      await generateStudioVariants({ data: { brandId, briefId: brief.id, ...values } });
    });
    if (saved) generationForm.reset(values);
  }

  return (
    <div className="space-y-6">
      <BrandNav brandId={brandId} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Studio</p>
          <h1 className="font-display text-3xl">Make the next ads from evidence</h1>
        </div>
        <p className="max-w-md text-sm text-muted">
          {session.observationCount} competitor observations. <Term id="jev" /> evaluates the evidence; <Term id="hypit" /> renders approved briefs. Media appears only after a provider stores bytes.
        </p>
      </div>
      <Stepper steps={[
        { label: "Direction", state: recommendation ? "done" : "current", description: recommendation ? "Evidence-backed opportunity" : "Waiting for evidence" },
        { label: "Brief", state: brief?.status === "ready" ? "done" : recommendation ? "current" : "upcoming", description: brief?.status === "ready" ? "Approved for production" : "JEV decision to brief" },
        { label: "Generate", state: session.variants.length ? "done" : brief?.status === "ready" ? "current" : "upcoming", description: `${session.variants.length} stored variants` },
        { label: "Review", state: session.variants.some((variant) => variant.reviewStatus === "open" || variant.creativeStatus === "in_review") ? "current" : session.variants.length ? "done" : "upcoming", description: `${session.variants.filter((variant) => variant.creativeStatus === "in_review").length} awaiting review` },
      ]} className="grid grid-cols-2 lg:grid-cols-4" />
      {actionErrors.map((error) => <Notice key={error}>{error}</Notice>)}
      {anyActionPending ? <p className="text-sm" role="status" aria-live="polite">Working. This screen keeps the last stored result until the step finishes.</p> : null}
      <Tabs defaultValue="direction" className="space-y-5">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-5">
          <TabsTrigger value="direction">1. Direction</TabsTrigger>
          <TabsTrigger value="brief">2. Brief</TabsTrigger>
          <TabsTrigger value="generate">3. Generate</TabsTrigger>
          <TabsTrigger value="review">4. Review</TabsTrigger>
          <TabsTrigger value="queue">5. Queue & Schedule</TabsTrigger>
        </TabsList>
        <TabsContent value="direction" className="space-y-5">
      {recommendation ? (
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Discovered · {recommendation.posture === "exploitation" ? "Exploitation" : "Exploration"} · {recommendation.angle}</p>
          <h2 className="mt-2 font-display text-3xl">{recommendation.label}</h2>
          <p className="mt-3">{recommendation.reason}</p>
          <p className="mt-2 text-sm">{recommendation.because}</p>
          <p className="mt-2 text-sm text-muted">{recommendation.uncertainty}</p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Market density</dt><dd>{recommendation.marketSignal.toFixed(2)} signal, {recommendation.saturation.toFixed(2)} saturation</dd></div>
            <div><dt className="text-muted">Brand fit</dt><dd>{recommendation.brandFit.toFixed(2)}</dd></div>
            <div><dt className="text-muted">Novelty</dt><dd>{recommendation.novelty.toFixed(2)}</dd></div>
            <div><dt className="text-muted">Historical learning</dt><dd>{recommendation.historicalEvidence.toFixed(2)}</dd></div>
            <div><dt className="text-muted">Rank</dt><dd>{recommendation.expectedValue.toFixed(2)}</dd></div>
            <div><dt className="text-muted">JEV</dt><dd>{recommendation.decision || "Not stored yet"} {recommendation.decision ? recommendation.probability.toFixed(2) : ""}</dd></div>
          </dl>
          <ul className="mt-4 space-y-2 text-sm">
            {recommendation.evidence.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {canEdit ? (
            <Button
              className="mt-4"
              type="button"
              disabled={briefAction.pending}
              onClick={() => {
                void briefAction.run(async () => {
                  await openStudioBrief({ data: { brandId, forceNew: false } });
                });
              }}
            >
              Accept direction and write the brief
            </Button>
          ) : null}
        </Panel>
      ) : (
        <Panel>
          <h2 className="font-display text-2xl">No discovered opportunity</h2>
          <p className="mt-2 text-sm text-muted">
            {session.observationCount === 0
              ? "Add competitor ads you have seen. An empty library is not whitespace."
              : "Stored creatives do not yet show a direction outside the exploration seeds. Nothing was invented."}
          </p>
        </Panel>
      )}
      {session.exploration ? (
        <p className="text-sm text-muted">Exploration, not a finding: {session.exploration.label}. {session.exploration.reason}</p>
      ) : null}
      {session.semantic.clusters.length > 0 ? (
        <Panel>
          <h2 className="font-display text-2xl">Semantic clusters</h2>
          <p className="mt-2 text-sm text-muted">{session.semantic.note}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {session.semantic.clusters.map((cluster) => <li key={cluster.label}>{cluster.summary}</li>)}
          </ul>
        </Panel>
      ) : (
        <p className="text-sm text-muted">{session.semantic.note}</p>
      )}
      {session.whitespace.length > 0 ? (
        <Panel>
          <h2 className="font-display text-2xl">Whitespace in the stored set</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {session.whitespace.map((item) => <li key={item.underused}>{item.whyTest}</li>)}
          </ul>
        </Panel>
      ) : null}
        </TabsContent>
        <TabsContent value="brief" className="space-y-5">
      {brief ? (
        <Panel>
          <h2 className="font-display text-2xl">Brief</h2>
          <p className="mt-1 text-sm text-muted">{brief.title}</p>
          {changed ? <p className="mt-2 text-sm font-semibold">These findings changed the next recommendation.</p> : null}
          <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
            <div><dt className="text-muted">Objective</dt><dd>{brief.why[0]}</dd></div>
            <div><dt className="text-muted">Audience</dt><dd>{brief.audience || "Not stored."}</dd></div>
            <div><dt className="text-muted">Angle</dt><dd>{brief.angle}</dd></div>
            <div><dt className="text-muted">Hook</dt><dd>{brief.hook}</dd></div>
            <div><dt className="text-muted">Promise</dt><dd>{brief.promise || "Not stored."}</dd></div>
            <div><dt className="text-muted">Proof</dt><dd>{brief.proofType || "Not stored."}</dd></div>
            <div><dt className="text-muted">Offer</dt><dd>{brief.offer || "None stored."}</dd></div>
            <div><dt className="text-muted">Call to action</dt><dd>{brief.cta}</dd></div>
            <div><dt className="text-muted">Format</dt><dd>{brief.format}</dd></div>
          </dl>
          <h3 className="mt-4 font-semibold">Why this, why now</h3>
          <ul className="mt-2 space-y-1 text-sm">{brief.why.map((line) => <li key={line}>{line}</li>)}</ul>
          <h3 className="mt-4 font-semibold">Visual direction</h3>
          <p className="mt-2 text-sm">{brief.format}. Proof: {brief.proofType || "Not stored."}</p>
          <h3 className="mt-4 font-semibold">What not to do</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm" data-testid="brief-constraints">{brief.constraints || "No stored constraint."}</p>
          <h3 className="mt-4 font-semibold">Learned positives</h3>
          {session.learned.some((pattern) => pattern.direction === "POSITIVE") ? (
            <ul className="mt-2 text-sm">{session.learned.filter((pattern) => pattern.direction === "POSITIVE").map((pattern) => <li key={`${pattern.attribute}:${pattern.value}:up`}>POSITIVE · {pattern.summary}</li>)}</ul>
          ) : <p className="mt-2 text-sm text-muted">No positive pattern is stored.</p>}
          <h3 className="mt-4 font-semibold">Learned negatives</h3>
          {session.learned.some((pattern) => pattern.direction === "NEGATIVE") ? (
            <ul className="mt-2 text-sm">{session.learned.filter((pattern) => pattern.direction === "NEGATIVE").map((pattern) => <li key={`${pattern.attribute}:${pattern.value}:down`}>NEGATIVE · {pattern.summary}</li>)}</ul>
          ) : <p className="mt-2 text-sm text-muted">No negative pattern is stored.</p>}
          {session.rejections.length > 0 ? (
            <>
              <h3 className="mt-4 font-semibold">Rejected directions</h3>
              <ul className="mt-2 text-sm">{session.rejections.map((line) => <li key={line}>{line}</li>)}</ul>
            </>
          ) : null}
          {brief.learningNotes.length > 0 ? (
            <ul className="mt-3 text-sm">{brief.learningNotes.map((line) => <li key={line}>Learned: {line}</li>)}</ul>
          ) : <p className="mt-3 text-sm text-muted">No learned pattern is attached to this brief yet.</p>}
          {canEdit && brief.status !== "ready" ? (
            <Button
              className="mt-3"
              type="button"
              variant="quiet"
              disabled={briefAction.pending}
              onClick={() => {
                void briefAction.run(async () => {
                  await openStudioBrief({ data: { brandId, forceNew: true } });
                });
              }}
            >
              Write the next brief
            </Button>
          ) : null}
        </Panel>
      ) : null}
        </TabsContent>
        <TabsContent value="generate" className="space-y-5">
          <Panel>
            <h2 className="font-display text-2xl">Generate from the approved brief</h2>
            {brief ? <p className="mt-2 text-sm text-muted">Current brief: {brief.title}. A non-ready brief cannot be used for generation.</p> : <p className="mt-2 text-sm text-muted">Write or accept a brief before generating.</p>}
            {canEdit && brief ? <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={generationForm.handleSubmit(generate)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
              <Field label="Creation mode" hint="Format strategy for this generation run.">
                <SelectInput {...generationForm.register("mode")}>
                  <option value="video">Video (Reel / Short)</option>
                  <option value="image_ad">Static image ad</option>
                  <option value="carousel">Multi-slide carousel</option>
                  <option value="mixed_format">Mixed format campaign</option>
                  <option value="research_only">Research-only (no rendering)</option>
                </SelectInput>
              </Field>
              <Field label="Starting material" hint="Source lineage used to anchor the creative.">
                <SelectInput {...generationForm.register("source")}>
                  <option value="new_brief">New approved brief</option>
                  <option value="winning_reference">Winning organic / competitor reference</option>
                  <option value="existing_meridian_creative">Existing Meridian creative</option>
                  <option value="brand_assets">Brand asset library</option>
                  <option value="creator_footage">Creator / UGC footage</option>
                </SelectInput>
              </Field>
              <Field label="Video provider" hint="Remote synthesis provider. Omni and Hypit run asynchronously off-device." error={generationForm.formState.errors.videoProvider?.message}>
                <SelectInput {...generationForm.register("videoProvider")} required>
                  <option value="auto">Auto (healthy supported provider)</option>
                  <option value="omni">Google Gemini Omni (gemini-omni-1.1-flash)</option>
                  <option value="hypit">Hypit video</option>
                  <option value="veo">Google Veo 3.1 (Preview)</option>
                  <option value="higgsfield">Higgsfield AI</option>
                  <option value="manual_cloud">Manual Cloud (Google Drive)</option>
                  <option value="none">No video in this run</option>
                </SelectInput>
              </Field>
              <Field label="Aspect ratio" hint="Format canvas geometry.">
                <SelectInput {...generationForm.register("aspectRatio")}>
                  <option value="9:16">9:16 Vertical (Reels / TikTok / Shorts)</option>
                  <option value="16:9">16:9 Landscape (YouTube / Desktop)</option>
                  <option value="1:1">1:1 Square (Feed)</option>
                  <option value="4:5">4:5 Portrait (Instagram Feed)</option>
                </SelectInput>
              </Field>
              <Field label="Optional image generation" hint="Image generation is optional. Hypit handles video independently." error={generationForm.formState.errors.imageProvider?.message}>
                <SelectInput {...generationForm.register("imageProvider")} required>
                  <option value="none">No images</option>
                  <option value="test:image">Test image</option>
                  <option value="google:nano-banana">Google AI Studio · Nano Banana</option>
                </SelectInput>
              </Field>
              <div className="md:col-span-2">{generationDirty ? <div role="status" className="mb-3 flex items-center justify-between rounded-md border border-warning bg-warning-soft p-3 text-sm"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => generationForm.reset()}>Discard</Button></div> : null}<Button type="submit" disabled={generationAction.pending || generationForm.formState.isSubmitting || brief.status !== "ready"}>{generationForm.formState.isSubmitting ? "Generating…" : "Generate variants"}</Button><p className="mt-2 text-sm text-muted">Estimated cost appears only when a provider returns one. Daily or concurrency limits can block a run.</p></div>
            </form> : null}
          </Panel>
        </TabsContent>
        <TabsContent value="review" className="space-y-5">
      <section className="space-y-4" aria-label="Variants">
        <h2 className="font-display text-2xl">Variants</h2>
        {session.variants.length === 0 ? <p className="text-sm text-muted">No media yet.</p> : null}
        <ul className="grid gap-4 lg:grid-cols-2">
          {session.variants.map((variant) => (
            <li key={variant.assetId} className="rounded-lg border border-line bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">{variant.kind} {variant.index + 1} · {variant.provider ? providerLabel(variant.provider) : "No provider"}</p>
              <h3 className="font-display text-xl">{variant.title}</h3>
              {variant.kind === "video" ? <MediaPlayer className="mt-3" assetId={variant.assetId} poster={variant.frames[0]} durationMs={variant.durationMs} width={variant.width} height={variant.height} /> : variant.preview ? <img className="mt-3 max-h-72 max-w-full border border-line object-contain" src={variant.preview} alt={`${variant.provider} ${variant.kind} variant ${variant.index + 1}`} /> : null}
              {variant.frames.length > 0 ? (
                <div className="mt-3 flex gap-2">
                  {variant.frames.map((src, index) => (
                    <img key={`${variant.assetId}-frame-${index}`} className="h-16 w-16 border border-line" src={src} alt={`Sampled frame ${index + 1} from the stored ${variant.kind} bytes`} />
                  ))}
                </div>
              ) : null}
              {variant.kind === "video" ? (
                <p className="mt-3 text-sm" role="status">
                  {variant.provider === "test:video" ? "Fixture, not a camera recording. " : ""}
                  {variant.mediaStatus || "queued"}. {variant.durationMs ? `${(variant.durationMs / 1000).toFixed(1)}s. ` : "Duration not stored. "}
                  {variant.width ? `${variant.width}×${variant.height}. ` : "Dimensions not stored. "}
                  {variant.transcript || "No transcript stored. "}
                  {variant.scenes[0]?.summary ?? "No scene note stored."}
                </p>
              ) : null}
              <p className="mt-2 text-sm text-muted">
                {variant.model} · {variant.promptVersion} · {variant.byteSize || 0} bytes
                {variant.width ? ` · ${variant.width}×${variant.height}` : ""}
                {variant.checksum ? ` · ${variant.checksum.slice(0, 8)}` : ""}
              </p>
              <p className="text-sm">QA {statusLabel(variant.qaDecision || "pending")} · review {statusLabel(variant.reviewStatus)} · {statusLabel(variant.creativeStatus)}</p>
              {variant.error ? <p className="text-sm text-danger">{variant.error}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="quiet" aria-expanded={inspectId === variant.creativeId} onClick={() => setInspectId(inspectId === variant.creativeId ? null : variant.creativeId)}>
                  Inspect evidence
                </Button>
                {canEdit && variant.creativeStatus === "in_review" ? (
                  <>
                    <Button type="button" disabled={reviewAction.pending} onClick={() => { void reviewAction.run(async () => { await reviewStudioVariant({ data: { brandId, creativeId: variant.creativeId, action: "approve", reasonCode: "", note: "" } }); }); }}>Approve</Button>
                    <Button type="button" variant="danger" disabled={reviewAction.pending} onClick={() => { setReviewReason("other"); setReviewNote(""); setReviewTarget({ creativeId: variant.creativeId, mode: "reject" }); }}>Reject</Button>
                    <Button type="button" variant="quiet" disabled={reviewAction.pending} onClick={() => { setReviewReason("other"); setReviewNote(""); setReviewTarget({ creativeId: variant.creativeId, mode: "revision" }); }}>Request revision</Button>
                  </>
                ) : null}
                {canEdit && (variant.creativeStatus === "approved" || variant.creativeStatus === "testing") ? (
                  <>
                    <Button
                      type="button"
                      disabled={publishAction.pending}
                      onClick={() => {
                        void publishAction.run(async () => {
                          await publishStudioVariant({ data: { brandId, creativeId: variant.creativeId, publisher: "test" } });
                        });
                      }}
                    >
                      Publish with test publisher
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={publishAction.pending}
                      onClick={() => {
                        setPublishTarget({ creativeId: variant.creativeId, title: variant.title, defaultCaption: variant.transcript || variant.title || "" });
                        setPublishCaption(variant.transcript || variant.title || "");
                        setPublishResults(null);
                      }}
                    >
                      Publish to channels…
                    </Button>
                  </>
                ) : null}
              </div>
              {inspectId === variant.creativeId ? (
                <ul className="mt-3 space-y-2 text-sm">
                  {variant.questions.length === 0 ? <li>No JEV row is stored for this variant.</li> : variant.questions.map((question) => (
                    <li key={question.id}>
                      <span className="font-semibold">{question.id}</span> {question.decision} · answer {question.answer || "unrecorded"} · p {question.probability.toFixed(2)} · confidence {question.confidence.toFixed(2)}
                      <span className="block text-muted">{question.reasons[0]}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        {session.variants.length > 1 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Compare">
              <SelectInput aria-label="Compare" value={compareA} onChange={(event) => setCompareA(event.target.value)}>
                <option value="">First variant</option>
                {session.variants.map((variant) => <option key={variant.assetId} value={variant.assetId}>{variant.kind} {variant.index + 1}</option>)}
              </SelectInput>
            </Field>
            <Field label="With">
              <SelectInput aria-label="With" value={compareB} onChange={(event) => setCompareB(event.target.value)}>
                <option value="">Second variant</option>
                {session.variants.map((variant) => <option key={variant.assetId} value={variant.assetId}>{variant.kind} {variant.index + 1}</option>)}
              </SelectInput>
            </Field>
            {compareA && compareB ? (
              <p className="md:col-span-2 text-sm">
                {session.variants.find((item) => item.assetId === compareA)?.promptVersion} beside {session.variants.find((item) => item.assetId === compareB)?.promptVersion}. They stay separate versions.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      <Panel>
        <h2 className="font-display text-2xl">What Meridian learned</h2>
        {session.learned.length === 0 ? <p className="mt-2 text-sm text-muted">No pattern has met the sample rule.</p> : (
          <ul className="mt-3 space-y-2 text-sm">
            {session.learned.map((pattern) => (
              <li key={`${pattern.attribute}:${pattern.value}`}>
                {pattern.direction} · {pattern.state} · n={pattern.sampleSize} · {pattern.impressions} impressions · {pattern.summary}
              </li>
            ))}
          </ul>
        )}
        {session.publications.length > 0 ? (
          <ul className="mt-3 text-sm">
            {session.publications.map((item) => (
              <li key={item.externalId}>Test publication {item.externalId}</li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-muted">Nothing from this brand has a stored publisher id.</p>}
        {organicQuery.data && organicQuery.data.length > 0 ? (
          <div className="mt-4 pt-3 border-t border-line">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-brass">Organic Social Publications</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {organicQuery.data.map((post) => (
                <li key={post.id} className="rounded-md border border-line p-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold capitalize">{post.platform}</span> · <span className="text-muted">{post.status}</span>
                    <p className="text-xs text-muted mt-0.5">{post.caption ? post.caption.slice(0, 70) : "No caption"}</p>
                  </div>
                  <div className="text-xs text-right">
                    <span>{post.views} views · {post.threeSecondViews} (3s hook) · {(post.completionRate * 100).toFixed(1)}% comp · {post.shares} shares</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {canEdit ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={performanceAction.pending || session.publications.length === 0}
              onClick={() => {
                void performanceAction.run(async () => {
                  await recordStudioTestPerformance({ data: { brandId } });
                });
              }}
            >
              Record test-provider performance and learn
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={organicTelemetryAction.pending || !(organicQuery.data && organicQuery.data.length > 0)}
              onClick={() => {
                void organicTelemetryAction.run(async () => {
                  await recordOrganicTelemetryAction({ data: { brandId } });
                });
              }}
            >
              Record organic telemetry & learn
            </Button>
          </div>
        ) : null}
      </Panel>
      <Dialog open={!!reviewTarget} onOpenChange={(open) => { if (!open && !reviewAction.pending) setReviewTarget(null); }}>
        <DialogContent aria-describedby="variant-review-description">
          <DialogTitle>{reviewTarget?.mode === "reject" ? "Reject this variant" : "Request a revision"}</DialogTitle>
          <DialogDescription id="variant-review-description">Record the reviewer’s reason and note. These details remain attached to the review lineage.</DialogDescription>
          <div className="mt-4 space-y-4">
            {reviewTarget?.mode === "reject" ? <Field label="Reason"><SelectInput value={reviewReason} onChange={(event) => setReviewReason(event.currentTarget.value)}>{REVIEW_REASON_CODES.map((code) => <option key={code} value={code}>{code.replaceAll("_", " ")}</option>)}</SelectInput></Field> : null}
            <Field label="Reviewer note"><TextArea value={reviewNote} onChange={(event) => setReviewNote(event.currentTarget.value)} required maxLength={400} /></Field>
            <Button disabled={!reviewTarget || !reviewNote.trim() || reviewAction.pending} onClick={() => {
              if (!reviewTarget || !reviewNote.trim()) return;
              const target = reviewTarget;
              void reviewAction.run(async () => {
                await reviewStudioVariant({ data: { brandId, creativeId: target.creativeId, action: target.mode, reasonCode: target.mode === "reject" ? reviewReason : "", note: reviewNote.trim() } });
                setReviewTarget(null);
                setReviewNote("");
              });
            }}>{reviewTarget?.mode === "reject" ? "Confirm rejection" : "Send revision request"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!publishTarget} onOpenChange={(open) => { if (!open && !publishAction.pending) { setPublishTarget(null); setPublishResults(null); } }}>
        <DialogContent aria-describedby="multi-channel-publish-description">
          <DialogTitle>Publish Creative Across Channels</DialogTitle>
          <DialogDescription id="multi-channel-publish-description">
            Select where to publish this creative. Choose paid advertising channels and/or organic social posting. No platform is required.
          </DialogDescription>
          <div className="mt-4 space-y-4">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-brass">Paid Advertising Channels</h4>
              <div className="mt-2 space-y-2">
                {(channelsQuery.data ?? []).filter((c) => c.type === "paid").map((channel) => (
                  <label key={channel.id} className="flex items-start gap-2.5 text-sm cursor-pointer p-2 rounded-md border border-line bg-surface/50 hover:bg-surface">
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border-line"
                      checked={selectedChannels.includes(channel.id)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedChannels([...selectedChannels, channel.id]);
                        else setSelectedChannels(selectedChannels.filter((id) => id !== channel.id));
                      }}
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{channel.name}</span>
                        <span className="text-xs text-muted">{channel.connected ? "Ready" : "Not connected"}</span>
                      </div>
                      <p className="text-xs text-muted">{channel.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-brass">Organic Social Channels</h4>
              <div className="mt-2 space-y-2">
                {(channelsQuery.data ?? []).filter((c) => c.type === "organic").map((channel) => (
                  <label key={channel.id} className="flex items-start gap-2.5 text-sm cursor-pointer p-2 rounded-md border border-line bg-surface/50 hover:bg-surface">
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border-line"
                      checked={selectedChannels.includes(channel.id)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedChannels([...selectedChannels, channel.id]);
                        else setSelectedChannels(selectedChannels.filter((id) => id !== channel.id));
                      }}
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{channel.name}</span>
                        <span className="text-xs text-muted">{channel.accountName ?? "Active"}</span>
                      </div>
                      <p className="text-xs text-muted">{channel.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <Field label="Post caption & hashtags">
              <TextArea
                value={publishCaption}
                onChange={(e) => setPublishCaption(e.target.value)}
                placeholder="Caption with tags (e.g., #skincare #cleanbeauty)"
                rows={3}
              />
            </Field>

            {publishResults ? (
              <div aria-live="polite" role="status" className="space-y-2 rounded-md border border-line bg-panel p-3 text-sm">
                <p className="font-semibold">Publish Receipts:</p>
                {publishResults.map((res) => (
                  <div key={res.channelId} className="flex items-center justify-between text-xs">
                    <span>{res.channelId}: <span className={res.status === "published" ? "text-success font-semibold" : res.status === "failed" ? "text-danger" : "text-brass"}>{res.status}</span></span>
                    {res.url ? <a href={res.url} target="_blank" rel="noopener noreferrer" className="underline text-accent">View post</a> : res.error ? <span className="text-danger">{res.error}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="quiet"
                disabled={publishAction.pending}
                onClick={() => { setPublishTarget(null); setPublishResults(null); }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={publishAction.pending || selectedChannels.length === 0}
                onClick={() => {
                  if (!publishTarget) return;
                  void publishAction.run(async () => {
                    const res = await publishMultiChannelVariant({
                      data: {
                        brandId,
                        creativeId: publishTarget.creativeId,
                        channelIds: selectedChannels,
                        caption: publishCaption,
                      },
                    });
                    setPublishResults(res);
                  });
                }}
              >
                {publishAction.pending ? "Publishing…" : `Publish to selected (${selectedChannels.length})`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
        </TabsContent>

        {/* TAB 5: ORCHESTRATED QUEUE & SCHEDULE */}
        <TabsContent value="queue" className="space-y-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-2xl font-bold">Multi-Account Publishing Queue</h2>
            <p className="text-sm text-muted">
              Orchestrate social publishing across connected platform accounts with rate limiting, automated retries, and idempotency guarantees.
            </p>
          </div>

          {/* Schedule Form */}
          <Panel className="space-y-4">
            <h3 className="font-display text-lg font-semibold flex items-center gap-2">
              <Share2 className="h-4 w-4 text-brass" />
              Schedule Variant to Destination Accounts
            </h3>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Choose Creative Variant">
                <SelectInput
                  value={queueCreativeId}
                  onChange={(e) => setQueueCreativeId(e.target.value)}
                >
                  <option value="">Select a variant…</option>
                  {session.variants.map((v) => (
                    <option key={v.creativeId} value={v.creativeId}>
                      {v.creativeId} ({v.creativeStatus})
                    </option>
                  ))}
                </SelectInput>
              </Field>

              <Field label="Target Type">
                <SelectInput
                  value={queueTargetType}
                  onChange={(e) => setQueueTargetType(e.target.value as "organic" | "paid_campaign")}
                >
                  <option value="organic">Organic Social Post</option>
                  <option value="paid_campaign">Paid Ad Campaign</option>
                </SelectInput>
              </Field>
            </div>

            {/* Target Accounts Selection */}
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted block mb-2">
                Target Platform Accounts ({queueAccountIds.length} selected)
              </label>
              {(accountsQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-muted">
                  No social accounts connected yet. Go to <a href={`/brands/${brandId}/accounts`} className="underline text-accent">Accounts</a> to connect Instagram, TikTok, or YouTube.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {(accountsQuery.data ?? []).map((acct) => (
                    <label
                      key={acct.id}
                      className="flex items-center gap-2.5 p-2 rounded-md border border-line bg-surface/40 hover:bg-surface cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={queueAccountIds.includes(acct.id)}
                        onChange={(e) => {
                          if (e.target.checked) setQueueAccountIds([...queueAccountIds, acct.id]);
                          else setQueueAccountIds(queueAccountIds.filter((id) => id !== acct.id));
                        }}
                        className="rounded border-line"
                      />
                      <div className="truncate">
                        <span className="font-semibold block truncate">{acct.name}</span>
                        <span className="text-xs text-muted block truncate capitalize">
                          {acct.platform} {acct.handle ? `· ${acct.handle}` : ""}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Timing */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Schedule Time (optional, leave blank for immediate)">
                <input
                  type="datetime-local"
                  value={queueScheduledTime}
                  onChange={(e) => setQueueScheduledTime(e.target.value)}
                  className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-foreground"
                />
              </Field>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                variant="primary"
                disabled={
                  !canEdit ||
                  !queueCreativeId ||
                  queueAccountIds.length === 0 ||
                  schedulePublishMutation.isPending
                }
                onClick={() => {
                  schedulePublishMutation.mutate(
                    {
                      creativeId: queueCreativeId,
                      targetAccountIds: queueAccountIds,
                      scheduledTime: queueScheduledTime ? new Date(queueScheduledTime).toISOString() : undefined,
                      targetType: queueTargetType,
                    },
                    {
                      onSuccess: () => {
                        setQueueAccountIds([]);
                        setQueueScheduledTime("");
                      },
                    },
                  );
                }}
              >
                <Send className="mr-1.5 h-4 w-4" />
                {schedulePublishMutation.isPending
                  ? "Enqueueing…"
                  : `Enqueue to ${queueAccountIds.length} Account(s)`}
              </Button>
            </div>
          </Panel>

          {/* Live Queue Table */}
          {(() => {
            const queueItems = ((queueQuery.data as any)?.queue as Array<{
              id: string;
              platform: string;
              creativeId: string;
              targetType: string;
              scheduledTime: string;
              status: string;
              attempts: number;
              maxAttempts: number;
            }>) ?? [];
            const queueReceipts = ((queueQuery.data as any)?.receipts as Array<{
              id: string;
              platform: string;
              externalPostId: string;
              publishedAt: string;
              externalUrl?: string;
            }>) ?? [];

            return (
              <>
                <Panel className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-lg font-semibold flex items-center gap-2">
                      <Clock className="h-4 w-4 text-brass" />
                      Live Publishing Queue ({queueItems.length})
                    </h3>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void queueQuery.refetch()}
                      disabled={queueQuery.isFetching}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${queueQuery.isFetching ? "animate-spin" : ""}`} />
                    </Button>
                  </div>

                  {queueItems.length === 0 ? (
                    <p className="text-sm text-muted py-4 text-center">
                      Publishing queue is currently empty.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-line text-muted uppercase tracking-wider">
                          <tr>
                            <th className="py-2 pr-3">Target Platform</th>
                            <th className="py-2 pr-3">Creative ID</th>
                            <th className="py-2 pr-3">Type</th>
                            <th className="py-2 pr-3">Scheduled</th>
                            <th className="py-2 pr-3">Status</th>
                            <th className="py-2 pr-3">Attempts</th>
                            <th className="py-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {queueItems.map((item) => {
                            const badgeVariant =
                              item.status === "published"
                                ? "success"
                                : item.status === "processing"
                                ? "info"
                                : item.status === "failed"
                                ? "danger"
                                : item.status === "cancelled"
                                ? "neutral"
                                : "warning";

                            return (
                              <tr key={item.id} className="hover:bg-surface/30">
                                <td className="py-3 pr-3 font-semibold capitalize">{item.platform}</td>
                                <td className="py-3 pr-3 font-mono text-muted">{item.creativeId}</td>
                                <td className="py-3 pr-3 capitalize text-muted">{item.targetType.replace(/_/g, " ")}</td>
                                <td className="py-3 pr-3 text-muted">
                                  {new Date(item.scheduledTime).toLocaleString()}
                                </td>
                                <td className="py-3 pr-3">
                                  <Badge variant={badgeVariant} className="capitalize">
                                    {item.status}
                                  </Badge>
                                </td>
                                <td className="py-3 pr-3 text-muted">
                                  {item.attempts} / {item.maxAttempts}
                                </td>
                                <td className="py-3 text-right">
                                  {canEdit && (item.status === "failed" || item.status === "cancelled") && (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      className="h-7 text-xs"
                                      disabled={retryJobMutation.isPending}
                                      onClick={() => retryJobMutation.mutate({ queueId: item.id })}
                                    >
                                      Retry
                                    </Button>
                                  )}
                                  {canEdit && (item.status === "queued" || item.status === "processing") && (
                                    <Button
                                      size="sm"
                                      variant="danger"
                                      className="h-7 text-xs ml-1"
                                      disabled={cancelJobMutation.isPending}
                                      onClick={() => cancelJobMutation.mutate({ queueId: item.id })}
                                    >
                                      Cancel
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>

                {/* Execution Receipts Stream */}
                {queueReceipts.length > 0 && (
                  <Panel className="space-y-3">
                    <h3 className="font-display text-lg font-semibold flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
                      Live Execution Receipts
                    </h3>
                    <div className="space-y-2">
                      {queueReceipts.map((rec) => (
                        <div
                          key={rec.id}
                          className="flex items-center justify-between p-3 rounded-md border border-line bg-surface/30 text-xs"
                        >
                          <div>
                            <span className="font-semibold capitalize">{rec.platform} Post</span>
                            <span className="font-mono text-muted block mt-0.5">ID: {rec.externalPostId}</span>
                            <span className="text-muted block text-[11px]">
                              Published: {new Date(rec.publishedAt).toLocaleString()}
                            </span>
                          </div>
                          {rec.externalUrl ? (
                            <a
                              href={rec.externalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline text-accent font-semibold"
                            >
                              View External Post &rarr;
                            </a>
                          ) : (
                            <Badge variant="success">Confirmed Live</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}
              </>
            );
          })()}
        </TabsContent>
      </Tabs>
    </div>
  );
}
