import { useState } from "react";
import { publishMultiChannelVariant, recordOrganicTelemetryAction } from "@/lib/meridian/distribution/actions";
import {
  approveAndExecuteCreativePlan,
  generateStudioVariants,
  openStudioBrief,
  publishStudioVariant,
  recordStudioTestPerformance,
  rejectCreativePlan,
  reviewStudioVariant,
} from "@/lib/meridian/studio/actions";
import type { StudioGeneration } from "@/lib/meridian/schemas/studio-generation";
import { usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import type { PendingPlan, PlanShape } from "./plan-dialog.tsx";
import type { ReviewPayload } from "./review-rules.ts";
import type { PublishReceipt } from "./types.ts";

/** What a generate call returned: a plan that waits for approval, or a run that was accepted. */
export type GenerateOutcome =
  | { kind: "awaiting"; planId: string; plan: PlanShape | null; estimatedCostUsd?: number; note?: string }
  | { kind: "generated"; values: StudioGeneration };

/**
 * Every studio mutation, one per action, each invalidating only the keys it changes. A running action disables only its own
 * controls. The calls, their arguments and their messages are the ones the studio has always made.
 */
export function useStudioActions(brandId: string) {
  const studioKey = (name: string) => ["mutation", `studio.${name}`, brandId] as const;
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [publishResults, setPublishResults] = useState<PublishReceipt[] | null>(null);

  const openBrief = useScopedMutation({
    mutationKey: studioKey("brief"),
    mutationFn: (vars: { forceNew: boolean; reason: string }) => openStudioBrief({ data: { brandId, forceNew: vars.forceNew, reason: vars.reason } }),
    invalidate: () => [qk.studio(brandId), qk.opportunities(brandId)],
    success: (vars) => (vars.forceNew ? "Next brief written." : "Brief written from the accepted direction."),
  });

  const generateVariants = useScopedMutation({
    mutationKey: studioKey("generate"),
    mutationFn: async (vars: { briefId: string; values: StudioGeneration }): Promise<GenerateOutcome> => {
      const res = await generateStudioVariants({ data: { brandId, briefId: vars.briefId, ...vars.values } });
      if (res && typeof res === "object" && "status" in res) {
        if (res.status === "awaiting_approval") {
          const awaiting = res as unknown as { planId: string; plan: PlanShape | null; estimatedCostUsd?: number; note?: string };
          return { kind: "awaiting", planId: awaiting.planId, plan: awaiting.plan, estimatedCostUsd: awaiting.estimatedCostUsd, note: awaiting.note };
        }
        if (res.status === "abstained") {
          throw new Error((res as any).note || "JEV abstained from automated format selection. Please select an explicit format.");
        }
        if (res.status === "rejected") {
          throw new Error((res as any).error || "Creative plan was rejected by Brand Guardian policy.");
        }
      }
      return { kind: "generated", values: vars.values };
    },
    invalidate: () => [qk.studio(brandId), qk.library(brandId), qk.machine(brandId)],
    success: (_vars, result) => (result.kind === "awaiting" ? "" : "Variants generated."),
    onSuccess: (result) => {
      if (result.kind === "awaiting") {
        setPendingPlan({ planId: result.planId, plan: result.plan, estimatedCostUsd: result.estimatedCostUsd, note: result.note });
      }
    },
  });

  const approvePlan = useScopedMutation({
    mutationKey: studioKey("plan-approve"),
    mutationFn: (planId: string) => approveAndExecuteCreativePlan({ data: { brandId, planId } }),
    invalidate: () => [qk.studio(brandId), qk.library(brandId), qk.machine(brandId)],
    success: "Plan approved. Generation is running.",
    onSuccess: () => setPendingPlan(null),
  });

  const rejectPlan = useScopedMutation({
    mutationKey: studioKey("plan-reject"),
    mutationFn: (vars: { planId: string; reason?: string }) => rejectCreativePlan({ data: { brandId, planId: vars.planId, reason: vars.reason } }),
    invalidate: () => [qk.studio(brandId)],
    success: "Plan rejected. Nothing was generated.",
    onSuccess: () => setPendingPlan(null),
  });

  const reviewVariant = useScopedMutation({
    mutationKey: studioKey("variant-review"),
    mutationFn: (vars: { creativeId: string } & ReviewPayload) => reviewStudioVariant({ data: { brandId, ...vars } }),
    invalidate: () => [qk.studio(brandId), qk.reviews(brandId), qk.machine(brandId)],
    success: (vars) => (vars.action === "approve" ? "Variant approved." : vars.action === "reject" ? "Variant rejected." : "Revision requested."),
  });

  const publishTest = useScopedMutation({
    mutationKey: studioKey("publish-test"),
    mutationFn: (creativeId: string) => publishStudioVariant({ data: { brandId, creativeId, publisher: "test" } }),
    invalidate: () => [qk.studio(brandId), qk.library(brandId), qk.organic(brandId)],
    success: "Published with the test publisher.",
  });

  const publishMulti = useScopedMutation({
    mutationKey: studioKey("publish-channels"),
    mutationFn: (vars: { creativeId: string; channelIds: string[]; caption: string }) => publishMultiChannelVariant({ data: { brandId, ...vars } }),
    invalidate: () => [qk.studio(brandId), qk.library(brandId), qk.organic(brandId)],
    success: "Publish finished. The receipts are in the dialog.",
    onSuccess: (receipts) => setPublishResults(receipts as PublishReceipt[]),
  });

  const recordTestPerformance = useScopedMutation({
    mutationKey: studioKey("performance"),
    mutationFn: () => recordStudioTestPerformance({ data: { brandId } }),
    invalidate: () => [qk.studio(brandId), qk.learning(brandId), qk.machine(brandId)],
    success: "Test-provider performance recorded and learned.",
  });

  const recordOrganic = useScopedMutation({
    mutationKey: studioKey("organic-telemetry"),
    mutationFn: () => recordOrganicTelemetryAction({ data: { brandId } }),
    invalidate: () => [qk.studio(brandId), qk.organic(brandId), qk.learning(brandId)],
    success: "Organic telemetry recorded and learned.",
  });

  const reviewBusyIds = usePendingVariables<{ creativeId: string }>(studioKey("variant-review")).map((vars) => vars.creativeId);
  const publishBusyIds = [
    ...usePendingVariables<string>(studioKey("publish-test")),
    ...usePendingVariables<{ creativeId: string }>(studioKey("publish-channels")).map((vars) => vars.creativeId),
  ];
  const studioActions = [openBrief, generateVariants, approvePlan, rejectPlan, reviewVariant, publishTest, publishMulti, recordTestPerformance, recordOrganic];
  const actionErrors = studioActions.map((action) => action.error).filter((error): error is Error => Boolean(error));
  const anyActionPending = studioActions.some((action) => action.isPending);

  /** The test publisher goes through its own action; any other choice goes through the channel publish, with receipts. */
  async function confirmPublish(target: { creativeId: string }, channelIds: string[], caption: string) {
    if (channelIds.length === 1 && channelIds[0] === "test-publisher") {
      await publishTest.mutateAsync(target.creativeId).then((stored) => {
        const publication = stored.publications.find((item) => item.creativeId === target.creativeId);
        setPublishResults([{
          channelId: "test-publisher",
          platform: "test",
          type: "paid",
          status: publication ? "published" : "not confirmed",
          externalId: publication?.externalId,
          error: publication ? undefined : "The publisher did not return a stored id for this variant.",
        }]);
      }, () => undefined);
      return;
    }
    await publishMulti.mutateAsync({ creativeId: target.creativeId, channelIds, caption }).catch(() => undefined);
  }

  return {
    confirmPublish,
    openBrief,
    generateVariants,
    approvePlan,
    rejectPlan,
    reviewVariant,
    publishTest,
    publishMulti,
    recordTestPerformance,
    recordOrganic,
    pendingPlan,
    setPendingPlan,
    publishResults,
    setPublishResults,
    reviewBusyIds,
    publishBusyIds,
    actionErrors,
    anyActionPending,
  };
}
