import { Link } from "@tanstack/react-router";
import { CircleDashed, Clock, FileText, Info, Layers, Sparkles, XCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { statusLabel } from "@/lib/copy";
import { CATEGORY_LEGEND, barPercent, canDismiss, categoryLabel, type OpportunityCategory, type OpportunityRow } from "./opportunity-model";

/** A value that is not stored. It is always written out, never drawn as an empty bar or a zero. */
export function UnknownValue() {
  return <span className="inline-flex items-center gap-1.5 text-fg-muted"><CircleDashed aria-hidden="true" className="size-3.5" />Unknown</span>;
}

/** A 0 to 1 value with a bar. The number is the accessible value; the bar is decoration. */
export function ScoreValue({ value }: { value: number | null }) {
  if (value === null) return <UnknownValue />;
  const percent = barPercent(value) ?? 0;
  return <span className="inline-flex items-center gap-2 tabular-nums"><span aria-hidden="true" className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} /></span><span>{value.toFixed(2)}</span></span>;
}

const CATEGORY_CHIP: Record<OpportunityCategory, { variant: "info" | "success" | "neutral"; icon: LucideIcon }> = {
  discovered: { variant: "info", icon: Sparkles },
  supported: { variant: "success", icon: Layers },
  hypothesis: { variant: "neutral", icon: Info },
};

/** Category as text with an icon. Colour is never the only signal. */
export function CategoryChip({ category }: { category: string }) {
  const known = CATEGORY_CHIP[category as OpportunityCategory];
  const Icon = known?.icon ?? Info;
  return <Badge variant={known?.variant ?? "neutral"}><Icon aria-hidden="true" className="size-3.5" />{categoryLabel(category)}</Badge>;
}

const STATUS_BADGE: Record<string, { variant: "info" | "success" | "danger" | "neutral"; icon: LucideIcon }> = {
  open: { variant: "info", icon: Clock },
  accepted: { variant: "success", icon: CheckCircle2 },
  briefed: { variant: "success", icon: FileText },
  dismissed: { variant: "neutral", icon: CircleDashed },
  rejected: { variant: "danger", icon: XCircle },
};

export function OpportunityStatusBadge({ status }: { status: string }) {
  const known = STATUS_BADGE[status];
  const Icon = known?.icon ?? Info;
  return <Badge variant={known?.variant ?? "neutral"}><Icon aria-hidden="true" className="size-3.5" />{statusLabel(status)}</Badge>;
}

export function HoldBadge() {
  return <Badge variant="warning"><Clock aria-hidden="true" className="size-3.5" />On hold</Badge>;
}

/** The server reports a hold, so the banner appears only when at least one row is held. */
export function HoldBanner({ brandId }: { brandId: string }) {
  return <section aria-labelledby="opportunity-hold-title" className="rounded-lg border border-brass/60 bg-panel p-4">
    <h2 id="opportunity-hold-title" className="font-semibold">On hold: clear under Reviews</h2>
    <p className="mt-1 text-sm text-muted">A human review decision is blocking these opportunities from moving to a brief.</p>
    <Link className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/brands/$brandId/reviews" params={{ brandId }}>Open the review queue</Link>
  </section>;
}

/** Explains the three categories. The popover is a button, so it works with the keyboard and on touch. */
export function CategoryLegend() {
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="quiet" size="sm"><Info aria-hidden="true" className="size-4" />What the categories mean</Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="max-w-sm space-y-3">
      <h2 className="font-semibold">Categories</h2>
      <dl className="space-y-3 text-sm">
        {CATEGORY_LEGEND.map((item) => <div key={item.key}><dt className="font-semibold">{item.label}</dt><dd className="text-muted">{item.description}</dd></div>)}
      </dl>
    </PopoverContent>
  </Popover>;
}

export function CategoryFilter({ value, onChange }: { value: OpportunityCategory | "all"; onChange: (value: OpportunityCategory | "all") => void }) {
  const options: Array<{ key: OpportunityCategory | "all"; label: string }> = [{ key: "all", label: "All" }, ...CATEGORY_LEGEND.map((item) => ({ key: item.key, label: item.label }))];
  return <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
    {options.map((option) => <Button key={option.key} type="button" size="sm" variant={value === option.key ? "primary" : "secondary"} aria-pressed={value === option.key} onClick={() => onChange(option.key)}>{option.label}</Button>)}
  </div>;
}

/** Studio and dismiss are member actions. Viewers see the state and nothing they cannot change. */
export function OpportunityActions({ brandId, item, canEdit, dismissing, onDismiss }: {
  brandId: string;
  item: Pick<OpportunityRow, "id" | "label" | "status">;
  canEdit: boolean;
  dismissing: boolean;
  onDismiss: (id: string) => void;
}) {
  if (!canEdit) return <span className="text-sm text-muted">Read-only for viewers.</span>;
  if (!canDismiss(item.status)) return null;
  return <>
    <Link to="/brands/$brandId/studio" params={{ brandId }} className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-fg">
      Open in Studio<span className="sr-only"> for {item.label}</span>
    </Link>
    <Button type="button" variant="quiet" disabled={dismissing} onClick={() => onDismiss(item.id)}>Dismiss<span className="sr-only"> {item.label}</span></Button>
  </>;
}
