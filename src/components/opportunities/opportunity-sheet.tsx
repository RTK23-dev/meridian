import { lazy, Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Badge, Button, ChartSkeleton, Sheet, SheetContent, SheetDescription, SheetTitle, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { copy, percentOrUnknown, statusLabel } from "@/lib/copy";
import { Term } from "@/components/glossary";
import { TechnicalDetails } from "@/components/plain-error";
import { CategoryChip, HoldBadge, OpportunityActions, OpportunityStatusBadge, ScoreValue, UnknownValue } from "./opportunity-parts";
import { canDismiss, categoryLabel, finiteOrNull, isHeld, jevDecisionLabel, jevProbability, scoreDimensions, whyNotFacts, type OpportunityRow } from "./opportunity-model";

// The radar pulls in recharts, so it loads only when the sheet shows the rank parts.
const ScoreRadar = lazy(() => import("./score-radar").then((module) => ({ default: module.ScoreRadar })));

type SheetProps = {
  item: OpportunityRow | null;
  position: number | null;
  brandId: string;
  canEdit: boolean;
  dismissing: boolean;
  onDismiss: (id: string) => void;
  onOpenChange: (open: boolean) => void;
};

/** Row detail. It opens from the table or the cards and closes with Escape or the close control. */
export function OpportunitySheet(props: SheetProps) {
  const { item, onOpenChange } = props;
  return <Sheet open={!!item} onOpenChange={onOpenChange}>
    <SheetContent className="left-auto right-0 top-0 bottom-0 max-h-none w-full max-w-2xl rounded-none border-l border-t-0">
      {item ? <OpportunityDetail key={item.id} {...props} item={item} /> : null}
    </SheetContent>
  </Sheet>;
}

function OpportunityDetail({ item, position, brandId, canEdit, dismissing, onDismiss, onOpenChange }: SheetProps & { item: OpportunityRow }) {
  const dimensions = scoreDimensions(item);
  const probability = jevProbability(item);
  const reasons = whyNotFacts(item);
  const held = isHeld(item);
  const showWhyNot = reasons.length > 0 || (position !== null && position > 1);
  return <>
    <SheetTitle className="font-display text-2xl">{item.label}</SheetTitle>
    <SheetDescription>{categoryLabel(item.category)} · {statusLabel(item.status)} · rank score {item.expectedValue.toFixed(2)}{position !== null ? ` · position ${position}` : ""}</SheetDescription>
    <div className="mt-5 space-y-6">
      <div className="flex flex-wrap gap-2"><CategoryChip category={item.category} /><OpportunityStatusBadge status={item.status} />{held ? <HoldBadge /> : null}</div>

      <section aria-labelledby="opportunity-reason" className="space-y-2">
        <h3 id="opportunity-reason" className="font-semibold">Reason</h3>
        <p className="text-sm">{item.reason || "No reason is stored for this opportunity."}</p>
      </section>

      <section aria-labelledby="opportunity-score" className="space-y-3">
        <h3 id="opportunity-score" className="font-semibold">How the rank is built</h3>
        <p className="text-sm text-muted">Parts that add raise the rank. Parts that subtract lower it. Focus or hover a part name for what its number means.</p>
        <Suspense fallback={<ChartSkeleton className="h-64" />}>
          <ScoreRadar dimensions={dimensions} label={`Rank score parts for ${item.label}`} />
        </Suspense>
        <TooltipProvider>
          <ul className="grid gap-2 sm:grid-cols-2">
            {dimensions.map((dimension) => <li key={dimension.key} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="min-h-11 text-left font-semibold underline decoration-dotted underline-offset-4">{dimension.label}</button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-64">{dimension.explanation}</TooltipContent>
                </Tooltip>
                <span className="text-xs text-muted">{dimension.effect === "adds" ? "Adds to rank" : "Subtracts from rank"}</span>
              </div>
              <div className="mt-2"><ScoreValue value={dimension.value} /></div>
            </li>)}
          </ul>
        </TooltipProvider>
      </section>

      <section aria-labelledby="opportunity-jev" className="space-y-2">
        <h3 id="opportunity-jev" className="font-semibold">Decision engine <Term id="jev">What is JEV?</Term></h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted">Decision</dt><dd className="font-semibold">{jevDecisionLabel(item.decision)}</dd></div>
          <div><dt className="text-muted">Probability</dt><dd className="font-semibold">{probability === null ? <UnknownValue /> : percentOrUnknown(probability)}</dd></div>
          <div><dt className="text-muted">Evidence confidence</dt><dd className="font-semibold">{item.confidence.toFixed(2)}</dd></div>
        </dl>
        {item.decision ? <TechnicalDetails>Decision code: {item.decision}</TechnicalDetails> : <p className="text-sm text-muted">{copy.opportunities.decisionNotYet}</p>}
      </section>

      <section aria-labelledby="opportunity-evidence" className="space-y-2">
        <h3 id="opportunity-evidence" className="font-semibold">Evidence</h3>
        {item.evidence.length ? <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{item.evidence.map((entry, index) => <li key={`${index}:${entry.id}`}>{entry.summary}</li>)}</ul> : <p className="text-sm text-muted">No evidence items are attached to this opportunity.</p>}
        {item.supportingCreativeIds.length ? <div className="space-y-2 text-sm">
          <p className="text-muted">{item.supportingCreativeIds.length} source {item.supportingCreativeIds.length === 1 ? "creative is" : "creatives are"} linked to this opportunity. <Link to="/brands/$brandId/library" params={{ brandId }} className="font-semibold underline underline-offset-4">Open the creative library</Link> to review them.</p>
          <IdList label="source creative ids" ids={item.supportingCreativeIds} />
        </div> : null}
      </section>

      {(item.researchSampleCount ?? 0) > 0 ? <section aria-labelledby="opportunity-research" className="space-y-2">
        <h3 id="opportunity-research" className="font-semibold">JEV Research pattern</h3>
        <div className="flex flex-wrap gap-2">
          {item.researchState ? <Badge variant="info">{item.researchState.toLowerCase().replaceAll("_", " ")}</Badge> : null}
          <Badge variant="neutral">{item.researchSampleCount} source {item.researchSampleCount === 1 ? "ad" : "ads"}</Badge>
          <Badge variant="neutral">Confidence {finiteOrNull(item.researchConfidence)?.toFixed(2) ?? "unknown"}</Badge>
        </div>
        <p className="text-sm text-muted">Counts describe the collected corpus. No outcome or causal claim is implied.</p>
        <IdList label="research creative ids" ids={item.researchSourceIds ?? []} />
        <IdList label="research analysis ids" ids={item.researchAnalysisIds ?? []} />
      </section> : null}

      {showWhyNot ? <section aria-labelledby="opportunity-why-not" className="space-y-2">
        <h3 id="opportunity-why-not" className="font-semibold">Why not higher{held ? " or cleared" : ""}</h3>
        {reasons.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p className="text-sm text-muted">Nothing stored blocks this item. Its position follows its rank score.</p>}
      </section> : null}

      <section aria-labelledby="opportunity-actions" className="space-y-2">
        <h3 id="opportunity-actions" className="font-semibold">Actions</h3>
        <div className="flex flex-wrap items-center gap-2">
          <OpportunityActions brandId={brandId} item={item} canEdit={canEdit} dismissing={dismissing} onDismiss={onDismiss} />
        </div>
        {canEdit && canDismiss(item.status) ? <p className="text-sm text-muted">Studio opens its own recommended direction. It cannot select this opportunity from here yet.</p> : null}
        <Button type="button" variant="quiet" size="sm" onClick={() => onOpenChange(false)}>Close details</Button>
      </section>
    </div>
  </>;
}

/** Ids stay out of the way until someone asks for them. The region is labelled and the toggle says what it shows. */
function IdList({ label, ids }: { label: string; ids: string[] }) {
  const [open, setOpen] = useState(false);
  const regionId = `ids-${label.replaceAll(" ", "-")}`;
  if (ids.length === 0) return <p className="text-xs text-muted">No {label} shared.</p>;
  return <div className="space-y-2">
    <Button type="button" variant="quiet" size="sm" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((value) => !value)}>
      {open ? "Hide ids" : "Show ids"}<span className="sr-only"> for {label}</span>
    </Button>
    <ul id={regionId} hidden={!open} className="flex flex-wrap gap-2">
      {ids.map((value) => <li key={value}><code className="break-all rounded border border-border px-2 py-1 text-xs">{value}</code></li>)}
    </ul>
  </div>;
}
