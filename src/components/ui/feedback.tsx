import { AlertTriangle, CircleAlert, PlugZap } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { toast, Toaster as SonnerToaster } from "sonner";
import { cn } from "./cn";
import { Button } from "./button";
import { Card } from "./card";

/** Toasts sit bottom-right on the overlay surface; their colours and edges come from the stylesheet. */
export function Toaster(props: ComponentProps<typeof SonnerToaster>) {
  return <SonnerToaster closeButton position="bottom-right" {...props} />;
}
export { toast };

export function Skeleton({ variant = "line", className, ...props }: HTMLAttributes<HTMLDivElement> & { variant?: "line" | "card" | "table-row" | "media" }) {
  const shapes = { line: "h-4 w-full", card: "h-32 w-full", "table-row": "h-10 w-full", media: "aspect-video w-full" };
  return <div {...props} aria-hidden="true" className={cn("rounded-sharp bg-raised", shapes[variant], className)} />;
}

/** Fallback while a chart module loads. It fills the plot's box, so the page does not jump when the chart arrives. */
export function ChartSkeleton({ label = "Loading chart", className }: { label?: string; className?: string }) {
  return <div role="status" aria-label={label} className={cn("grid h-full w-full place-items-center", className)}><Skeleton className="h-full w-full" /></div>;
}

/** Loading state shaped like a screen: a header block, then cards, rows or a form. The region is announced once with its label. */
export function ScreenSkeleton({ label, shape = "cards", className }: { label: string; shape?: "cards" | "rows" | "form"; className?: string }) {
  return <div role="status" aria-label={label} className={cn("space-y-6", className)}>
    <div className="space-y-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-9 w-72 max-w-full" />
      <Skeleton className="h-4 w-full max-w-xl" />
    </div>
    {shape === "cards" ? <div className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((index) => <Skeleton key={index} variant="card" />)}</div> : null}
    {shape === "rows" ? <div className="space-y-3">{[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} variant="table-row" />)}</div> : null}
    {shape === "form" ? <Skeleton variant="card" className="h-72" /> : null}
  </div>;
}

/** Two short sentences and one action. The icon, if given, sits beside the title with no bubble around it. */
export function EmptyState({ icon, title, reason, action, className }: { icon?: ReactNode; title: string; reason: string; action?: ReactNode; className?: string }) {
  return <Card className={cn("flex flex-col items-start gap-3 p-6", className)}>
    {icon ? <span className="text-fg-muted">{icon}</span> : null}
    <h2 className="font-display text-section font-semibold text-fg">{title}</h2>
    <p className="max-w-lg text-small text-fg-muted">{reason}</p>
    {action}
  </Card>;
}

export function ErrorState({ message = "We could not load this information.", requestId, detail, onRetry, className }: { message?: string; requestId?: string; detail?: string; onRetry?: () => void; className?: string }) {
  return <Card role="alert" className={cn("space-y-3 border-danger", className)}>
    <div className="flex min-w-0 items-start gap-3"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" /><div className="min-w-0"><h2 className="text-heading font-semibold">Something went wrong</h2><p className="mt-1 break-words text-small text-fg-muted [overflow-wrap:anywhere]">{message}</p></div></div>
    {onRetry ? <Button size="md" variant="secondary" onClick={onRetry}>Try again</Button> : null}
    {requestId ? <p className="text-caption text-fg-muted">Request ID: <code className="font-mono">{requestId}</code></p> : null}
    {detail ? <details className="text-small"><summary className="cursor-pointer text-fg-muted">Details</summary><pre className="mt-2 overflow-auto rounded-sharp bg-raised p-3 font-mono text-data-s">{detail}</pre></details> : null}
  </Card>;
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-small text-danger" role="alert"><AlertTriangle aria-hidden="true" className="size-4" />{children}</p>;
}

/** Plain words for any thrown value. Used wherever a failed request is shown to a person. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong.";
}

/** A connection that is missing is said in words, in the warning colour, with the plug icon. */
export function NotConnected({ service = "This service" }: { service?: string }) {
  return <p className="flex items-center gap-2 text-small text-warning"><PlugZap aria-hidden="true" className="size-4" />{service} is not connected.</p>;
}
