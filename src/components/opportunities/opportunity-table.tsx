import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui";
import { CategoryChip, HoldBadge, OpportunityActions, OpportunityStatusBadge, ScoreValue } from "./opportunity-parts";
import { finiteOrNull, isBulkSelectable, isHeld, jevProbability, type OpportunityRow, type OpportunitySortKey, type SortDirection } from "./opportunity-model";

type TableProps = {
  /** Already filtered and sorted. */
  rows: OpportunityRow[];
  positions: Map<string, number>;
  brandId: string;
  canEdit: boolean;
  sortKey: OpportunitySortKey;
  sortDirection: SortDirection;
  onSort: (key: OpportunitySortKey) => void;
  selectedIds: string[];
  onSelectedChange: (id: string, selected: boolean) => void;
  onSelectAll: (ids: string[], selected: boolean) => void;
  onOpen: (id: string) => void;
  dismissingIds: string[];
  onDismiss: (id: string) => void;
};

/** Table on wide screens, one card per opportunity below the sm breakpoint. Both read the same rows and state. */
export function OpportunityTable(props: TableProps) {
  const { rows, positions, brandId, canEdit, sortKey, sortDirection, onSort, selectedIds, onSelectedChange, onSelectAll, onOpen, dismissingIds, onDismiss } = props;
  const selectableIds = rows.filter((item) => canEdit && isBulkSelectable(item.status)).map((item) => item.id);
  const selectedVisible = selectableIds.filter((id) => selectedIds.includes(id));
  const allSelected = selectableIds.length > 0 && selectedVisible.length === selectableIds.length;

  return <>
    <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Opportunities for this brand. Use the column buttons to sort. A missing JEV probability is marked Unknown.</caption>
        <thead className="bg-surface-2">
          <tr>
            {canEdit ? <th scope="col" className="w-12 px-3 py-2"><SelectAllBox checked={allSelected} indeterminate={selectedVisible.length > 0 && !allSelected} label="Select all dismissable opportunities" onChange={(selected) => onSelectAll(selectableIds, selected)} /></th> : null}
            <th scope="col" className="px-3 py-2 font-semibold">#</th>
            <th scope="col" className="px-3 py-2 font-semibold">Opportunity</th>
            <SortHeader label="Rank score" sortKey="rank" active={sortKey === "rank"} direction={sortDirection} onSort={onSort} />
            <SortHeader label="Confidence" sortKey="confidence" active={sortKey === "confidence"} direction={sortDirection} onSort={onSort} />
            <SortHeader label="JEV probability" sortKey="probability" active={sortKey === "probability"} direction={sortDirection} onSort={onSort} />
            <SortHeader label="Status" sortKey="status" active={sortKey === "status"} direction={sortDirection} onSort={onSort} />
            <SortHeader label="Risk" sortKey="risk" active={sortKey === "risk"} direction={sortDirection} onSort={onSort} />
            <th scope="col" className="px-3 py-2 font-semibold"><span>Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const eligible = canEdit && isBulkSelectable(item.status);
            return <tr key={item.id} className="align-top hover:bg-surface-2">
              {canEdit ? <td className="px-3 py-3">{eligible ? <input type="checkbox" className="size-6 pointer-coarse:size-11" aria-label={`Select ${item.label} for bulk dismiss`} checked={selectedIds.includes(item.id)} onChange={(event) => onSelectedChange(item.id, event.currentTarget.checked)} /> : null}</td> : null}
              <td className="px-3 py-3 tabular-nums">{positions.get(item.id) ?? "-"}</td>
              <td className="min-w-56 px-3 py-3">
                <button type="button" onClick={() => onOpen(item.id)} className="inline-flex min-h-6 items-center text-left font-semibold underline-offset-4 hover:underline pointer-coarse:min-h-11">{item.label}</button>
                <div className="mt-2 flex flex-wrap gap-2"><CategoryChip category={item.category} />{isHeld(item) ? <HoldBadge /> : null}</div>
              </td>
              <td className="px-3 py-3"><ScoreValue value={finiteOrNull(item.expectedValue)} /></td>
              <td className="px-3 py-3"><ScoreValue value={finiteOrNull(item.confidence)} /></td>
              <td className="px-3 py-3"><ScoreValue value={jevProbability(item)} /></td>
              <td className="px-3 py-3"><OpportunityStatusBadge status={item.status} /></td>
              <td className="px-3 py-3"><ScoreValue value={finiteOrNull(item.risk)} /></td>
              <td className="px-3 py-3"><div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(item.id)}>Details<span className="sr-only"> for {item.label}</span></Button>
                <OpportunityActions brandId={brandId} item={item} canEdit={canEdit} dismissing={dismissingIds.includes(item.id)} onDismiss={onDismiss} />
              </div></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    <ul className="grid gap-3 sm:hidden">
      {rows.map((item) => {
        const eligible = canEdit && isBulkSelectable(item.status);
        return <li key={item.id} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-fg-muted">Rank {positions.get(item.id) ?? "-"}</p>
            <OpportunityStatusBadge status={item.status} />
          </div>
          <button type="button" onClick={() => onOpen(item.id)} className="block min-h-11 w-full text-left font-display text-xl">{item.label}</button>
          <div className="flex flex-wrap gap-2"><CategoryChip category={item.category} />{isHeld(item) ? <HoldBadge /> : null}</div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs font-semibold text-fg-muted">Rank score</dt><dd className="mt-1"><ScoreValue value={finiteOrNull(item.expectedValue)} /></dd></div>
            <div><dt className="text-xs font-semibold text-fg-muted">Confidence</dt><dd className="mt-1"><ScoreValue value={finiteOrNull(item.confidence)} /></dd></div>
            <div><dt className="text-xs font-semibold text-fg-muted">JEV probability</dt><dd className="mt-1"><ScoreValue value={jevProbability(item)} /></dd></div>
            <div><dt className="text-xs font-semibold text-fg-muted">Risk</dt><dd className="mt-1"><ScoreValue value={finiteOrNull(item.risk)} /></dd></div>
          </dl>
          {eligible ? <label className="inline-flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" className="size-6 pointer-coarse:size-11" checked={selectedIds.includes(item.id)} onChange={(event) => onSelectedChange(item.id, event.currentTarget.checked)} />
            Select for bulk dismiss
          </label> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpen(item.id)}>Details<span className="sr-only"> for {item.label}</span></Button>
            <OpportunityActions brandId={brandId} item={item} canEdit={canEdit} dismissing={dismissingIds.includes(item.id)} onDismiss={onDismiss} />
          </div>
        </li>;
      })}
    </ul>
  </>;
}

function SortHeader({ label, sortKey, active, direction, onSort }: {
  label: string;
  sortKey: OpportunitySortKey;
  active: boolean;
  direction: SortDirection;
  onSort: (key: OpportunitySortKey) => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  const ariaSort = !active ? "none" : direction === "asc" ? "ascending" : "descending";
  return <th scope="col" aria-sort={ariaSort} className="px-3 py-2 font-semibold whitespace-nowrap">
    <button type="button" onClick={() => onSort(sortKey)} className="inline-flex min-h-10 items-center gap-1.5 rounded pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-accent">
      {label}<Icon aria-hidden="true" className="size-3.5 opacity-70" />
    </button>
  </th>;
}

/** The header checkbox shows the mixed state when only some dismissable rows are selected. */
function SelectAllBox({ checked, indeterminate, label, onChange }: { checked: boolean; indeterminate: boolean; label: string; onChange: (selected: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" className="size-6 pointer-coarse:size-11" aria-label={label} checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />;
}
