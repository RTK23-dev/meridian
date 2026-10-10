import { ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "./badge";

export interface BreadcrumbItem { label: string; to?: string }
export function PageHeader({ title, description, breadcrumbs = [], actions, secondaryActions, className }: { title: string; description?: ReactNode; breadcrumbs?: BreadcrumbItem[]; actions?: ReactNode; secondaryActions?: ReactNode; className?: string }) {
  return <header className={cn("mb-6 space-y-3", className)}>
    {breadcrumbs.length ? <nav aria-label="Breadcrumb"><ol className="flex flex-wrap items-center gap-1 text-sm text-fg-muted">{breadcrumbs.map((item, index) => <li key={`${item.label}-${index}`} className="flex items-center gap-1">{index ? <ChevronRight aria-hidden="true" className="size-3" /> : null}{item.to ? <Link to={item.to} className="underline-offset-4 hover:text-fg hover:underline">{item.label}</Link> : <span aria-current="page">{item.label}</span>}</li>)}</ol></nav> : null}
    <div className="flex flex-wrap items-end justify-between gap-4"><div className="space-y-1"><h1 className="font-display text-3xl text-fg sm:text-title">{title}</h1>{description ? <p className="max-w-3xl text-fg-muted">{description}</p> : null}</div><div className="flex items-center gap-2">{secondaryActions}{actions}</div></div>
  </header>;
}

export function Stat({ label, value, delta, description, className }: { label: string; value: ReactNode; delta?: string; description?: string; className?: string }) {
  return <div className={cn("min-w-0", className)}><div className="text-sm text-fg-muted">{label}</div><div className="mt-1 flex flex-wrap items-baseline gap-2"><strong className="font-display text-3xl text-fg">{value}</strong>{delta ? <Badge variant="neutral">{delta}</Badge> : null}</div>{description ? <p className="mt-1 text-xs text-fg-muted">{description}</p> : null}</div>;
}

/** The text alternative for a sparkline: the point count, first and last value, and the range. It only restates stored values. */
export function sparklineSummary(label: string, values: number[]): string {
  if (values.length === 0) return `${label} trend: no points stored.`;
  const format = (value: number) => value.toLocaleString("en", { maximumFractionDigits: 2 });
  const noun = values.length === 1 ? "point" : "points";
  return `${label} trend over ${values.length} ${noun}: first ${format(values[0])}, last ${format(values[values.length - 1])}, lowest ${format(Math.min(...values))}, highest ${format(Math.max(...values))}.`;
}

export function KpiCard(props: Parameters<typeof Stat>[0] & { icon?: ReactNode; sparkline?: number[] }) {
  const { sparkline, ...statProps } = props;
  const min = sparkline ? Math.min(...sparkline) : 0;
  const range = sparkline ? Math.max(...sparkline) - min || 1 : 1;
  const points = sparkline?.map((value, index) => `${(index / Math.max(sparkline.length - 1, 1)) * 100},${28 - ((value - min) / range) * 24}`).join(" ");
  return <div className="rounded-lg border border-border bg-surface p-4">{props.icon ? <div className="mb-3 text-fg-muted">{props.icon}</div> : null}<Stat {...statProps} />{points ? <svg role="img" aria-label={sparklineSummary(props.label, sparkline ?? [])} viewBox="0 0 100 32" className="mt-3 h-8 w-full text-accent"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg> : null}</div>;
}

export type StepState = "done" | "current" | "blocked" | "upcoming";
export function Stepper({ steps, orientation = "horizontal", className }: { steps: Array<{ label: string; state: StepState; description?: string }>; orientation?: "horizontal" | "vertical"; className?: string }) {
  return <ol aria-label="Progress" className={cn("flex", orientation === "vertical" ? "flex-col gap-3" : "flex-wrap gap-2", className)}>{steps.map((step, index) => <li key={`${step.label}-${index}`} aria-current={step.state === "current" ? "step" : undefined} className={cn("flex min-w-0 items-start gap-2 rounded-md border p-3", step.state === "current" ? "border-accent bg-accent-soft" : "border-border bg-surface", step.state === "blocked" && "border-danger/60")}><span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full border border-current text-xs font-semibold">{step.state === "done" ? "✓" : index + 1}</span><span className="min-w-0"><span className="block text-sm font-semibold">{step.label}</span>{step.description ? <span className="block text-xs text-fg-muted">{step.description}</span> : null}</span></li>)}</ol>;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex min-h-6 items-center rounded border border-border-strong bg-surface-2 px-1.5 font-mono text-xs text-fg", className)}>{children}</kbd>;
}
