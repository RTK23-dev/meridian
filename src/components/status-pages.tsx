import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileQuestion, ShieldAlert } from "lucide-react";
import { Button, Card } from "@/components/ui";

/** Shown inside the shell for an address that matches no screen. */
export function NotFoundPage() {
  return <StatusCard icon={<FileQuestion aria-hidden="true" className="size-5" />} title="Page not found" reason="The address may be mistyped, or the page has moved." />;
}

/** Shown when the current account may not open a screen, for example after a permission refusal. */
export function ForbiddenPage() {
  return <StatusCard icon={<ShieldAlert aria-hidden="true" className="size-5" />} title="You cannot open this page" reason="Your role in this workspace does not allow it. Ask a workspace admin if you need access." />;
}

/** Outside the shell, for example when the router has no matching route at all. */
export function RootNotFound() {
  return <main id="main" tabIndex={-1} className="mx-auto min-h-screen max-w-3xl px-4 py-10 text-fg"><NotFoundPage /></main>;
}

function StatusCard({ icon, title, reason }: { icon: ReactNode; title: string; reason: string }) {
  return (
    <Card className="mx-auto flex max-w-xl flex-col items-center gap-3 py-10 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-surface-2 text-fg-muted">{icon}</div>
      <h1 tabIndex={-1} className="text-section font-semibold">{title}</h1>
      <p className="max-w-lg text-sm text-fg-muted">{reason}</p>
      <Button asChild variant="secondary" size="md"><Link to="/">Go to workspace overview</Link></Button>
    </Card>
  );
}
