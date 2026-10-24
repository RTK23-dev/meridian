import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bookmark, CalendarClock, CircleDashed, Clock, FileText, Info, Layers, Sparkles, XCircle, CheckCircle2, SearchCheck, type LucideIcon } from "lucide-react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Textarea, errorText } from "@/components/ui";
import { directionReasonProblem } from "@/lib/meridian/opportunity/direction-reason";
import { canMakeBrief, triageActionsFor, type TriageAction } from "@/lib/meridian/opportunity/triage-states";
import { statusLabel } from "@/lib/copy";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { createContentFactoryBriefFromOpportunity } from "@/lib/meridian/content-factory/actions";
import { CATEGORY_LEGEND, barPercent, categoryLabel, type OpportunityCategory, type OpportunityRow } from "./opportunity-model";

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

const STATUS_BADGE: Record<string, { variant: "info" | "success" | "danger" | "neutral" | "warning"; icon: LucideIcon }> = {
  open: { variant: "info", icon: Clock },
  accepted: { variant: "success", icon: CheckCircle2 },
  briefed: { variant: "success", icon: FileText },
  dismissed: { variant: "neutral", icon: CircleDashed },
  rejected: { variant: "danger", icon: XCircle },
  saved: { variant: "info", icon: Bookmark },
  deferred: { variant: "neutral", icon: CalendarClock },
  needs_research: { variant: "warning", icon: SearchCheck },
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
  return <section aria-labelledby="opportunity-hold-title" className="space-y-1 border-l-2 border-warning pl-4">
    <h2 id="opportunity-hold-title" className="font-semibold">On hold: clear under Reviews</h2>
    <p className="mt-1 text-sm text-muted">A human review decision is blocking these opportunities from moving to a brief.</p>
    <Link className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/brands/$brandId/content" params={{ brandId }} search={{ section: "review" }}>Open the review queue</Link>
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
    {options.map((option) => <Button key={option.key} type="button" size="sm" variant="secondary" className={value === option.key ? "border-fg bg-surface-2" : undefined} aria-pressed={value === option.key} onClick={() => onChange(option.key)}>{option.label}</Button>)}
  </div>;
}

const TRIAGE_LABEL: Record<TriageAction, string> = {
  decline: "Decline",
  save: "Save for later",
  defer: "Defer",
  request_research: "Request more research",
  reopen: "Reopen this idea",
};

/** Studio and triage are member actions. Viewers see the state and nothing they cannot change. */
export function OpportunityActions({ brandId, item, canEdit, triaging, onTriage }: {
  brandId: string;
  item: Pick<OpportunityRow, "id" | "label" | "status" | "decision">;
  canEdit: boolean;
  triaging: boolean;
  onTriage: (id: string, action: TriageAction, reason: string) => Promise<unknown>;
}) {
  const { data: workspace } = useWorkspace();
  if (!canEdit) return <span className="text-sm text-muted">Read-only for viewers.</span>;
  const actions = triageActionsFor(item.status);
  // A brief is a Content Factory session, which only the workspace's admins can make. It carries this idea's own brief, so the person
  // reviews the idea they picked, not a direction chosen elsewhere.
  const brief = hasRole(workspace?.active?.role ?? "viewer", "admin") && canMakeBrief(item.status);
  if (!brief && actions.length === 0) return null;
  return <>
    {brief ? <MakeBriefButton organizationId={workspace?.active?.id ?? ""} brandId={brandId} opportunityId={item.id} label={item.label} /> : null}
    {actions.length > 0 ? <TriageControl item={item} actions={actions} triaging={triaging} onTriage={onTriage} /> : null}
  </>;
}

/**
 * Makes this idea's brief as a Content Factory session, then opens that session on the Content Factory screen. The server checks the admin
 * role, the brand, and the idea's status again. A refusal is shown here, and nothing is opened.
 */
function MakeBriefButton({ organizationId, brandId, opportunityId, label }: { organizationId: string; brandId: string; opportunityId: string; label: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function makeBrief() {
    setBusy(true);
    setFailure(null);
    try {
      const made = await createContentFactoryBriefFromOpportunity({ data: { organizationId, brandId, opportunityId } });
      await navigate({ to: "/content-factory", search: { session: made.sessionId } });
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <Button type="button" disabled={busy} onClick={() => void makeBrief()}>
      {busy ? "Making the brief..." : "Make a brief"}<span className="sr-only"> from {label}</span>
    </Button>
    {failure ? <p role="alert" className="basis-full text-sm text-danger">{failure}</p> : null}
  </>;
}

/**
 * Decides an open or accepted idea with a reason: declines it, saves it, defers it, sends it for more research, or reopens a held one. The
 * reason is required and is kept with the decision. A refusal from the server is shown here, inside the panel, and the reason stays written,
 * so the person can send it again. Focus moves with the control: into the reason when it opens, back to Decide when it closes.
 */
function TriageControl({ item, actions, triaging, onTriage }: {
  item: Pick<OpportunityRow, "id" | "label">;
  actions: TriageAction[];
  triaging: boolean;
  onTriage: (id: string, action: TriageAction, reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const decideRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);
  const problem = reason.trim().length === 0 ? null : directionReasonProblem(reason);
  const onlyReopen = actions.length === 1 && actions[0] === "reopen";
  const declines = actions.includes("decline");
  useEffect(() => {
    if (open) reasonRef.current?.focus();
    else if (wasOpen.current) decideRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (!open) {
    return <Button ref={decideRef} type="button" variant="quiet" disabled={triaging} onClick={() => setOpen(true)}>{onlyReopen ? "Reopen" : "Decide"}<span className="sr-only"> {item.label}</span></Button>;
  }
  function choose(action: TriageAction) {
    if (directionReasonProblem(reason) !== null) return;
    setFailure(null);
    void onTriage(item.id, action, reason.trim()).then(
      () => {
        setOpen(false);
        setReason("");
      },
      (error: unknown) => setFailure(`${errorText(error)} The reason is still written, so you can send it again.`),
    );
  }
  return (
    <div role="group" aria-label={`Decide on ${item.label}`} className="flex w-full flex-col gap-2">
      <Textarea
        ref={reasonRef}
        label={`Why decide on ${item.label}?`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        hint={onlyReopen
          ? "Say what changed since this idea was set aside. The reason stays on record."
          : declines
            ? "Declining is final on this screen. The idea will not come back on a later scoring, and it cannot be reopened here. The reason stays on record."
            : "Say why. The reason stays on record. A set-aside idea stays out of the list until it is reopened."}
        error={problem ?? undefined}
        rows={3}
      />
      {failure !== null ? <p role="alert" className="text-sm text-danger">{failure}</p> : null}
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            variant={action === "decline" ? "quiet" : "secondary"}
            disabled={triaging || reason.trim().length === 0 || problem !== null}
            onClick={() => choose(action)}
          >
            {TRIAGE_LABEL[action]}
          </Button>
        ))}
        <Button type="button" variant="quiet" disabled={triaging} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
