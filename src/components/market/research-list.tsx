import { Button } from "@/components/ui";
import { AdvertiserName, AnalysisStateBadge, ConfidenceChip, SnapshotPlaceholder, StatusWord } from "./research-parts";
import {
  META_SOURCE_LABEL,
  analysisConfidence,
  firstSeen,
  formatDate,
  formatDuration,
  researchAdState,
  safeHttpUrl,
  type ResearchAdRow,
} from "./research-model";

type ListProps = {
  view: "gallery" | "table";
  ads: readonly ResearchAdRow[];
  onView: (id: string) => void;
};

/** Gallery cards or a table of the same ads. Both open the same detail sheet. */
export function ResearchList({ view, ads, onView }: ListProps) {
  if (view === "table") return <ResearchTable ads={ads} onView={onView} />;
  return <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {ads.map((ad) => <ResearchCard key={ad.id} ad={ad} onView={onView} />)}
  </ul>;
}

function ResearchCard({ ad, onView }: { ad: ResearchAdRow; onView: (id: string) => void }) {
  const copy = ad.copy || ad.headline;
  return <li className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
    <SnapshotPlaceholder ad={ad} />
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AdvertiserName ad={ad} url={safeHttpUrl(ad.url)} />
        <AnalysisStateBadge state={researchAdState(ad)} />
      </div>
      <p className="text-xs text-fg-muted">{META_SOURCE_LABEL} · {ad.mediaType || "Media type unknown"} · first seen {formatDate(firstSeen(ad))} · last seen {formatDate(ad.capturedAt)}</p>
      <p className="line-clamp-3 text-sm">{copy || "No source copy available."}</p>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
      <span>Duration {formatDuration(ad.durationMs)}</span>
      <ConfidenceChip value={analysisConfidence(ad)} />
    </div>
    <Button type="button" variant="secondary" onClick={() => onView(ad.id)}>View details<span className="sr-only"> for {ad.advertiser || "this ad"}</span></Button>
  </li>;
}

function ResearchTable({ ads, onView }: { ads: readonly ResearchAdRow[]; onView: (id: string) => void }) {
  const headers = ["Advertiser", "State", "First seen", "Last seen", "Media", "Transcript", "Duration", "Confidence"];
  return <div className="overflow-x-auto rounded-lg border border-border">
    <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
      <caption className="sr-only">Analysed ads with saved source, media, transcript and analysis states. Use Details to open one ad.</caption>
      <thead className="bg-surface-2">
        <tr>
          {headers.map((header) => <th key={header} scope="col" className="border-b border-border px-3 py-2 font-semibold whitespace-nowrap">{header}</th>)}
          <th scope="col" className="border-b border-border px-3 py-2"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {ads.map((ad) => <tr key={ad.id} className="align-top hover:bg-surface-2">
          <td className="px-3 py-3"><AdvertiserName ad={ad} url={safeHttpUrl(ad.url)} /><p className="mt-1 text-xs text-fg-muted">{ad.mediaType || "Media type unknown"}</p></td>
          <td className="px-3 py-3"><AnalysisStateBadge state={researchAdState(ad)} /></td>
          <td className="px-3 py-3 whitespace-nowrap">{formatDate(firstSeen(ad))}</td>
          <td className="px-3 py-3 whitespace-nowrap">{formatDate(ad.capturedAt)}</td>
          <td className="px-3 py-3"><StatusWord status={ad.mediaStatus} /></td>
          <td className="px-3 py-3"><StatusWord status={ad.transcriptStatus} /></td>
          <td className="px-3 py-3 whitespace-nowrap">{formatDuration(ad.durationMs)}</td>
          <td className="px-3 py-3"><ConfidenceChip value={analysisConfidence(ad)} /></td>
          <td className="px-3 py-3"><Button type="button" size="sm" variant="secondary" onClick={() => onView(ad.id)}>Details<span className="sr-only"> for {ad.advertiser || "this ad"}</span></Button></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
