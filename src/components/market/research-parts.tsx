import { AlertTriangle, CheckCircle2, CircleDashed, FileText, Film, ImageOff, Inbox, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui";
import { confidenceText, humanStatus, stateLabel, type ResearchAdRow, type ResearchState } from "./research-model";

const STATE_BADGE: Record<ResearchState, { variant: "neutral" | "info" | "success" | "warning"; icon: LucideIcon }> = {
  collected: { variant: "neutral", icon: Inbox },
  "media stored": { variant: "info", icon: Film },
  transcribed: { variant: "info", icon: FileText },
  analyzed: { variant: "success", icon: CheckCircle2 },
  "needs review": { variant: "warning", icon: AlertTriangle },
};

/** The state is written out with an icon. Colour alone never carries it. */
export function AnalysisStateBadge({ state }: { state: ResearchState }) {
  const presentation = STATE_BADGE[state];
  const Icon = presentation.icon;
  return <Badge variant={presentation.variant}><Icon aria-hidden="true" className="size-3.5" />{stateLabel(state)}</Badge>;
}

/** Confidence as a labelled chip. A missing value reads Unknown. It is never shown as 0.00. */
export function ConfidenceChip({ value }: { value: number | null }) {
  return <Badge variant="neutral">Confidence {confidenceText(value)}</Badge>;
}

/**
 * Where a still would go. The market response does not return a stored asset id, so no still can be shown yet.
 * The placeholder says what is stored instead of showing a picture that is not there.
 */
export function SnapshotPlaceholder({ ad }: { ad: Pick<ResearchAdRow, "mediaStatus"> }) {
  const stored = ad.mediaStatus === "stored";
  const Icon = stored ? Film : ImageOff;
  return <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-2 p-4 text-center text-sm text-fg-muted">
    <Icon aria-hidden="true" className="size-6" />
    <p>{stored ? "Source video is stored. A preview is not available in this view yet." : "No source video is stored for this ad."}</p>
  </div>;
}

export function AdvertiserName({ ad, url }: { ad: Pick<ResearchAdRow, "advertiser">; url: string | null }) {
  const name = ad.advertiser || "Unnamed advertiser";
  if (!url) return <span className="font-semibold">{name}</span>;
  return <a href={url} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-4">
    {name}<span className="sr-only"> (opens the source record in a new tab)</span>
  </a>;
}

/** Shown where a value is missing, so an empty cell is never mistaken for a value. */
export function MissingValue({ children = "Unknown" }: { children?: string }) {
  return <span className="inline-flex items-center gap-1.5 text-fg-muted"><CircleDashed aria-hidden="true" className="size-3.5" />{children}</span>;
}

export function StatusWord({ status }: { status: string }) {
  return <span>{humanStatus(status)}</span>;
}
