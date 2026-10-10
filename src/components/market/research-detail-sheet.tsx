import { Badge, Notice, Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui";
import { AnalysisStateBadge, ConfidenceChip, MissingValue, SnapshotPlaceholder, StatusWord } from "./research-parts";
import {
  ANALYSIS_FIELD_LABELS,
  META_SOURCE_LABEL,
  analysisConfidence,
  formatDate,
  formatDuration,
  formatTimestamp,
  hasAnalysis,
  knownNumber,
  mediaNote,
  parseAnalysis,
  researchAdState,
  type AnalysisSegment,
  type AnalysisView,
  type ResearchAdRow,
} from "./research-model";

type SheetProps = {
  ad: ResearchAdRow | null;
  onOpenChange: (open: boolean) => void;
};

/** One analysed ad: the source video's state, the transcript with timestamps, the analysis and where it came from. */
export function ResearchDetailSheet({ ad, onOpenChange }: SheetProps) {
  return <Sheet open={!!ad} onOpenChange={onOpenChange}>
    <SheetContent className="left-auto right-0 top-0 bottom-0 max-h-none w-full max-w-2xl rounded-none border-l border-t-0">
      {ad ? <ResearchDetail key={ad.id} ad={ad} /> : null}
    </SheetContent>
  </Sheet>;
}

function ResearchDetail({ ad }: { ad: ResearchAdRow }) {
  const analysis = parseAnalysis(ad.analysis);
  const segments: AnalysisSegment[] = analysis?.segments ?? [];
  return <>
    <SheetTitle className="font-display text-2xl">{ad.advertiser || "Research ad"}</SheetTitle>
    <SheetDescription>Source {ad.externalId} · {META_SOURCE_LABEL} · captured {formatDate(ad.capturedAt)}</SheetDescription>
    <div className="mt-5 space-y-6">
      <section aria-labelledby="research-source-video" className="space-y-2">
        <h3 id="research-source-video" className="font-semibold">Source video</h3>
        <SnapshotPlaceholder ad={ad} />
        <p className="text-sm text-fg-muted">{mediaNote(ad)}</p>
      </section>

      <section aria-labelledby="research-status" className="space-y-2">
        <h3 id="research-status" className="font-semibold">Status</h3>
        <div className="flex flex-wrap items-center gap-2">
          <AnalysisStateBadge state={researchAdState(ad)} />
          <Badge variant="neutral">Media <StatusWord status={ad.mediaStatus} /></Badge>
          <Badge variant="neutral">Transcript <StatusWord status={ad.transcriptStatus} /></Badge>
          <Badge variant="neutral">Analysis <StatusWord status={ad.analysisStatus} /></Badge>
          <Badge variant="neutral">Duration {formatDuration(ad.durationMs)}</Badge>
        </div>
      </section>

      <section aria-labelledby="research-transcript" className="space-y-2">
        <h3 id="research-transcript" className="font-semibold">Transcript</h3>
        {segments.length ? <ol className="space-y-2">
          {segments.map((segment, index) => <li key={segment.id ?? index} className="border-l-2 border-accent pl-3 text-sm">
            <p className="text-xs text-fg-muted">{timestampLabel(segment)} · {segment.role || "unclear"}</p>
            <p className="mt-1">{segment.text || "No text for this segment."}</p>
          </li>)}
        </ol> : ad.transcript ? <>
          <p className="whitespace-pre-line text-sm">{ad.transcript}</p>
          <p className="text-xs text-fg-muted">Timestamps are not stored for this transcript.</p>
        </> : <p className="text-sm text-fg-muted">No transcript is stored for this ad.</p>}
      </section>

      <section aria-labelledby="research-analysis" className="space-y-2">
        <h3 id="research-analysis" className="font-semibold">Structured analysis</h3>
        {analysis ? <dl className="grid gap-3 sm:grid-cols-2">
          {ANALYSIS_FIELD_LABELS.map(({ key, label }) => {
            const field = analysis[key];
            const evidence = field?.evidence ?? [];
            return <div key={key} className="rounded-md border border-border p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</dt>
              <dd className="mt-1 text-sm">{field?.value?.trim() || <MissingValue>Unclear</MissingValue>}</dd>
              <dd className="mt-2 flex flex-wrap items-center gap-2"><ConfidenceChip value={knownNumber(field?.confidence)} /></dd>
              <dd className="mt-2 text-xs text-fg-muted">
                Evidence references{evidence.length ? ":" : ": none"}
                {evidence.length ? <span className="mt-1 flex flex-wrap gap-1">{evidence.map((reference) => <code key={reference} className="break-all rounded border border-border px-1.5 py-0.5">{reference}</code>)}</span> : null}
              </dd>
            </div>;
          })}
        </dl> : <p className="text-sm text-fg-muted">Structured analysis is not available for this ad.{ad.copy || ad.headline ? " Source copy is shown in the list." : ""}</p>}
        {analysis?.claims?.length ? <div className="space-y-2">
          <h4 className="text-sm font-semibold">Claims and evidence</h4>
          <ul className="space-y-2 text-sm">
            {analysis.claims.map((claim, index) => <li key={`${claim.type ?? "claim"}:${index}`}>
              <span className="font-semibold">{claim.type || "Claim"}:</span> {claim.text || "No text stored."}
              <span className="mt-1 block text-xs text-fg-muted">Evidence {claim.evidence?.length ? claim.evidence.join(", ") : "none"}</span>
            </li>)}
          </ul>
        </div> : null}
      </section>

      <Provenance ad={ad} analysis={analysis} />

      {ad.error ? <Notice>{ad.error}</Notice> : null}
    </div>
  </>;
}

function Provenance({ ad, analysis }: { ad: ResearchAdRow; analysis: AnalysisView | null }) {
  const reviewText = ad.reviewRequired ? "Review required" : hasAnalysis(ad) ? "No review flagged" : "No analysis to review";
  return <section aria-labelledby="research-provenance" className="space-y-2">
    <h3 id="research-provenance" className="font-semibold">Provenance</h3>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="text-fg-muted">Model</dt><dd className="font-semibold">{ad.provider && ad.model ? `${ad.provider} / ${ad.model}` : "Not recorded"}</dd></div>
      <div><dt className="text-fg-muted">Schema version</dt><dd className="font-semibold">{ad.schemaVersion || "Not recorded"}</dd></div>
      <div><dt className="text-fg-muted">Prompt version</dt><dd className="font-semibold">Not returned by the server yet</dd></div>
      <div><dt className="text-fg-muted">JEV Research confidence</dt><dd><ConfidenceChip value={analysisConfidence(ad)} /></dd></div>
      <div><dt className="text-fg-muted">Review</dt><dd className="font-semibold">{reviewText}</dd></div>
      <div><dt className="text-fg-muted">Analysis fields</dt><dd className="font-semibold">{analysis ? "Stored" : "Not stored"}</dd></div>
    </dl>
  </section>;
}

function timestampLabel(segment: AnalysisSegment): string {
  const start = knownNumber(segment.startMs);
  if (start === null) return "Time unavailable";
  const end = knownNumber(segment.endMs);
  return `${formatTimestamp(start)} to ${end === null ? "unknown end" : formatTimestamp(end)}`;
}
