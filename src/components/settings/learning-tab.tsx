import { Link } from "@tanstack/react-router";
import { Button, Card, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger, ErrorState, Skeleton, Switch, errorText } from "@/components/ui";
import { FormError } from "./form-error";
import { plainServerError } from "./form-model";
import { hasRole } from "@/lib/meridian/access";
import { setOrganizationLearning } from "@/lib/meridian/machine";
import type { BrandSummary } from "@/lib/meridian/workspace/actions";
import { useLearningQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

/** Per brand: whether it may use patterns that other brands in this workspace explicitly shared. Global patterns are never used. */
export function LearningTab({ brands }: { brands: BrandSummary[] }) {
  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <h2 className="text-section font-semibold text-fg">Shared workspace patterns</h2>
        <p className="max-w-3xl text-sm text-fg-muted">
          A brand always uses its own stored patterns. Patterns another brand in this workspace explicitly shared are used only by brands that turn this on. Global patterns are never used.
        </p>
        <ExplainDialog />
      </Card>
      {brands.length === 0 ? (
        <p className="text-sm text-fg-muted">No brands yet. A brand’s learning setting appears here once it exists.</p>
      ) : (
        <ul className="space-y-3">
          {brands.map((brand) => <LearningRow key={brand.id} brand={brand} />)}
        </ul>
      )}
    </div>
  );
}

function ExplainDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" size="md">What does this change?</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle className="font-display text-2xl">What turning this on changes</DialogTitle>
        <DialogDescription className="mt-3 space-y-2 text-sm text-fg-muted">
          <span className="block">Only the brand you switch on reads patterns that other brands in this workspace shared with it.</span>
          <span className="block">It does not copy anything into the brand brain, and it does not change scoring. Turning it off stops the brand from reading shared patterns on its next decision.</span>
        </DialogDescription>
        <div className="mt-4 flex justify-end">
          <DialogClose asChild><Button type="button" variant="secondary">Close</Button></DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LearningRow({ brand }: { brand: BrandSummary }) {
  const learning = useLearningQuery(brand.id);
  const toggle = useScopedMutation({
    mutationKey: ["mutation", "learning.scope", brand.id],
    mutationFn: (enabled: boolean) => setOrganizationLearning({ data: { brandId: brand.id, enabled } }),
    invalidate: () => [qk.learning(brand.id)],
    success: (enabled) => enabled ? `${brand.name} uses shared workspace patterns.` : `${brand.name} no longer uses shared workspace patterns.`,
  });

  if (learning.isError && !learning.data) {
    return <li><ErrorState message={`${brand.name}’s learning setting could not be loaded.`} onRetry={() => void learning.refetch()} /></li>;
  }
  if (!learning.data) {
    return <li><Skeleton variant="card" className="h-20" /></li>;
  }
  const canEdit = hasRole(learning.data.role, "member");
  const rawError = toggle.error ? errorText(toggle.error) : null;
  return (
    <li className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-fg">{brand.name}</h3>
          <p className="text-sm text-fg-muted">{learning.data.patterns.length} stored pattern{learning.data.patterns.length === 1 ? "" : "s"} for this brand and shared with it.</p>
        </div>
        <Button asChild variant="quiet" size="md"><Link to="/brands/$brandId/learning" params={{ brandId: brand.id }}>Open learning</Link></Button>
      </div>
      <Switch
        id={`shared-patterns-${brand.id}`}
        label="Use shared workspace patterns"
        hint={canEdit ? undefined : "Only a member or admin can change this."}
        checked={learning.data.useOrganizationLearning}
        disabled={!canEdit || toggle.isPending}
        onCheckedChange={(checked) => { void toggle.mutateAsync(checked).catch(() => undefined); }}
      />
      {rawError ? <FormError message={plainServerError(rawError, "settings")} raw={rawError} /> : null}
    </li>
  );
}
