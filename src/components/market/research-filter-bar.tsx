import { useState } from "react";
import { format } from "date-fns";
import { DayPicker, type DateRange } from "react-day-picker";
import { Button, Field, Popover, PopoverContent, PopoverTrigger, SelectInput, TextInput } from "@/components/ui";
import { FIELD_FILTERS, META_SOURCE_KEY, META_SOURCE_LABEL, RESEARCH_STATES, parseSeconds, type ResearchFilters } from "./research-model";

type FilterBarProps = {
  filters: ResearchFilters;
  update: <Key extends keyof ResearchFilters>(key: Key, value: ResearchFilters[Key]) => void;
  reset: () => void;
  topics: string[];
  activeCount: number;
  visibleCount: number;
  totalCount: number;
};

/** The filter bar for the analysed-ads list. Every control is labelled and reachable with the keyboard. */
export function ResearchFilterBar({ filters, update, reset, topics, activeCount, visibleCount, totalCount }: FilterBarProps) {
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Search"><TextInput type="search" value={filters.search} onChange={(event) => update("search", event.currentTarget.value)} placeholder="Advertiser, transcript, hook…" /></Field>
      <Field label="Advertiser"><TextInput value={filters.advertiser} onChange={(event) => update("advertiser", event.currentTarget.value)} placeholder="Filter advertiser" /></Field>
      <Field label="Source"><SelectInput value={filters.source} onChange={(event) => update("source", event.currentTarget.value === META_SOURCE_KEY ? META_SOURCE_KEY : "all")}>
        <option value="all">All sources</option>
        <option value={META_SOURCE_KEY}>{META_SOURCE_LABEL}</option>
      </SelectInput></Field>
      <Field label="Research state"><SelectInput value={filters.state} onChange={(event) => update("state", event.currentTarget.value === "all" ? "all" : RESEARCH_STATES.find((item) => item.key === event.currentTarget.value)?.key ?? "all")}>
        <option value="all">All states</option>
        {RESEARCH_STATES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
      </SelectInput></Field>
      <Field label="Angle (topic)"><SelectInput value={filters.topic} onChange={(event) => update("topic", event.currentTarget.value)}>
        <option value="all">All topics</option>
        {topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
      </SelectInput></Field>
      <CapturedDateFilter from={filters.capturedFrom} to={filters.capturedTo} onChange={(range) => { update("capturedFrom", range.from); update("capturedTo", range.to); }} />
    </div>

    <details className="rounded-md border border-border p-3">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold">More filters</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Has analysis field"><SelectInput value={filters.field} onChange={(event) => update("field", event.currentTarget.value)}>
          <option value="all">Any analysis</option>
          {FIELD_FILTERS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </SelectInput></Field>
        <Field label="Minimum analysis confidence"><SelectInput value={String(filters.minimumConfidence)} onChange={(event) => update("minimumConfidence", Number(event.currentTarget.value))}>
          <option value="0">Any confidence</option>
          <option value="0.65">0.65</option>
          <option value="0.8">0.80</option>
        </SelectInput></Field>
        <Field label="Minimum duration (seconds)"><TextInput type="number" min="0" step="1" value={filters.minimumDurationSeconds ?? ""} onChange={(event) => update("minimumDurationSeconds", parseSeconds(event.currentTarget.value))} /></Field>
        <Field label="Maximum duration (seconds)"><TextInput type="number" min="0" step="1" value={filters.maximumDurationSeconds ?? ""} onChange={(event) => update("maximumDurationSeconds", parseSeconds(event.currentTarget.value))} /></Field>
      </div>
    </details>

    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-fg-muted" aria-live="polite">
        Showing {visibleCount} of {totalCount} recent source records{activeCount ? `, with ${activeCount} filter${activeCount === 1 ? "" : "s"} applied` : ""}. Filter labels apply to JEV Research classifications.
      </p>
      {activeCount > 0 ? <Button type="button" variant="quiet" onClick={reset}>Clear filters</Button> : null}
    </div>
  </div>;
}

function dateLabel(from: Date | null, to: Date | null): string {
  if (from && to) return `${format(from, "d MMM yyyy")} to ${format(to, "d MMM yyyy")}`;
  if (from) return `from ${format(from, "d MMM yyyy")}`;
  if (to) return `up to ${format(to, "d MMM yyyy")}`;
  return "any date";
}

/** Capture date range. The calendar is a popover so the rest of the bar stays short on phones. */
function CapturedDateFilter({ from, to, onChange }: { from: Date | null; to: Date | null; onChange: (range: { from: Date | null; to: Date | null }) => void }) {
  const [open, setOpen] = useState(false);
  const selected: DateRange | undefined = from || to ? { from: from ?? undefined, to: to ?? undefined } : undefined;
  return <div className="space-y-2">
    <span className="block text-sm font-semibold text-fg">Captured</span>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary" aria-haspopup="dialog" aria-expanded={open} className="w-full justify-start">
          {from || to ? dateLabel(from, to) : "Any date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-3">
        <DayPicker
          mode="range"
          numberOfMonths={1}
          selected={selected}
          defaultMonth={from ?? to ?? undefined}
          onSelect={(range) => onChange({ from: range?.from ?? null, to: range?.to ?? null })}
          classNames={{
            root: "text-sm text-fg",
            months: "flex flex-col gap-4",
            month: "space-y-3",
            month_caption: "flex h-11 items-center justify-center font-semibold",
            nav: "flex items-center gap-1",
            button_previous: "inline-grid size-11 place-items-center rounded-md hover:bg-surface-2",
            button_next: "inline-grid size-11 place-items-center rounded-md hover:bg-surface-2",
            month_grid: "w-full border-collapse",
            weekday: "w-11 pb-1 text-xs font-semibold text-fg-muted",
            day: "p-0.5 text-center",
            day_button: "size-10 rounded-md hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
            range_middle: "bg-accent-soft",
            range_start: "bg-accent-soft",
            range_end: "bg-accent-soft",
            selected: "font-semibold text-fg",
            today: "underline underline-offset-4",
            outside: "text-fg-muted opacity-60",
            disabled: "opacity-40",
          }}
        />
        <div className="mt-3 flex flex-wrap justify-between gap-2">
          <Button type="button" variant="quiet" size="sm" onClick={() => onChange({ from: null, to: null })}>Clear dates</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}
