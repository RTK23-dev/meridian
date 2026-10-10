import { Suspense, lazy } from "react";
import { InfoTip } from "@/components/glossary";
import { Button, ChartSkeleton, Panel } from "@/components/ui";
import { copy } from "@/lib/copy";
import { learningRows } from "./learning-rows.ts";
import type { StudioPattern, StudioPublication } from "./types.ts";

const LearningBars = lazy(() => import("./learning-bars.tsx"));

export type OrganicPostSummary = {
  id: string;
  platform: string;
  status: string;
  caption?: string | null;
  views: number;
  threeSecondViews: number;
  completionRate: number;
  shares: number;
};

type LearningPanelProps = {
  patterns: readonly StudioPattern[];
  publications: readonly StudioPublication[];
  organicPosts: readonly OrganicPostSummary[];
  canEdit: boolean;
  recordingTest: boolean;
  recordingOrganic: boolean;
  onRecordTest: () => void;
  onRecordOrganic: () => void;
};

/**
 * What Meridian learned. The chart shows patterns by lift; the list beside it is the text alternative and carries the same
 * sample size and impressions. Nothing is drawn from a pattern whose lift is not a finite number.
 */
export function LearningPanel({ patterns, publications, organicPosts, canEdit, recordingTest, recordingOrganic, onRecordTest, onRecordOrganic }: LearningPanelProps) {
  const { charted, unplotted } = learningRows(patterns);
  const ordered = [...charted, ...unplotted];
  return (
    <Panel>
      <h2 className="font-display text-2xl">What Meridian learned</h2>
      {patterns.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">
          {copy.learning.noPattern} <InfoTip label="What counts as a pattern" text={copy.learning.patternRule} />
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {charted.length > 0 ? (
            <Suspense fallback={<ChartSkeleton className="h-40" />}>
              <LearningBars rows={charted} />
            </Suspense>
          ) : null}
          <div>
            <h3 className="text-sm font-semibold">Text alternative: patterns by lift</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {ordered.map((row) => (
                <li key={row.key}>
                  {row.label}: lift {Number.isFinite(row.lift) ? row.lift.toFixed(2) : "not stored"} · {row.direction} · {row.state} · sample size {row.sampleSize} · {row.impressions} impressions · {row.summary}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {publications.length > 0 ? (
        <ul className="mt-3 text-sm">
          {publications.map((item) => (
            <li key={item.externalId}>{copy.learning.testPublication(item.externalId)}</li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-fg-muted">{copy.learning.noTestPublication}</p>}
      {organicPosts.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-accent">Organic social publications</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {organicPosts.map((post) => (
              <li key={post.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                <div>
                  <span className="font-semibold capitalize">{post.platform}</span> · <span className="text-fg-muted">{post.status}</span>
                  <p className="mt-0.5 text-xs text-fg-muted">{post.caption ? post.caption.slice(0, 70) : "No caption"}</p>
                </div>
                <div className="text-xs">
                  <span>{post.views} views · {post.threeSecondViews} (3s hook) · {(post.completionRate * 100).toFixed(1)}% completion · {post.shares} shares</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" disabled={recordingTest || publications.length === 0} onClick={onRecordTest}>
            Record test-provider performance and learn
          </Button>
          <Button type="button" variant="quiet" disabled={recordingOrganic || organicPosts.length === 0} onClick={onRecordOrganic}>
            Record organic telemetry &amp; learn
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
