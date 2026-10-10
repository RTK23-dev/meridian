import { AlertTriangle, CircleAlert, FileQuestion, PlugZap } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { toast, Toaster as SonnerToaster } from "sonner";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { Card } from "./card";

export function Toaster(props: ComponentProps<typeof SonnerToaster>) {
  return <SonnerToaster richColors closeButton position="top-right" {...props} />;
}
export { toast };

export function Skeleton({ variant = "line", className, ...props }: HTMLAttributes<HTMLDivElement> & { variant?: "line" | "card" | "table-row" | "media" }) {
  const shapes = { line: "h-4 w-full", card: "h-32 w-full rounded-lg", "table-row": "h-10 w-full", media: "aspect-video w-full rounded-lg" };
  return <div {...props} aria-hidden="true" className={cn("animate-pulse rounded bg-surface-2", shapes[variant], className)} />;
}

export function EmptyState({ icon, title, reason, action, className }: { icon?: ReactNode; title: string; reason: string; action?: ReactNode; className?: string }) {
  return <Card className={cn("flex flex-col items-center gap-3 py-10 text-center", className)}>
    <div className="grid size-11 place-items-center rounded-full bg-surface-2 text-fg-muted">{icon ?? <FileQuestion aria-hidden="true" className="size-5" />}</div>
    <h2 className="text-section font-semibold">{title}</h2><p className="max-w-lg text-sm text-fg-muted">{reason}</p>{action}
  </Card>;
}

export function ErrorState({ message = "We could not load this information.", requestId, detail, onRetry, className }: { message?: string; requestId?: string; detail?: string; onRetry?: () => void; className?: string }) {
  return <Card role="alert" className={cn("space-y-3 border-danger/50", className)}>
    <div className="flex items-start gap-3"><CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" /><div><h2 className="font-semibold">Something went wrong</h2><p className="mt-1 text-sm text-fg-muted">{message}</p></div></div>
    {onRetry ? <Button size="md" variant="secondary" onClick={onRetry}>Try again</Button> : null}
    {requestId ? <p className="text-xs text-fg-muted">Request ID: <code>{requestId}</code></p> : null}
    {detail ? <details className="text-sm"><summary className="cursor-pointer text-fg-muted">Technical details</summary><pre className="mt-2 overflow-auto rounded bg-surface-2 p-3 text-xs">{detail}</pre></details> : null}
  </Card>;
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 text-sm text-danger" role="alert"><AlertTriangle aria-hidden="true" className="size-4" />{children}</p>;
}

export function NotConnected({ service = "This service" }: { service?: string }) {
  return <p className="flex items-center gap-2 text-sm text-fg-muted"><PlugZap aria-hidden="true" className="size-4" />{service} is not connected.</p>;
}
