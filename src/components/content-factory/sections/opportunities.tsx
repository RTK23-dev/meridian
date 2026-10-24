import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, DisabledReason, EmptyState, ErrorState, Field, Card, ScreenSkeleton, SelectInput, Textarea } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { copy, plainError } from "@/lib/copy";
import { hasRole } from "@/lib/meridian/access";
import { refreshOpportunities } from "@/lib/meridian/machine";
import { useDismissOpportunities, useOpportunitiesQuery, useScopedMutation, useTriageOpportunity } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { downloadCsv } from "@/lib/csv";
import { directionReasonProblem } from "@/lib/meridian/opportunity/direction-reason";
import { usePageCommands } from "@/components/page-commands";
import { CategoryFilter, CategoryLegend, HoldBanner } from "@/components/opportunities/opportunity-parts";
import { OpportunitySheet } from "@/components/opportunities/opportunity-sheet";
import { OpportunityTable } from "@/components/opportunities/opportunity-table";
import {
  filterOpportunities,
  isBulkSelectable,
  isHeld,
  jevProbability,
  rankPositions,
  sortOpportunities,
  type OpportunityCategory,
  type OpportunitySortKey,
  type SortDirection,
} from "@/components/opportunities/opportunity-model";

const SORT_OPTIONS: Array<{ key: OpportunitySortKey; label: string }> = [
  { key: "rank", label: "Rank score" },
  { key: "confidence", label: "Confidence" },
  { key: "probability", label: "JEV probability" },
  { key: "status", label: "Status" },
  { key: "risk", label: "Risk" },
];

type CsvRow = {
  opportunity: string;
  evidenceCategory: string;
  status: string;
  rankScore: number;
  jevDecision: string;
  probability: number | string;
  evidenceConfidence: number;
  risk: number;
  reason: string;
};

