import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ScreenSkeleton, Stepper, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { Term } from "@/components/glossary";
import { useWorkspace } from "@/components/workspace";
import { providerLabel } from "@/lib/copy";
import { hasRole } from "@/lib/meridian/access";
import { REVIEW_REASON_CODES } from "@/lib/meridian/machine";
import { studioGenerationSchema, type StudioGeneration } from "@/lib/meridian/schemas/studio-generation";
import { ACTIVE_POLL_MS, useDistributionChannelsQuery, useOpportunitiesQuery, useOrganicDistributionQuery, useProviderSettingsQuery, useStudioQuery } from "@/lib/query/hooks";
import { DirectionStep } from "@/components/studio/direction-step.tsx";
import { BriefStep } from "@/components/studio/brief-step.tsx";
import { GenerateStep } from "@/components/studio/generate-step.tsx";
import { ReviewStep } from "@/components/studio/review-step.tsx";
import { QueuePanel } from "@/components/studio/queue-panel.tsx";
import { PlanDialog } from "@/components/studio/plan-dialog.tsx";
import { useStudioActions } from "@/components/studio/use-studio-actions.ts";
import { isImageProviderValue, isVideoProviderValue, productionStatusFrom } from "@/components/studio/provider-options.ts";
import { studioStepperSteps } from "@/components/studio/stepper-states.ts";
import type { ReviewPayload } from "@/components/studio/review-rules.ts";
import type { StudioVariant } from "@/components/studio/types.ts";

