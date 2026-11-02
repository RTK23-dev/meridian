// The billing page: every money and spend limit of the workspace and of each brand, set in one place. Each limit shows its value, or that it is
// not set (which refuses the step it guards), and what it blocks. Only an admin can change a limit; a member reads them. Every change is saved
// by the server, which checks the role and the tenancy again, and audits the change.

import { useState } from "react";
import { Button, ErrorState, Field, Input, PageHeader } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { qk } from "@/lib/query/keys";
import { useBillingPageQuery, useScopedMutation } from "@/lib/query/hooks";
import { saveBillingLimitAction } from "@/lib/meridian/billing/actions";
import { LIMIT_SPECS, limitStatusText, type LimitKind } from "@/lib/meridian/billing/limits";
import type { BillingBrand, BillingPage } from "@/lib/meridian/billing/store";

export function BillingScreen({ organizationId }: { organizationId: string }) {
  const query = useBillingPageQuery(organizationId);
  if (query.isPending) return <p className="text-fg-muted" role="status">Loading the billing page…</p>;
  if (query.isError) return <ErrorState message="The billing page could not be loaded. Nothing is assumed about the limits." onRetry={() => void query.refetch()} />;
  const page = query.data;
  return (
    <div className="space-y-10">
      <PageHeader
        title="Billing and limits"
        description="Every money and spend limit in Meridian, in one place. Nothing is set by default: a limit that is not set refuses the paid step it guards, and says so. Each change is recorded with its value before and after."
      />
      {page.canEdit ? null : <p className="text-sm text-fg-muted">Only a workspace admin can change these limits. You can read them here.</p>}
      <WorkspaceSection page={page} />
      <BrandsSection page={page} />
      <EstimatesSection page={page} />
    </div>
  );
}

function WorkspaceSection({ page }: { page: BillingPage }) {
  const { workspace, canEdit, organizationId } = page;
  return (
    <section aria-labelledby="billing-workspace" className="space-y-6">
      <div className="space-y-1">
        <h2 id="billing-workspace" className="text-section font-semibold">Workspace</h2>
        <p className="text-muted">These limits apply to the whole workspace, across every brand.</p>
      </div>
      {workspace.policyReadable ? null : (
        <p className="text-sm text-danger" role="alert">The workspace's saved policy cannot be read, so the measure ceiling and the decision cap are unknown. {workspace.policyReason ?? ""}</p>
      )}
      <LimitForm organizationId={organizationId} kind="workspace_monthly_budget" value={workspace.monthlyBudgetUsd} canEdit={canEdit} />
      <LimitForm organizationId={organizationId} kind="measure_ceiling" value={workspace.measureCeilingUsdPerSecond} canEdit={canEdit && workspace.policyReadable} />
      <LimitForm organizationId={organizationId} kind="decision_cap" value={workspace.decisionCapUsd} canEdit={canEdit && workspace.policyReadable} />
    </section>
  );
}

function BrandsSection({ page }: { page: BillingPage }) {
  const { brands, canEdit, organizationId } = page;
  return (
    <section aria-labelledby="billing-brands" className="space-y-6">
      <div className="space-y-1">
        <h2 id="billing-brands" className="text-section font-semibold">Brands</h2>
        <p className="text-muted">Each brand has its own budget and its own factory caps. The factory does not spend a brand's money until both its daily and its total cap are set.</p>
      </div>
      {brands.length === 0 ? <p className="text-fg-muted">No brands yet. A brand's limits appear here once it exists.</p> : null}
      {brands.map((brand) => (
        <BrandLimits key={brand.brandId} organizationId={organizationId} brand={brand} canEdit={canEdit} />
      ))}
    </section>
  );
}

function BrandLimits({ organizationId, brand, canEdit }: { organizationId: string; brand: BillingBrand; canEdit: boolean }) {
  return (
    <div className="space-y-5 rounded-lg border border-hairline p-5" aria-label={`Limits for ${brand.name}`}>
      <h3 className="text-body font-semibold">{brand.name}</h3>
      <LimitForm organizationId={organizationId} kind="brand_budget" brandId={brand.brandId} value={brand.brandBudgetUsd} canEdit={canEdit} committedUsd={brand.committedUsd} />
      <LimitForm organizationId={organizationId} kind="factory_daily_cap" brandId={brand.brandId} value={brand.factoryDailyCapUsd} canEdit={canEdit} />
      <LimitForm organizationId={organizationId} kind="factory_total_cap" brandId={brand.brandId} value={brand.factoryTotalCapUsd} canEdit={canEdit} />
    </div>
  );
}

function EstimatesSection({ page }: { page: BillingPage }) {
  return (
    <section aria-labelledby="billing-estimates" className="space-y-3">
      <div className="space-y-1">
        <h2 id="billing-estimates" className="text-section font-semibold">Estimates</h2>
        <p className="text-muted">These are not limits. The engine uses them to estimate a master's cost before it starts. They are read-only here.</p>
      </div>
      <p className="text-sm">The fixed cost of one master is about ${page.fixedCostPerMasterUsd.toFixed(2)} before its shots.</p>
    </section>
  );
}

/** One limit: its label, its status, the input to change it, and what it blocks. Blank clears it (unset), except the brand budget. */
function LimitForm({
  organizationId,
  kind,
  brandId,
  value,
  canEdit,
  committedUsd,
}: {
  organizationId: string;
  kind: LimitKind;
  brandId?: string;
  value: number | null;
  canEdit: boolean;
  committedUsd?: number;
}) {
  const spec = LIMIT_SPECS[kind];
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useScopedMutation({
    mutationKey: ["mutation", "billing.save", organizationId, kind, brandId ?? ""],
    mutationFn: (raw: string) => saveBillingLimitAction({ data: { organizationId, kind, brandId: brandId ?? null, value: raw } }),
    invalidate: () => [qk.billing(organizationId), qk.videoBudget(organizationId)],
    onSuccess: (result) => {
      setDraft(null);
      setSaved(result.value === null ? `${spec.label} cleared. It is not set now.` : `${spec.label} saved.`);
    },
  });

  const shown = draft ?? (value === null ? "" : value.toFixed(spec.decimals));
  const failure = save.error ? plainError(save.error) : null;
  const statusId = `${kind}-${brandId ?? "workspace"}-status`;
  const committed = committedUsd === undefined ? "" : ` Committed so far: $${committedUsd.toFixed(2)}.`;
  const canClear = kind !== "brand_budget";
  const label = `${spec.label} (${spec.unit})`;

  return (
    <form
      className="space-y-2 border-b border-hairline pb-5 last:border-b-0 last:pb-0"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(null);
        save.mutate(shown);
      }}
    >
      <Field label={label} hint={`${spec.blocks}${committed}`}>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="text"
            inputMode="decimal"
            value={shown}
            disabled={!canEdit || save.isPending}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby={statusId}
            className="w-40"
            placeholder={value === null ? "Not set" : undefined}
          />
          {canEdit ? (
            <Button type="submit" disabled={save.isPending || shown === (value === null ? "" : value.toFixed(spec.decimals))}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          ) : null}
          {canEdit && canClear && value !== null ? (
            <Button type="button" variant="secondary" disabled={save.isPending} onClick={() => save.mutate("")}>
              Clear
            </Button>
          ) : null}
        </div>
      </Field>
      <p id={statusId} className="text-sm text-fg-muted">{limitStatusText(kind, value)}</p>
      {failure ? <PlainErrorMessage message={failure.message} raw={failure.raw} /> : null}
      {saved ? <p className="text-sm text-success" role="status">{saved}</p> : null}
    </form>
  );
}
