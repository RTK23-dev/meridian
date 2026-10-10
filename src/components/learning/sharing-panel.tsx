import * as SwitchPrimitive from "@radix-ui/react-switch";
import { useId, useState } from "react";
import {
  Button, Card, Dialog, DialogContent, DialogDescription, DialogTitle, EmptyState,
} from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { setOrganizationLearning, sharePatternWithOrganization } from "@/lib/meridian/machine";
import { usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import type { LearningData } from "./patterns-panel";
import { formatSignedPercent, patternDisplay } from "./lift";
import { NOT_ENOUGH_RESULTS } from "./metrics";

/** The button is at least 44 px square, which meets the touch-target rule. The visible track is 44 by 24 px. */
function OptInSwitch({ checked, disabled, labelledBy, describedBy, onCheckedChange }: {
  checked: boolean;
  disabled: boolean;
  labelledBy: string;
  describedBy: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return <SwitchPrimitive.Root
    checked={checked}
    disabled={disabled}
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    onCheckedChange={onCheckedChange}
    className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
  >
    <span aria-hidden="true" className="relative block h-6 w-11 rounded-full bg-border-strong transition-colors group-data-[state=checked]:bg-accent">
      <SwitchPrimitive.Thumb className="absolute left-0.5 top-0.5 block size-5 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-5" />
    </span>
  </SwitchPrimitive.Root>;
}

export function SharingPanel({ brandId, data, canEdit, canAdmin }: { brandId: string; data: LearningData; canEdit: boolean; canAdmin: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);
  const switchLabelId = useId();
  const switchDescriptionId = useId();
  const learningKey = (name: string) => ["mutation", `learning.${name}`, brandId] as const;

  const toggleSharedPatterns = useScopedMutation({
    mutationKey: learningKey("organization-toggle"),
    mutationFn: (enabled: boolean) => setOrganizationLearning({ data: { brandId, enabled } }),
    invalidate: () => [qk.learning(brandId), qk.studio(brandId)],
    success: (enabled) => (enabled ? "Shared workspace patterns are on." : "Shared workspace patterns are off."),
  });
  const sharePattern = useScopedMutation({
    mutationKey: learningKey("share"),
    mutationFn: (patternId: string) => sharePatternWithOrganization({ data: { brandId, patternId } }),
    invalidate: () => [qk.learning(brandId)],
    onSuccess: (result) => setNote(result.status === "shared" ? "Shared with this workspace. Other brands still ignore it until they opt in." : "That pattern was already shared."),
  });
  const sharingPatterns = usePendingVariables<string>(learningKey("share"));

  const enabled = data.useOrganizationLearning;
  const brandPatterns = data.patterns.filter((pattern) => pattern.scope === "brand");

  function handleSwitch(next: boolean) {
    // Turning sharing on needs a deliberate confirmation in the dialog. Turning it off applies at once.
    if (next) setExplainOpen(true);
    else void toggleSharedPatterns.mutateAsync(false).catch(() => undefined);
  }

  async function confirmOn() {
    setExplainOpen(false);
    await toggleSharedPatterns.mutateAsync(true).catch(() => undefined);
  }

  return <div className="space-y-6">
    <div className="space-y-1">
      <h2 className="text-section font-semibold">Sharing</h2>
      <p className="max-w-2xl text-sm text-fg-muted">Choose whether this brand also uses patterns that other brands in this workspace have shared.</p>
    </div>

    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-2xl space-y-1">
          <p id={switchLabelId} className="font-semibold">Use shared workspace patterns</p>
          <p id={switchDescriptionId} className="text-sm text-fg-muted">
            This brand's own patterns are always used. Patterns another brand in this workspace explicitly shared are used only if you turn that on. Global patterns are never used.
          </p>
          <p role="status" className="text-sm font-semibold">{enabled ? "Currently on." : "Currently off."}</p>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <OptInSwitch
              checked={enabled}
              disabled={toggleSharedPatterns.isPending}
              labelledBy={switchLabelId}
              describedBy={switchDescriptionId}
              onCheckedChange={handleSwitch}
            />
          </div>
        ) : null}
      </div>
      <div>
        <Button type="button" variant="secondary" onClick={() => setExplainOpen(true)}>What sharing does</Button>
      </div>
      {!canEdit ? <p className="text-sm text-fg-muted">Only workspace members can change this setting.</p> : null}
    </Card>

    <Dialog open={explainOpen} onOpenChange={setExplainOpen}>
      <DialogContent aria-describedby="sharing-explainer-description">
        <DialogTitle>What sharing does</DialogTitle>
        <DialogDescription id="sharing-explainer-description" className="mt-2 text-sm text-fg-muted">
          Shared patterns let this brand learn from results that another brand in the same workspace has already stored.
        </DialogDescription>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm">
          <li>This brand's own patterns are always used.</li>
          <li>When this is on, patterns that other brands shared with the workspace are used for this brand as well.</li>
          <li>Sharing copies a pattern's summary and totals to the workspace. It does not copy performance rows or creative IDs.</li>
          <li>Global patterns are never used.</li>
          <li>Turning this off stops this brand using shared patterns. It does not delete them.</li>
          <li>This screen has no control that removes a pattern once it is shared.</li>
        </ul>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setExplainOpen(false)}>Cancel</Button>
          {!enabled && canEdit ? (
            <Button type="button" disabled={toggleSharedPatterns.isPending} onClick={() => void confirmOn()}>Turn on shared patterns</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>

    {note ? <p role="status" className="text-sm text-fg-muted">{note}</p> : null}
    {toggleSharedPatterns.error ? <PlainErrorNotice error={toggleSharedPatterns.error} /> : null}
    {sharePattern.error ? <PlainErrorNotice error={sharePattern.error} /> : null}

    {canAdmin ? (
      <section aria-labelledby="share-patterns-title" className="space-y-3">
        <div className="space-y-1">
          <h3 id="share-patterns-title" className="text-base font-semibold">Share a pattern with the workspace</h3>
          <p className="text-sm text-fg-muted">Sharing copies this pattern's summary and totals to the workspace. It does not copy performance rows or creative IDs.</p>
        </div>
        {brandPatterns.length === 0 ? (
          <EmptyState title="No brand patterns to share" reason="Patterns appear here once they are stored for this brand." />
        ) : (
          <ul className="space-y-3">
            {brandPatterns.map((pattern) => {
              const display = patternDisplay({ lift: pattern.lift, sampleSize: pattern.sampleSize, impressions: pattern.impressions, state: pattern.state });
              const busy = sharingPatterns.includes(pattern.id);
              return <li key={pattern.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">{pattern.attribute}: {pattern.value}</p>
                    <p className="text-sm text-fg-muted">{pattern.metric} · {display.stateText} · {display.directionLabel} · lift {display.hasEvidence ? formatSignedPercent(pattern.lift) : NOT_ENOUGH_RESULTS}</p>
                  </div>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => void sharePattern.mutateAsync(pattern.id).catch(() => undefined)}>
                    {busy ? "Sharing…" : "Share with workspace"}
                  </Button>
                </Card>
              </li>;
            })}
          </ul>
        )}
      </section>
    ) : null}
  </div>;
}
