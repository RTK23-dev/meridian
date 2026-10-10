import { useState } from "react";
import { HeldReservationsPanel } from "@/components/held-reservations-panel";
import type { ReviewAction, ReviewPayload } from "./review-rules.ts";
import { ReviewDialog, type ReviewTarget } from "./review-dialog.tsx";
import { PublishDialog, type PublishChannel, type PublishTarget } from "./publish-dialog.tsx";
import { ImageLightbox, type LightboxTarget } from "./image-lightbox.tsx";
import { EvidenceDrawer } from "./evidence-drawer.tsx";
import { VariantGallery } from "./variant-gallery.tsx";
import { CompareView } from "./compare-view.tsx";
import { LearningPanel, type OrganicPostSummary } from "./learning-panel.tsx";
import type { PublishReceipt, StudioData, StudioVariant } from "./types.ts";

type ReviewStepProps = {
  brandId: string;
  session: StudioData;
  canEdit: boolean;
  showHeldReservations: boolean;
  reviewBusyIds: readonly string[];
  publishBusyIds: readonly string[];
  reviewPending: boolean;
  publishPending: boolean;
  publishResults: PublishReceipt[] | null;
  channels: readonly PublishChannel[];
  organicPosts: readonly OrganicPostSummary[];
  allowedReasonCodes: readonly string[];
  recordingTest: boolean;
  recordingOrganic: boolean;
  onReviewSubmit: (creativeId: string, payload: ReviewPayload) => Promise<unknown>;
  onPublishConfirm: (target: PublishTarget, channelIds: string[], caption: string) => Promise<unknown>;
  onPublishClose: () => void;
  onRetry: (variant: StudioVariant) => void;
  onRecordTest: () => void;
  onRecordOrganic: () => void;
};

/**
 * Step 4. The variant gallery with its review, evidence, publish and image dialogs, the side-by-side compare, and what
 * Meridian learned. Each dialog opens with its own state and is remounted for each opening, so no value carries over.
 */
export function ReviewStep(props: ReviewStepProps) {
  const { brandId, session, canEdit } = props;
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [reviewKey, setReviewKey] = useState(0);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [lightboxTarget, setLightboxTarget] = useState<LightboxTarget | null>(null);
  const [lightboxKey, setLightboxKey] = useState(0);
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null);
  const [publishKey, setPublishKey] = useState(0);
  const [compareFirst, setCompareFirst] = useState("");
  const [compareSecond, setCompareSecond] = useState("");

  const inspectVariant = session.variants.find((variant) => variant.creativeId === inspectId) ?? null;

  function openReview(variant: StudioVariant, action: ReviewAction) {
    setReviewTarget({ creativeId: variant.creativeId, title: variant.title || variant.kind, action });
    setReviewKey((key) => key + 1);
  }

  function openPublish(variant: StudioVariant) {
    setPublishTarget({
      creativeId: variant.creativeId,
      title: variant.title || variant.kind,
      kind: variant.kind,
      width: variant.width,
      height: variant.height,
      durationMs: variant.durationMs,
      defaultCaption: variant.transcript || variant.title || "",
    });
    setPublishKey((key) => key + 1);
  }

  function openImage(variant: StudioVariant) {
    setLightboxTarget({ assetId: variant.assetId, title: variant.title || variant.kind, alt: `${variant.kind} variant: ${variant.title || variant.kind}`, width: variant.width, height: variant.height });
    setLightboxKey((key) => key + 1);
  }

  return (
    <div className="space-y-6">
      {props.showHeldReservations ? <HeldReservationsPanel brandId={brandId} /> : null}

      <VariantGallery
        variants={session.variants}
        canEdit={canEdit}
        reviewBusyIds={props.reviewBusyIds}
        publishBusyIds={props.publishBusyIds}
        publications={session.publications}
        actions={{
          onReview: openReview,
          onInspect: (variant) => setInspectId(variant.creativeId),
          onPublish: openPublish,
          onRetry: props.onRetry,
          onOpenImage: openImage,
        }}
      />

      {session.variants.length > 1 ? (
        <CompareView
          variants={session.variants}
          first={compareFirst}
          second={compareSecond}
          onChangeFirst={setCompareFirst}
          onChangeSecond={setCompareSecond}
        />
      ) : null}

      <LearningPanel
        patterns={session.learned}
        publications={session.publications}
        organicPosts={props.organicPosts}
        canEdit={canEdit}
        recordingTest={props.recordingTest}
        recordingOrganic={props.recordingOrganic}
        onRecordTest={props.onRecordTest}
        onRecordOrganic={props.onRecordOrganic}
      />

      <ReviewDialog
        key={reviewKey}
        target={reviewTarget}
        allowedCodes={props.allowedReasonCodes}
        pending={props.reviewPending}
        onClose={() => setReviewTarget(null)}
        onSubmit={(creativeId, payload) => {
          void props.onReviewSubmit(creativeId, payload).then(() => setReviewTarget(null), () => undefined);
        }}
      />

      <PublishDialog
        key={publishKey}
        target={publishTarget}
        channels={props.channels}
        pending={props.publishPending}
        results={props.publishResults}
        onClose={() => { setPublishTarget(null); props.onPublishClose(); }}
        onConfirm={(channelIds, caption) => {
          if (publishTarget) void props.onPublishConfirm(publishTarget, channelIds, caption).catch(() => undefined);
        }}
      />

      <ImageLightbox key={lightboxKey} target={lightboxTarget} onClose={() => setLightboxTarget(null)} />
      <EvidenceDrawer variant={inspectVariant} onClose={() => setInspectId(null)} />
    </div>
  );
}
