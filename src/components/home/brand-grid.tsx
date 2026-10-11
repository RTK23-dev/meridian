import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Search } from "lucide-react";
import { Badge, Button, EmptyState, SelectInput, Skeleton, Input } from "@/components/ui";
import type { BrandSummary } from "@/lib/meridian/workspace/actions";
import type { MachineSnapshot } from "@/lib/meridian/machine";
import { doneCount, pipelineStages, type PipelineStage } from "@/components/brand-overview/pipeline";
import { relativeTime, visibleBrands, type BrandSort } from "./home-model";

export type MachineState = { status: "loading" } | { status: "error" } | { status: "ready"; snapshot: MachineSnapshot };
export type BrandLookup = { machine: MachineState };

export function BrandGrid({ brands, lookup, canCreate, newBrandLink }: {
  brands: BrandSummary[];
  lookup: (brandId: string) => BrandLookup | undefined;
  canCreate: boolean;
  newBrandLink?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<BrandSort>("activity");
  const visible = useMemo(() => visibleBrands(brands, search, sort), [brands, search, sort]);

  return (
    <section aria-labelledby="brands-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="brands-title" className="text-section font-semibold">Brands</h2>
          <p className="mt-1 text-sm text-fg-muted">Open a brand to continue its research and creative work.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="relative block">
            <span className="sr-only">Search brands</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
            <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search brands" className="min-h-11 pl-9" />
          </label>
          <label className="text-xs font-medium text-fg-muted">
            Sort by
            <SelectInput aria-label="Sort brands" className="mt-1 min-h-11 w-auto py-2" value={sort} onChange={(event) => setSort(event.target.value as BrandSort)}>
              <option value="activity">Recent activity</option>
              <option value="name">Name</option>
              <option value="completeness">Completeness</option>
            </SelectInput>
          </label>
          {newBrandLink}
        </div>
      </div>
      {brands.length === 0 ? (
        <EmptyState title="No brands yet" reason="Add a brand you actually work on. Meridian will not fill this list with guessed information." action={canCreate ? <Button asChild><Link to="/brands/new">Create a brand</Link></Button> : undefined} />
      ) : visible.length === 0 ? (
        <EmptyState title="No matching brands" reason="Try another name, industry, or product description." />
      ) : (
        <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {visible.map((brand) => <BrandCard key={brand.id} brand={brand} lookup={lookup(brand.id)} />)}
        </ul>
      )}
    </section>
  );
}

function BrandCard({ brand, lookup }: { brand: BrandSummary; lookup: BrandLookup | undefined }) {
  const machine = lookup?.machine ?? { status: "loading" as const };
  return (
    <li>
      <Link to="/brands/$brandId" params={{ brandId: brand.id }} className="group block h-full rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent hover:shadow-sm">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent-soft text-lg font-semibold text-accent">
            {brand.name.trim().slice(0, 1).toLocaleUpperCase() || "B"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="truncate text-section font-semibold text-fg group-hover:text-accent">{brand.name}</h3>
              <CompletenessRing value={brand.completeness} />
            </div>
            <p className="mt-1 line-clamp-2 min-h-10 text-sm text-fg-muted">{brand.sells || brand.industry || "No description yet."}</p>
          </div>
        </div>
        <div className="mt-4 space-y-2 border-t border-border pt-3">
          <PipelineProgress machine={machine} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
            <ReviewBadge machine={machine} />
            <span>{brand.updatedAt ? `Updated ${relativeTime(brand.updatedAt)}` : "No recorded update time"}</span>
          </div>
        </div>
        <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-accent">
          Open brand <ArrowRight aria-hidden="true" className="size-4" />
        </span>
      </Link>
    </li>
  );
}

/** The ring is announced as a percentage, so it does not depend on colour to be read. */
export function CompletenessRing({ value }: { value: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      role="img"
      aria-label={`${percent}% complete`}
      className="grid size-11 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-fg"
      style={{ background: `conic-gradient(var(--color-accent) ${percent}%, var(--color-border) 0)` }}
    >
      <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-surface">{percent}%</span>
    </span>
  );
}

function PipelineProgress({ machine }: { machine: MachineState }) {
  if (machine.status === "loading") {
    return <div role="status" aria-label="Loading pipeline"><Skeleton className="h-2 w-full" /></div>;
  }
  if (machine.status === "error") {
    return <p className="text-xs text-fg-muted">Pipeline could not be loaded.</p>;
  }
  const stages = pipelineStages({ counts: machine.snapshot.counts, operating: machine.snapshot.operating });
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-fg-muted">{summary(stages)}</p>
      <div role="img" aria-label={summary(stages)} className="flex gap-1">
        {stages.map((stage) => <span key={stage.key} aria-hidden="true" className={`h-2 flex-1 rounded-full ${segmentClass(stage)}`} />)}
      </div>
    </div>
  );
}

function summary(stages: PipelineStage[]): string {
  const done = doneCount(stages);
  const progressing = stages.filter((stage) => stage.state === "in_progress").length;
  const blocked = stages.filter((stage) => stage.state === "blocked").length;
  const parts = [`${done} of ${stages.length} pipeline stages done`];
  if (progressing) parts.push(`${progressing} in progress`);
  if (blocked) parts.push(`${blocked} blocked`);
  return parts.join(", ");
}

function segmentClass(stage: PipelineStage): string {
  if (stage.state === "done") return "bg-accent";
  if (stage.state === "in_progress") return "bg-accent/40";
  if (stage.state === "blocked") return "border border-dashed border-border-strong bg-transparent";
  return "bg-surface-2";
}

function ReviewBadge({ machine }: { machine: MachineState }) {
  if (machine.status === "loading") return <span>Loading reviews…</span>;
  if (machine.status === "error") return <span>Reviews unavailable</span>;
  const open = machine.snapshot.counts.reviews;
  return open > 0
    ? <Badge variant="warning">{open} open review{open === 1 ? "" : "s"}</Badge>
    : <span>No open reviews</span>;
}