export const Route = createFileRoute("/_app/brands/$brandId/studio")({ staticData: { pageTitle: "Studio" }, component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return <Studio brandId={brandId} />;
}

type StepKey = "direction" | "brief" | "generate" | "review" | "queue";

const DEFAULT_GENERATION: StudioGeneration = {
  imageProvider: "none",
  videoProvider: "auto",
  creationScope: "auto_choose",
  autonomy: "semi_automatic",
  maxSpendUsd: 10,
  mode: "auto_choose",
  source: "new_brief",
  aspectRatio: "9:16",
};

function Studio({ brandId }: { brandId: string }) {
  const query = useStudioQuery(brandId);
  const session = query.data ?? null;
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const providerQuery = useProviderSettingsQuery(organizationId);
  const opportunitiesQuery = useOpportunitiesQuery(brandId);
  const channelsQuery = useDistributionChannelsQuery(brandId);
  const organicQuery = useOrganicDistributionQuery(brandId);
  const actions = useStudioActions(brandId);
  const [step, setStep] = useState<StepKey>("direction");
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const generationForm = useForm<StudioGeneration>({
    resolver: zodResolver(studioGenerationSchema),
    defaultValues: DEFAULT_GENERATION,
    mode: "onBlur",
  });
  const generationDirty = generationForm.formState.isDirty;
  useEffect(() => {
    if (!generationDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [generationDirty]);

  // The studio query polls while a variant is queued or running. A variant the provider has submitted is polled here too.
  const hasSubmitted = !!session?.variants.some((variant) => variant.mediaStatus === "submitted");
  const refetch = query.refetch;
  useEffect(() => {
    if (!hasSubmitted) return;
    const timer = window.setInterval(() => void refetch(), ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasSubmitted, refetch]);

  if (query.isError && !session) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!session) return <ScreenSkeleton label="Loading studio" shape="cards" />;

  const canEdit = hasRole(session.role, "member");
  const brief = session.briefs.find((item) => item.status === "ready") ?? session.brief;
  const briefIndex = brief ? session.briefs.findIndex((item) => item.id === brief.id) : -1;
  const previous = briefIndex >= 0 ? session.briefs[briefIndex + 1] ?? null : null;
  const changed = Boolean(brief && previous && brief.constraints !== previous.constraints);
  const recommendation = session.recommendation;
  const production = productionStatusFrom({ organizationId, data: providerQuery.data, isError: providerQuery.isError });

  async function generate(values: StudioGeneration) {
    if (!brief) return;
    await actions.generateVariants.mutateAsync({ briefId: brief.id, values }).then((result) => {
      if (result.kind === "generated") {
        generationForm.reset(result.values);
        setRetryNotice(null);
      }
    }, () => undefined);
  }

  async function handleApprovePlan() {
    if (!actions.pendingPlan) return;
    await actions.approvePlan.mutateAsync(actions.pendingPlan.planId).catch(() => undefined);
  }

  async function handleRejectPlan(reason: string) {
    if (!actions.pendingPlan) return;
    await actions.rejectPlan.mutateAsync({ planId: actions.pendingPlan.planId, reason: reason || undefined }).catch(() => undefined);
  }

  /** Retry opens the Generate step with the stored provider selected. A new run starts only when a person submits the form. */
  function retryVariant(variant: StudioVariant) {
    const provider = variant.provider;
    if (variant.kind === "image" && isImageProviderValue(provider)) {
      generationForm.setValue("imageProvider", provider, { shouldDirty: true });
      setRetryNotice(`Retry: ${providerLabel(provider)} is selected for this image. Check the settings, then generate.`);
    } else if (variant.kind === "video" && isVideoProviderValue(provider)) {
      generationForm.setValue("videoProvider", provider, { shouldDirty: true });
      setRetryNotice(`Retry: ${providerLabel(provider)} is selected for this video. Check the settings, then generate.`);
    } else {
      setRetryNotice("Retry: the stored provider is not one of the engines on this screen. Choose the engine again, then generate.");
    }
    setStep("generate");
  }

  function submitReview(creativeId: string, payload: ReviewPayload) {
    return actions.reviewVariant.mutateAsync({ creativeId, ...payload });
  }

  const reviewPending = actions.reviewVariant.isPending;
  const publishPending = actions.publishTest.isPending || actions.publishMulti.isPending;
  const organicPosts = organicQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Studio</p>
          <h1 className="font-display text-3xl">Make the next ads from evidence</h1>
        </div>
        <p className="max-w-md text-sm text-fg-muted">
          {session.observationCount} competitor observations. <Term id="jev" /> evaluates the evidence; <Term id="hypit" /> renders approved briefs. Media appears only after a provider stores bytes.
        </p>
      </div>

      <Stepper steps={studioStepperSteps(session, brief)} className="grid grid-cols-2 lg:grid-cols-4" />

      {actions.actionErrors.map((error, index) => <PlainErrorNotice key={index} error={error} />)}
      {actions.anyActionPending ? <p className="text-sm" role="status" aria-live="polite">Working. This screen keeps the last stored result until the step finishes.</p> : null}

      <Tabs value={step} onValueChange={(value) => setStep(value as StepKey)} className="space-y-5">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-5">
          <TabsTrigger value="direction">1. Direction</TabsTrigger>
          <TabsTrigger value="brief">2. Brief</TabsTrigger>
          <TabsTrigger value="generate">3. Generate</TabsTrigger>
          <TabsTrigger value="review">4. Review</TabsTrigger>
          <TabsTrigger value="queue">5. Queue &amp; schedule</TabsTrigger>
        </TabsList>

        <TabsContent value="direction">
          <DirectionStep
            session={session}
            canEdit={canEdit}
            pending={actions.openBrief.isPending}
            opportunities={opportunitiesQuery.data?.opportunities}
            opportunitiesFailed={opportunitiesQuery.isError}
            onAccept={(reason) => actions.openBrief.mutateAsync({ forceNew: false, reason })}
          />
        </TabsContent>

        <TabsContent value="brief">
          <BriefStep
            brandId={brandId}
            session={session}
            brief={brief}
            previous={previous}
            canEdit={canEdit}
            changed={changed}
            pending={actions.openBrief.isPending}
            onWriteNext={(reason) => actions.openBrief.mutateAsync({ forceNew: true, reason })}
          />
        </TabsContent>

        <TabsContent value="generate">
          <GenerateStep
            brief={brief}
            canEdit={canEdit}
            form={generationForm}
            testImageAllowed={session.testImageAllowed}
            production={production}
            pending={actions.generateVariants.isPending}
            retryNotice={retryNotice}
            onDismissRetry={() => setRetryNotice(null)}
            onGenerate={generate}
          />
        </TabsContent>

        <TabsContent value="review">
          <ReviewStep
            brandId={brandId}
            session={session}
            canEdit={canEdit}
            showHeldReservations={hasRole(session.role, "admin")}
            reviewBusyIds={actions.reviewBusyIds}
            publishBusyIds={actions.publishBusyIds}
            reviewPending={reviewPending}
            publishPending={publishPending}
            publishResults={actions.publishResults}
            channels={channelsQuery.data ?? []}
            organicPosts={organicPosts}
            allowedReasonCodes={REVIEW_REASON_CODES}
            recordingTest={actions.recordTestPerformance.isPending}
            recordingOrganic={actions.recordOrganic.isPending}
            onReviewSubmit={submitReview}
            onPublishConfirm={(target, channelIds, caption) => actions.confirmPublish(target, channelIds, caption)}
            onPublishClose={() => actions.setPublishResults(null)}
            onRetry={retryVariant}
            onRecordTest={() => { void actions.recordTestPerformance.mutateAsync().catch(() => undefined); }}
            onRecordOrganic={() => { void actions.recordOrganic.mutateAsync().catch(() => undefined); }}
          />
        </TabsContent>

        <TabsContent value="queue">
          <QueuePanel brandId={brandId} variants={session.variants} canEdit={canEdit} />
        </TabsContent>
      </Tabs>

      <PlanDialog
        plan={actions.pendingPlan}
        approving={actions.approvePlan.isPending}
        rejecting={actions.rejectPlan.isPending}
        onApprove={() => void handleApprovePlan()}
        onReject={(reason) => void handleRejectPlan(reason)}
        onClose={() => actions.setPendingPlan(null)}
      />
    </div>
  );
}