export function Opportunities({ brandId }: { brandId: string }) {
  const query = useOpportunitiesQuery(brandId);
  const rows = query.data?.opportunities ?? null;
  const role = query.data?.role ?? "viewer";
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [category, setCategory] = useState<OpportunityCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<OpportunitySortKey>("rank");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const refresh = useScopedMutation({
    mutationKey: ["mutation", "opportunities.refresh", brandId],
    mutationFn: () => refreshOpportunities({ data: { brandId } }),
    // Scoring replaces the open cards, which also moves the brand overview counts and the studio recommendation.
    invalidate: () => [qk.opportunities(brandId), qk.machine(brandId), qk.studio(brandId)],
    onSuccess: (result) => setNote(copy.opportunities.rankedNote(result.count, result.suppressed)),
  });
  const dismiss = useDismissOpportunities(brandId);
  const triage = useTriageOpportunity(brandId);
  const canEdit = hasRole(role, "member");
  // The palette runs the same scoring mutation as the button, and only for roles that see the button.
  usePageCommands(canEdit ? [{ id: "score-opportunities", label: copy.opportunities.rankAction, run: () => { void refresh.mutateAsync().catch(() => undefined); } }] : []);

  if (query.isError && !rows) {
    const failure = plainError(query.error);
    return <ErrorState message={failure.message} detail={failure.raw} onRetry={() => void query.refetch()} />;
  }
  if (!rows) return <ScreenSkeleton label="Loading opportunities" shape="cards" />;

  const positions = rankPositions(rows);
  const visibleRows = sortOpportunities(filterOpportunities(rows, { category, status: statusFilter }), sortKey, sortDirection);
  const selectedOpportunity = rows.find((item) => item.id === openId) ?? null;
  const selectedPosition = selectedOpportunity ? positions.get(selectedOpportunity.id) ?? null : null;
  // A bulk decline acts only on the rows on screen. A selected row that a filter hides is not declined, because the person cannot see it.
  const selectedEligible = selectedIds.filter((id) => visibleRows.some((item) => item.id === id && canEdit && isBulkSelectable(item.status)));
  const hasHold = rows.some(isHeld);

  function chooseSort(key: OpportunitySortKey) {
    if (key === sortKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setSortDirection(key === "status" ? "asc" : "desc");
  }

  // Changing a filter clears the selection, so a bulk action never reaches a row the person has stopped looking at.
  function changeCategory(next: OpportunityCategory | "all") {
    setCategory(next);
    setSelectedIds([]);
  }

  function changeStatusFilter(next: string) {
    setStatusFilter(next);
    setSelectedIds([]);
  }

  function declineSelected() {
    void dismiss.mutateAsync({ opportunityIds: selectedEligible, reason: bulkReason.trim() }).then(
      () => {
        setSelectedIds([]);
        setBulkOpen(false);
        setBulkReason("");
      },
      () => undefined,
    );
  }

  function setSelected(id: string, selected: boolean) {
    setSelectedIds((current) => selected ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  }

  function setSelectedAll(ids: string[], selected: boolean) {
    setSelectedIds((current) => selected ? [...new Set([...current, ...ids])] : current.filter((value) => !ids.includes(value)));
  }

  function exportVisible() {
    const csvRows: CsvRow[] = visibleRows.map((item) => ({
      opportunity: item.label,
      evidenceCategory: item.category,
      status: item.status,
      rankScore: item.expectedValue,
      jevDecision: item.decision || "None stored",
      probability: jevProbability(item) ?? "Unknown",
      evidenceConfidence: item.confidence,
      risk: item.risk,
      reason: item.reason,
    }));
    downloadCsv("meridian-opportunities.csv", [
      { key: "opportunity", label: "Opportunity" }, { key: "evidenceCategory", label: "Evidence category" }, { key: "status", label: "Status" },
      { key: "rankScore", label: "Rank score" }, { key: "jevDecision", label: "JEV decision" }, { key: "probability", label: "Probability" },
      { key: "evidenceConfidence", label: "Evidence confidence" }, { key: "risk", label: "Risk" }, { key: "reason", label: "Reason" },
    ], csvRows);
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-3">
          <p className="eyebrow">Opportunities</p>
          <h1 className="page-title">What to make next</h1>
          <p className="text-muted">
            {copy.opportunities.intro}{" "}
            Make image and video variants in <Link className="font-semibold" to="/brands/$brandId/content" params={{ brandId }} search={{ section: "create", preset: "studio" }}>Studio</Link>, not from a script form.
          </p>
        </div>
        {canEdit ? (
          <Button
            disabled={refresh.isPending}
            onClick={() => {
              void refresh.mutateAsync().catch(() => undefined);
            }}
          >
            {refresh.isPending ? copy.opportunities.rankingAction : copy.opportunities.rankAction}
          </Button>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {refresh.error ? <PlainErrorNotice error={refresh.error} /> : null}
      {dismiss.error ? <PlainErrorNotice error={dismiss.error} /> : null}
      {triage.error ? <PlainErrorNotice error={triage.error} /> : null}
      {hasHold ? <HoldBanner brandId={brandId} /> : null}
      {rows.length === 0 ? (
        <EmptyState
          title={canEdit ? "Rank opportunities to fill this list" : "No opportunities ranked yet"}
          reason={copy.opportunities.empty}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CategoryFilter value={category} onChange={changeCategory} />
            <CategoryLegend />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Status"><SelectInput value={statusFilter} onChange={(event) => changeStatusFilter(event.currentTarget.value)}><option value="all">All statuses</option><option value="open">Open</option><option value="accepted">Accepted</option><option value="briefed">Briefed</option><option value="dismissed">Dismissed</option><option value="rejected">Rejected</option><option value="saved">Saved</option><option value="deferred">Deferred</option><option value="needs_research">Needs research</option></SelectInput></Field>
            <Field label="Sort by"><SelectInput value={sortKey} onChange={(event) => chooseSort(event.currentTarget.value as OpportunitySortKey)}>{SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</SelectInput></Field>
            <Button type="button" variant="secondary" onClick={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")}>
              Direction: {sortDirection === "asc" ? "ascending" : "descending"}
            </Button>
            <Button type="button" variant="quiet" disabled={!visibleRows.length} aria-describedby={visibleRows.length ? undefined : "opportunity-export-reason"} onClick={exportVisible}>Export visible opportunities</Button>
            {visibleRows.length ? null : <DisabledReason id="opportunity-export-reason" className="basis-full">No opportunities match these filters, so there is nothing to export. Clear the filters to export them.</DisabledReason>}
            {canEdit && selectedEligible.length && !bulkOpen ? <Button variant="secondary" onClick={() => setBulkOpen(true)}>Decline selected ({selectedEligible.length})</Button> : null}
            {canEdit && selectedEligible.length && bulkOpen ? (
              <form
                className="basis-full space-y-3 rounded-md border border-border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (directionReasonProblem(bulkReason) === null) declineSelected();
                }}
              >
                <Textarea
                  id="bulk-decline-reason"
                  label={`Why are these ${selectedEligible.length} ideas declined?`}
                  hint="The reason is kept with each decision. A declined idea does not come back on later scoring, and it cannot be reopened on this screen."
                  value={bulkReason}
                  onChange={(event) => setBulkReason(event.currentTarget.value)}
                  rows={2}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="secondary" disabled={dismiss.isPending || directionReasonProblem(bulkReason) !== null}>
                    Decline {selectedEligible.length} {selectedEligible.length === 1 ? "idea" : "ideas"}
                  </Button>
                  <Button type="button" variant="quiet" onClick={() => setBulkOpen(false)}>Cancel</Button>
                </div>
              </form>
            ) : null}
            <p className="text-sm text-muted" aria-live="polite">{visibleRows.length} of {rows.length} opportunities</p>
          </div>
          {visibleRows.length === 0 ? (
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">No opportunities match these filters.</p>
              <Button type="button" variant="secondary" onClick={() => { changeCategory("all"); changeStatusFilter("all"); }}>Clear filters</Button>
            </Card>
          ) : (
            <OpportunityTable
              rows={visibleRows}
              positions={positions}
              brandId={brandId}
              canEdit={canEdit}
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSort={chooseSort}
              selectedIds={selectedIds}
              onSelectedChange={setSelected}
              onSelectAll={setSelectedAll}
              onOpen={setOpenId}
              triaging={triage.isPending}
              onTriage={(id, action, reason) => triage.mutateAsync({ opportunityId: id, action, reason })}
            />
          )}
          <OpportunitySheet
            item={selectedOpportunity}
            position={selectedPosition}
            brandId={brandId}
            canEdit={canEdit}
            triaging={triage.isPending}
            onTriage={(id, action, reason) => triage.mutateAsync({ opportunityId: id, action, reason }).then(() => setOpenId(null), () => undefined)}
            onOpenChange={(open) => { if (!open) setOpenId(null); }}
          />
        </>
      )}
    </div>
  );
}
