import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type RowSelectionState, type SortingState, type VisibilityState } from "@tanstack/react-table";
import { useState, type Dispatch, type SetStateAction } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from "lucide-react";
import { cn } from "@/lib/cn";
import { EmptyState, Skeleton, ErrorState } from "./feedback";

export function DataTable<TData>({ data, columns, getRowId, loading = false, error, onRetry, emptyTitle = "Nothing to show yet", emptyReason = "There are no records for this view.", selectable = false, onRowSelectionChange, className }: {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  getRowId?: (row: TData, index: number) => string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyReason?: string;
  selectable?: boolean;
  onRowSelectionChange?: Dispatch<SetStateAction<RowSelectionState>>;
  className?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const selectionColumn: ColumnDef<TData, unknown> = {
    id: "select",
    enableSorting: false,
    header: ({ table: current }) => <input type="checkbox" className="size-6 pointer-coarse:size-11" aria-label="Select all rows" checked={current.getIsAllRowsSelected()} ref={(element) => { if (element) element.indeterminate = current.getIsSomeRowsSelected(); }} onChange={current.getToggleAllRowsSelectedHandler()} />,
    cell: ({ row }) => <input type="checkbox" className="size-6 pointer-coarse:size-11" aria-label={`Select row ${row.id}`} checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />,
  };
  const table = useReactTable({ data, columns: selectable ? [selectionColumn, ...columns] : columns, state: { sorting, columnVisibility, rowSelection }, onSortingChange: setSorting, onColumnVisibilityChange: setColumnVisibility, onRowSelectionChange: (updater) => { setRowSelection(updater); onRowSelectionChange?.(updater); }, enableRowSelection: selectable, getRowId, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading) return <div role="status" aria-label="Loading records" className="space-y-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} variant="table-row" />)}</div>;
  if (!data.length) return <EmptyState title={emptyTitle} reason={emptyReason} />;

  return <div className={cn("space-y-3", className)}>
    <details className="relative ml-auto w-fit text-sm"><summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded border border-border px-3 pointer-coarse:min-h-11"><Columns3 aria-hidden="true" className="size-4" />Columns</summary><div className="absolute right-0 z-10 mt-1 grid min-w-40 gap-2 rounded border border-border bg-surface p-3 shadow-md">{table.getAllLeafColumns().map((column) => <label key={column.id} className="flex min-h-6 items-center gap-2 pointer-coarse:min-h-11"><input type="checkbox" className="size-6 pointer-coarse:size-11" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} />{column.id}</label>)}</div></details>
    <div className="hidden overflow-x-auto rounded-lg border border-border sm:block"><table className="w-full border-collapse text-left text-sm"><thead className="sticky top-0 bg-surface-2"><tr>{table.getHeaderGroups().flatMap((group) => group.headers).map((header) => <th key={header.id} scope="col" className="border-b border-border px-3 py-2 font-semibold">{header.isPlaceholder ? null : header.column.getCanSort() ? <button type="button" className="inline-flex min-h-9 items-center gap-1 pointer-coarse:min-h-11" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === "asc" ? <ArrowUp className="size-3.5" /> : header.column.getIsSorted() === "desc" ? <ArrowDown className="size-3.5" /> : <ArrowUpDown className="size-3.5 opacity-60" />}</button> : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr></thead><tbody>{table.getRowModel().rows.map((row) => <tr key={row.id} tabIndex={0} className="focus-visible:bg-accent-soft hover:bg-surface-2">{row.getVisibleCells().map((cell) => <td key={cell.id} className="border-b border-border px-3 py-2 align-top">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>
    <ul className="grid gap-3 sm:hidden">{table.getRowModel().rows.map((row) => <li key={row.id} tabIndex={0} className="rounded-lg border border-border bg-surface p-3 focus-visible:outline-2 focus-visible:outline-accent">{row.getVisibleCells().map((cell) => {
      const header = table.getFlatHeaders().find((item) => item.column.id === cell.column.id);
      return <div key={cell.id} className="grid grid-cols-[minmax(6rem,35%)_1fr] gap-2 border-b border-border py-2 last:border-b-0"><span className="text-xs font-semibold text-fg-muted">{header ? flexRender(header.column.columnDef.header, header.getContext()) : cell.column.id}</span><span className="min-w-0">{flexRender(cell.column.columnDef.cell, cell.getContext())}</span></div>;
    })}</li>)}</ul>
  </div>;
}
