import { Activity, AlertCircle, CheckCircle2, Clock3, Info, PlugZap } from "lucide-react";
import { statusPresentation } from "./ui/status-map";

const icons = { check: CheckCircle2, clock: Clock3, alert: AlertCircle, activity: Activity, plug: PlugZap, info: Info };

export function StatusText({ status, description, label = "Status" }: { status: string; description?: string; label?: string }) {
  const presentation = statusPresentation(status);
  const Icon = icons[presentation.icon];
  return <p>
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-fg">
      <Icon aria-hidden="true" className="size-4" />
      <span>{label}: {presentation.label}</span>
    </span>
    {description ? <span className="mt-1 block text-sm text-fg-muted">{description}</span> : null}
  </p>;
}
