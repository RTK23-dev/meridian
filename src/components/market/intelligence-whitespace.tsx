import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CheckCircle2, Circle, XCircle, type LucideIcon } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import type { WhitespaceOpportunity } from "@/lib/meridian/jev/account-engine";

type WhitespaceStatus = WhitespaceOpportunity["status"];

const STATUS: Record<WhitespaceStatus, { label: string; variant: "neutral" | "info" | "success" | "danger"; icon: LucideIcon }> = {
  proposed: { label: "Proposed", variant: "neutral", icon: Circle },
  explored: { label: "Explored", variant: "info", icon: Circle },
  accepted: { label: "Accepted", variant: "success", icon: CheckCircle2 },
  rejected: { label: "Rejected", variant: "danger", icon: XCircle },
};

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Highest expected win probability first. Unknown values sort last, so they never rank as zero. */
export function rankWhitespace(items: readonly WhitespaceOpportunity[]): WhitespaceOpportunity[] {
  return [...items].sort((left, right) => {
    const a = finite(left.expectedWinProbability);
    const b = finite(right.expectedWinProbability);
    if (a === null && b === null) return left.unsaturatedAngle.localeCompare(right.unsaturatedAngle);
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a || left.unsaturatedAngle.localeCompare(right.unsaturatedAngle);
  });
}

function percentText(value: number | null): string {
  return value === null ? "Unknown" : `${(value * 100).toFixed(1)}%`;
}

function Meter({ value }: { value: number | null }) {
  if (value === null) return null;
  const width = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return <span aria-hidden="true" className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-surface"><span className="block h-full rounded-full bg-accent" style={{ width: `${width}%` }} /></span>;
}

/** Whitespace as an ordered list. Accept and reject are member actions. Each row's pending state covers only that row. */
export function WhitespaceRanking({ items, brandId, canEdit, pendingIds, onStatus }: {
  items: readonly WhitespaceOpportunity[];
  brandId: string;
  canEdit: boolean;
  pendingIds: string[];
  onStatus: (id: string, status: "accepted" | "rejected") => void;
}) {
  const ranked = rankWhitespace(items);
  return <ol aria-label="Whitespace ranked by expected win probability" className="space-y-3">
    {ranked.map((opportunity, index) => {
      const presentation = STATUS[opportunity.status] ?? STATUS.proposed;
      const StatusIcon = presentation.icon;
      const busy = pendingIds.includes(opportunity.id);
      const probability = finite(opportunity.expectedWinProbability);
      const saturation = finite(opportunity.competitorSaturationScore);
      return <li key={opportunity.id} className="rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold tabular-nums">#{index + 1}</span>
              <Badge variant="neutral" className="capitalize">{opportunity.category || "uncategorised"}</Badge>
              <Badge variant={presentation.variant}><StatusIcon aria-hidden="true" className="size-3.5" />{presentation.label}</Badge>
            </div>
            <h3 className="font-display text-lg capitalize">{opportunity.unsaturatedAngle.replace(/_/g, " ")}</h3>
          </div>
          <Button size="sm" variant="primary" className="h-9 text-xs" asChild>
            <Link to="/brands/$brandId/studio" params={{ brandId }}>Create brief <ArrowUpRight aria-hidden="true" className="ml-1 size-3.5" /></Link>
          </Button>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md bg-surface-2 p-3">
            <dt className="text-xs text-fg-muted">Expected win probability</dt>
            <dd className="mt-1 font-semibold tabular-nums">{percentText(probability)}<Meter value={probability} /></dd>
            <dd className="mt-1 text-[11px] text-fg-muted">Bayesian prior model</dd>
          </div>
          <div className="rounded-md bg-surface-2 p-3">
            <dt className="text-xs text-fg-muted">Competitor saturation</dt>
            <dd className="mt-1 font-semibold tabular-nums">{percentText(saturation)}<Meter value={saturation} /></dd>
            <dd className="mt-1 text-[11px] text-fg-muted">Low saturation is favorable</dd>
          </div>
        </dl>

        {opportunity.supportingEvidence.length ? <div className="mt-4 space-y-1">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Supporting evidence</h4>
          <ul className="list-inside list-disc space-y-0.5 text-xs text-fg-muted">
            {opportunity.supportingEvidence.map((line, lineIndex) => <li key={`${lineIndex}:${line}`}>{line}</li>)}
          </ul>
        </div> : null}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {canEdit ? <>
            {opportunity.status !== "accepted" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => onStatus(opportunity.id, "accepted")}><CheckCircle2 aria-hidden="true" className="size-3.5" />Accept</Button> : null}
            {opportunity.status !== "rejected" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => onStatus(opportunity.id, "rejected")}><XCircle aria-hidden="true" className="size-3.5" />Reject</Button> : null}
          </> : <span className="text-xs text-fg-muted">Viewer role (read-only)</span>}
        </div>
      </li>;
    })}
  </ol>;
}
