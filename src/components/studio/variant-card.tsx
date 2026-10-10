import { useId } from "react";
import { MediaPlayer } from "@/components/media-player";
import { Button } from "@/components/ui";
import { providerLabel, statusLabel } from "@/lib/copy";
import { cn } from "@/lib/cn";
import { frameShape, frameWidthClass, type FrameShape } from "./aspect.ts";
import { CopyButton } from "./copy-button.tsx";
import { canPublish, canReview, canRetry, kindLabel, mediaPhase, showsMedia, type MediaPhase } from "./variant-state.ts";
import type { ReviewAction } from "./review-rules.ts";
import { VariantStatusBadges } from "./variant-badges.tsx";
import type { StudioVariant } from "./types.ts";

export type VariantActions = {
  onReview: (variant: StudioVariant, action: ReviewAction) => void;
  onInspect: (variant: StudioVariant) => void;
  onPublish: (variant: StudioVariant) => void;
  onRetry: (variant: StudioVariant) => void;
  onOpenImage: (variant: StudioVariant) => void;
};

type VariantCardProps = {
  variant: StudioVariant;
  position: number;
  selected: boolean;
  canEdit: boolean;
  reviewBusy: boolean;
  publishBusy: boolean;
  publisherId: string | null;
  cardRef: (node: HTMLLIElement | null) => void;
  onSelect: () => void;
  actions: VariantActions;
};

/** One variant in the gallery. Media is shown at its stored shape; in-flight and failed generations show their state instead. */
export function VariantCard({ variant, position, selected, canEdit, reviewBusy, publishBusy, publisherId, cardRef, onSelect, actions }: VariantCardProps) {
  const headingId = useId();
  const phase = mediaPhase(variant.mediaStatus);
  const frame = frameShape(variant.width, variant.height);
  const title = `${kindLabel(variant.kind)} ${position}`;
  const reviewable = canReview(variant, canEdit);
  const publishable = canPublish(variant, canEdit);
  const retryable = canRetry(variant, canEdit);
  const reviewStatus = variant.reviewStatus || variant.creativeStatus;

  return (
    <li
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      onFocus={onSelect}
      className={cn(
        "rounded-lg border bg-surface p-4 focus:outline-none",
        selected ? "border-accent ring-2 ring-accent" : "border-border",
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-accent">
        {title} · {variant.provider ? providerLabel(variant.provider) : "No provider"}
        {selected ? <span className="sr-only"> (selected)</span> : null}
      </p>
      <h3 id={headingId} className="mt-1 font-display text-xl">{variant.title || title}</h3>

      <div className="mt-3">
        <VariantMedia variant={variant} phase={phase} frame={frame} title={title} onOpenImage={() => actions.onOpenImage(variant)} />
      </div>

      <VariantFacts variant={variant} phase={phase} />

      <div className="mt-3">
        <VariantStatusBadges qa={variant.qaDecision} review={reviewStatus} creative={variant.creativeStatus} />
      </div>

      {variant.error && phase !== "failed" ? <p className="mt-2 text-sm text-danger">{variant.error}</p> : null}

      {publisherId ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>Stored publisher id <code className="break-all font-mono text-xs">{publisherId}</code></span>
          <CopyButton value={publisherId} label="stored publisher id" />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="quiet" aria-haspopup="dialog" onClick={() => actions.onInspect(variant)}>
          Inspect evidence<span className="sr-only"> for {title}</span>
        </Button>
        {reviewable ? (
          <>
            <Button type="button" disabled={reviewBusy} onClick={() => actions.onReview(variant, "approve")}>
              Approve<span className="sr-only"> {title}</span>
            </Button>
            <Button type="button" variant="danger" disabled={reviewBusy} onClick={() => actions.onReview(variant, "reject")}>
              Reject<span className="sr-only"> {title}</span>
            </Button>
            <Button type="button" variant="secondary" disabled={reviewBusy} onClick={() => actions.onReview(variant, "revision")}>
              Request revision<span className="sr-only"> for {title}</span>
            </Button>
          </>
        ) : null}
        {publishable ? (
          <Button type="button" variant="secondary" disabled={publishBusy} aria-haspopup="dialog" onClick={() => actions.onPublish(variant)}>
            Publish…<span className="sr-only"> {title}</span>
          </Button>
        ) : null}
        {retryable ? (
          <Button type="button" variant="secondary" onClick={() => actions.onRetry(variant)}>
            Retry in Generate step<span className="sr-only"> for {title}</span>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function VariantMedia({ variant, phase, frame, title, onOpenImage }: { variant: StudioVariant; phase: MediaPhase; frame: FrameShape; title: string; onOpenImage: () => void }) {
  if (phase === "in_flight") {
    return (
      <div role="status" className="rounded-md border border-dashed border-border p-4 text-sm">
        <p className="font-semibold">Generating · {statusLabel(variant.mediaStatus)}</p>
        <div aria-hidden="true" className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
        </div>
        <p className="mt-2 text-fg-muted">The provider has not reported a percentage. This card refreshes while the job runs.</p>
      </div>
    );
  }
  if (phase === "failed") {
    return (
      <div className="rounded-md border border-danger/50 p-4 text-sm">
        <p className="font-semibold text-danger">Generation failed</p>
        <p className="mt-1">{variant.error || "The provider did not return a reason."}</p>
      </div>
    );
  }
  if (!showsMedia(phase)) return null;

  const frameClass = frameWidthClass(frame.orientation);
  if (variant.kind === "video") {
    return (
      <div className={frameClass}>
        <MediaPlayer assetId={variant.assetId} durationMs={variant.durationMs} width={variant.width} height={variant.height} />
      </div>
    );
  }
  return (
    <div className={frameClass}>
      <MediaPlayer
        kind="image"
        assetId={variant.assetId}
        alt={`${title}: ${variant.title || kindLabel(variant.kind)}`}
        width={variant.width ?? 16}
        height={variant.height ?? 9}
      />
      <Button type="button" variant="quiet" size="sm" className="mt-2" onClick={onOpenImage}>
        View larger<span className="sr-only"> {title}</span>
      </Button>
    </div>
  );
}

/** The stored facts, in the words the server gives. Missing values are said to be missing. */
function VariantFacts({ variant, phase }: { variant: StudioVariant; phase: MediaPhase }) {
  const duration = variant.durationMs ? `${(variant.durationMs / 1000).toFixed(1)} s` : "Duration not stored";
  const dimensions = variant.width && variant.height ? `${variant.width} × ${variant.height}` : "Dimensions not stored";
  const bytes = variant.byteSize ? `${variant.byteSize} bytes` : "Bytes not stored";
  return (
    <div className="mt-3 space-y-1 text-sm">
      {variant.kind === "video" ? (
        <p>
          {variant.provider === "test:video" ? "Fixture, not a camera recording. " : ""}
          Media: {variant.mediaStatus ? statusLabel(variant.mediaStatus) : "Queued"}. {duration}. {dimensions}.
          {phase === "stored" ? ` ${variant.transcript || "No transcript stored."}` : ""}
          {phase === "stored" ? ` ${variant.scenes[0]?.summary ?? "No scene note stored."}` : ""}
        </p>
      ) : null}
      <p className="text-fg-muted">
        {variant.model || "Model not stored"} · {variant.promptVersion || "Prompt version not stored"} · {bytes}
        {variant.checksum ? ` · checksum ${variant.checksum.slice(0, 8)}` : ""}
      </p>
    </div>
  );
}
