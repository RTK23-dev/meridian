import { Button, Field, SelectInput, Input } from "@/components/ui";
import { countActiveFilters, NO_LIBRARY_FILTERS, type LibraryFilters } from "./library-model";

const KIND_OPTIONS = [
  { value: "all", label: "All media" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "none", label: "No stored media" },
] as const;

export function LibraryFilterBar({
  filters,
  onChange,
  statuses,
  origins,
  angles,
}: {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  statuses: readonly string[];
  origins: readonly string[];
  angles: readonly string[];
}) {
  const active = countActiveFilters(filters);
  const set = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) => onChange({ ...filters, [key]: value });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Search">
          <Input value={filters.search} onChange={(event) => set("search", event.currentTarget.value)} placeholder="Title, hook, angle" />
        </Field>
        <Field label="Status">
          <SelectInput value={filters.status} onChange={(event) => set("status", event.currentTarget.value)}>
            <option value="all">All statuses</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </SelectInput>
        </Field>
        <Field label="Media">
          <SelectInput value={filters.kind} onChange={(event) => set("kind", event.currentTarget.value)}>
            {KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </SelectInput>
        </Field>
        <Field label="Angle">
          <SelectInput value={filters.angle} onChange={(event) => set("angle", event.currentTarget.value)}>
            <option value="all">All angles</option>
            {angles.map((angle) => <option key={angle} value={angle}>{angle}</option>)}
          </SelectInput>
        </Field>
        <Field label="Origin">
          <SelectInput value={filters.origin} onChange={(event) => set("origin", event.currentTarget.value)}>
            <option value="all">All origins</option>
            {origins.map((origin) => <option key={origin} value={origin}>{origin}</option>)}
          </SelectInput>
        </Field>
        <Field label="Created after">
          <Input type="date" value={filters.createdAfter} onChange={(event) => set("createdAfter", event.currentTarget.value)} />
        </Field>
        <Field label="Created before">
          <Input type="date" value={filters.createdBefore} onChange={(event) => set("createdBefore", event.currentTarget.value)} />
        </Field>
        <div className="flex items-end">
          <Button type="button" variant="quiet" size="md" disabled={active === 0} onClick={() => onChange(NO_LIBRARY_FILTERS)}>
            Clear filters{active ? ` (${active})` : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}
