import { CheckCircle2, Clock, Info, PlugZap, RotateCcw, XCircle, type LucideIcon } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { TechnicalDetails } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import {
  RESEARCH_AD_CAP,
  RESEARCH_MEDIA_CAP_MB,
  RESEARCH_VIDEO_CAP_MB,
  formatDate,
  isActiveRun,
  isFailedRun,
  runStatusLabel,
  stageCounts,
  type ResearchAdRow,
  type ResearchRunRow,
} from "./research-model";

type PanelProps = {
  runs: readonly ResearchRunRow[];
  ads: readonly ResearchAdRow[];
  canEdit: boolean;
  retryLimit: number;
  retryingRunIds: string[];
  onRetry: (run: ResearchRunRow) => void;
};

const RUN_BADGE: Record<string, { variant: "neutral" | "info" | "success" | "warning" | "danger"; icon: LucideIcon }> = {
  queued: { variant: "warning", icon: Clock },
  collecting: { variant: "info", icon: Clock },
  succeeded: { variant: "success", icon: CheckCircle2 },
  failed: { variant: "danger", icon: XCircle },
  retry: { variant: "warning", icon: RotateCcw },
  NOT_CONNECTED: { variant: "neutral", icon: PlugZap },
};

export function RunStatusBadge({ status }: { status: string }) {
  const presentation = RUN_BADGE[status] ?? { variant: "neutral" as const, icon: Info };
  const Icon = presentation.icon;
  return <Badge variant={presentation.variant}><Icon aria-hidden="true" className="size-3.5" />{runStatusLabel(status)}</Badge>;
}

/**
 * A capped counter. A null value means the server did not report it, so the bar is not drawn and the text says so.
 */
function CapMeter({ label, value, cap, unit, note }: { label: string; value: number | null; cap: number; unit: string; note?: string }) {
  const text = value === null ? `Not reported (cap ${cap} ${unit})` : `${value} of up to ${cap} ${unit}`;
  return <div className="space-y-1.5">
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="font-semibold">{label}</span>
      <span className="text-fg-muted">{text}</span>
    </div>
    {value === null ? <p className="text-xs text-fg-muted">{note}</p> : <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={value} aria-valuetext={text} className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round((value / cap) * 100))}%` }} />
    </div>}
  </div>;
}

function StageRow({ label, icon: Icon, detail }: { label: string; icon: LucideIcon; detail: string }) {
  return <li className="flex items-start gap-3 rounded-md border border-border p-3">
    <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
    <div className="min-w-0">
      <p className="font-semibold">{label}</p>
      <p className="text-sm text-fg-muted">{detail}</p>
    </div>
  </li>;
}

/** Latest run first: its caps, its stages, its failures with retry, then the run history. */
export function ResearchRunPanel({ runs, ads, canEdit, retryLimit, retryingRunIds, onRetry }: PanelProps) {
  const latest = runs[0] ?? null;
  const counts = stageCounts(ads);
  const failedRuns = runs.filter(isFailedRun);
  const adErrors = ads.filter((ad) => ad.error.trim() !== "");
  return <section aria-labelledby="research-run-title" className="space-y-5">
    <h3 id="research-run-title" className="font-semibold">Latest collection run</h3>
    {latest ? <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{latest.searchTerms}</span>
        <span className="text-fg-muted">· {latest.country} · started {formatDate(latest.createdAt)}</span>
        <RunStatusBadge status={latest.status} />
        {isActiveRun(latest) ? <span className="text-fg-muted" role="status">This page refreshes while the run is queued or running.</span> : null}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <CapMeter label="Ads collected" value={latest.collectedCount} cap={RESEARCH_AD_CAP} unit="ads" />
        <CapMeter label="Stored source video" value={null} cap={RESEARCH_MEDIA_CAP_MB} unit="MB" note={`Bytes are not returned per run yet. Each video is capped at ${RESEARCH_VIDEO_CAP_MB} MB.`} />
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Stages</h4>
        <ol className="grid gap-2 md:grid-cols-2">
          <StageRow label="Collect" icon={Clock} detail={`${runStatusLabel(latest.status)} · ${latest.collectedCount} collected`} />
          <StageRow label="Media" icon={Info} detail={`${counts.mediaStored} of ${counts.total} loaded ads have stored media`} />
          <StageRow label="Transcribe" icon={Info} detail={`${counts.transcribed} of ${counts.total} loaded ads transcribed`} />
          <StageRow label="Analyse" icon={Info} detail={`${counts.analysed} of ${counts.total} loaded ads analysed · ${latest.analyzedCount} analysed in this run`} />
        </ol>
        <p className="text-xs text-fg-muted">Media, transcript and analysis counts cover the {counts.total} most recent ads loaded for this brand. They are not split by run.</p>
      </div>
    </> : <p className="text-sm text-fg-muted">No external research collected for this brand yet.</p>}

    <div className="space-y-3">
      <h4 className="text-sm font-semibold">Failures</h4>
      {failedRuns.length === 0 && adErrors.length === 0 ? <p className="text-sm text-fg-muted">No failed runs or ad errors are stored.</p> : null}
      {failedRuns.length ? <ul className="space-y-2">
        {failedRuns.map((run) => <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{run.searchTerms} · {run.country}</p>
            <p className="text-fg-muted">{runStatusLabel(run.status)}{run.error ? `: ${run.error}` : ""}</p>
          </div>
          {canEdit ? <Button type="button" variant="secondary" disabled={retryingRunIds.includes(run.id)} onClick={() => onRetry(run)}>
            Retry collection<span className="sr-only"> for {run.searchTerms}</span>
          </Button> : null}
        </li>)}
      </ul> : null}
      {canEdit && failedRuns.length ? <p className="text-xs text-fg-muted">A retry uses the same search and country with Maximum ads set to {retryLimit}. A repeat of the same search, country and limit on the same day returns the existing run, so it may not start a new collection.</p> : null}
      {adErrors.length ? <details>
        <summary className="cursor-pointer text-sm font-semibold">{adErrors.length} {adErrors.length === 1 ? "ad has" : "ads have"} a stored error</summary>
        <ul className="mt-2 space-y-1 text-sm">
          {adErrors.slice(0, 5).map((ad) => <li key={ad.id}><span className="font-semibold">{ad.advertiser || "Unnamed advertiser"}:</span> {plainError(ad.error).message}<TechnicalDetails>{ad.error}</TechnicalDetails></li>)}
          {adErrors.length > 5 ? <li className="text-fg-muted">and {adErrors.length - 5} more in the list above.</li> : null}
        </ul>
      </details> : null}
    </div>

    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Collection history</h4>
      {runs.length ? <ul className="space-y-2 text-sm">
        {runs.map((run) => <li key={run.id} className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{run.searchTerms}</span>
          <span className="text-fg-muted">· {run.country}</span>
          <RunStatusBadge status={run.status} />
          <span className="text-fg-muted">{run.collectedCount} collected · {run.analyzedCount} analysed</span>
        </li>)}
      </ul> : <p className="text-sm text-fg-muted">No runs are stored.</p>}
    </div>
  </section>;
}
