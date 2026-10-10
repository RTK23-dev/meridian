import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Card, errorText } from "@/components/ui";

/** Shown in place of an admin-only screen for a viewer or member. The records are not requested at all. */
export function AdminOnlyNotice({ screen, role }: { screen: string; role: string }) {
  return (
    <Card className="flex items-start gap-3">
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-muted" />
      <div className="space-y-1">
        <h2 className="font-semibold">{screen} is for workspace admins</h2>
        <p className="text-sm text-fg-muted">
          Your role in this workspace is {role}, so these records are not loaded for you. Ask a workspace admin if you need them.
        </p>
      </div>
    </Card>
  );
}

/**
 * A refusal from the server, shown as its own sentence. The server writes these messages in plain words (for example,
 * "Only dead jobs can be retried. This job is queued."), so they are shown as the message, not as a generic failure.
 */
export function RefusalNotice({ error }: { error: unknown }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-danger">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{errorText(error)}</span>
    </p>
  );
}

export function MetricCard({ label, value, detail, icon }: { label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-sm text-fg-muted">
        <span>{label}</span>
        {icon}
      </div>
      <div className="font-display text-3xl tabular-nums">{value}</div>
      {detail ? <div className="text-sm text-fg-muted">{detail}</div> : null}
    </Card>
  );
}
