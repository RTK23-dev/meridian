import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, CardDescription, CardHeader, CardTitle, Field, Input, SelectInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { getBrandPolicyFor, getOrchestratorPolicyFor, saveBrandPolicyFor, saveOrchestratorPolicyFor } from "@/lib/meridian/orchestrator/actions";
import { hasRole } from "@/lib/meridian/access";
import {
  CEILING,
  brandFamiliesAfter,
  brandFamilyRows,
  ceilingText,
  familiesFromText,
  parseCeiling,
  withFamily,
  workspaceFamilyRows,
  type FamilyRow,
} from "./orchestrator-presentation";

type PolicyData = Awaited<ReturnType<typeof getOrchestratorPolicyFor>>;
type BrandPolicyData = Awaited<ReturnType<typeof getBrandPolicyFor>>;

/**
 * The model policy (owner direction 2026-10-23). The workspace section holds the model families the orchestrator may not use and the measure
 * ceiling. The brand section switches off more families for one brand; a brand cannot switch on a family the workspace has switched off.
 * A viewer reads the values; only a workspace admin saves them.
 */
export function OrchestratorPolicyPanel({ brandId }: { brandId: string }) {
  const { user, isPending } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");
  const brands = (workspace?.brands ?? []).map((brand) => ({ id: brand.id, name: brand.name }));
  // The brand the picker shows: the brand the page works in, until the person picks another one.
  const [picked, setPicked] = useState<string | null>(null);
  const selectedBrand = picked ?? brandId;
  // The messages are kept here, not in the forms: a save refetches the policy, and a form remounts on the new values.
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [brandMessage, setBrandMessage] = useState<string | null>(null);

  const policy = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-policy", brandId]),
    queryFn: () => getOrchestratorPolicyFor({ data: { brandId } }),
    enabled: !isPending && !!user && brandId !== "",
  });
  const brandPolicy = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-brand-policy", selectedBrand]),
    queryFn: () => getBrandPolicyFor({ data: { brandId: selectedBrand } }),
    enabled: !isPending && !!user && selectedBrand !== "",
  });

  return (
    <Card aria-labelledby="policy-heading">
      <CardHeader>
        <CardTitle id="policy-heading">Model policy</CardTitle>
        <CardDescription>
          The model families the orchestrator may not use, and the most a measured video step is held to. Every orchestrated run in this workspace uses
          these values.
        </CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-8 p-4 sm:p-6">
        {canAdmin ? null : (
          <p id="policy-role" className="text-sm text-fg-muted">
            Only a workspace admin can change the policy. You can read it here.
          </p>
        )}

        <section aria-labelledby="policy-workspace-heading" className="flex flex-col gap-4">
          <h3 id="policy-workspace-heading" className="text-sm font-semibold">
            Workspace
          </h3>
          <p className="text-sm text-fg-muted">A switched-off family is not offered to the orchestrator, and a plan that names one is refused.</p>
          {policy.isError && !policy.data ? <PlainErrorState error={policy.error} onRetry={() => void policy.refetch()} /> : null}
          {policy.data ? (
            <WorkspacePolicy
              key={JSON.stringify(policy.data.policy)}
              brandId={brandId}
              data={policy.data}
              canAdmin={canAdmin}
              message={workspaceMessage}
              onMessage={setWorkspaceMessage}
              onSaved={() => {
                void policy.refetch();
                // A brand's locked families come from the workspace, so the brand section reads them again.
                void brandPolicy.refetch();
              }}
            />
          ) : policy.isError ? null : (
            <p role="status" className="text-sm text-fg-muted">
              Loading the policy.
            </p>
          )}
        </section>

        <section aria-labelledby="policy-brand-heading" className="flex flex-col gap-4 border-t border-hairline pt-6">
          <h3 id="policy-brand-heading" className="text-sm font-semibold">
            Brand
          </h3>
          <p className="text-sm text-fg-muted">A brand may switch off more families. A family the workspace has switched off stays off for the brand.</p>
          {brands.length === 0 ? (
            <p className="text-sm text-fg-muted">Create a brand first. A brand's families are kept for its workspace.</p>
          ) : (
            <>
              <Field id="policy-brand" label="Brand" className="sm:max-w-sm">
                <SelectInput id="policy-brand" value={selectedBrand} onChange={(event) => setPicked(event.target.value)}>
                  {brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              {brandPolicy.isError && !brandPolicy.data ? (
                <PlainErrorState error={brandPolicy.error} onRetry={() => void brandPolicy.refetch()} />
              ) : null}
              {brandPolicy.data ? (
                <BrandFamilies
                  key={`${selectedBrand}:${JSON.stringify(brandPolicy.data)}`}
                  brandId={selectedBrand}
                  data={brandPolicy.data}
                  canAdmin={canAdmin}
                  message={brandMessage}
                  onMessage={setBrandMessage}
                  onSaved={() => void brandPolicy.refetch()}
                />
              ) : brandPolicy.isError ? null : (
                <p role="status" className="text-sm text-fg-muted">
                  Loading the brand's families.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </Card>
  );
}

/** One family row: a checkbox that is checked while the family is switched off, with the state written beside it, so it is not colour alone. */
function FamilyCheckbox({ row, disabled, onToggle }: { row: FamilyRow; disabled: boolean; onToggle: (on: boolean) => void }) {
  const state = row.locked
    ? "switched off for the workspace. This brand cannot switch it on."
    : `${row.switchedOff ? "switched off" : "switched on"}${row.offByDefault ? ", off by default" : ""}`;
  return (
    <li>
      <label className="inline-flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm sm:min-h-8">
        <input type="checkbox" className="size-4" checked={row.switchedOff} disabled={disabled || row.locked} onChange={(event) => onToggle(event.target.checked)} />
        <span className="font-mono">{row.family}</span>
        <span className="text-fg-muted">{state}</span>
      </label>
    </li>
  );
}

function WorkspacePolicy({
  brandId,
  data,
  canAdmin,
  message,
  onMessage,
  onSaved,
}: {
  brandId: string;
  data: PolicyData;
  canAdmin: boolean;
  message: string | null;
  onMessage: (text: string | null) => void;
  onSaved: () => void;
}) {
  const { policy, initial } = data;
  const [families, setFamilies] = useState<string[]>(policy.disabledModelFamilies);
  const [typed, setTyped] = useState("");
  const [ceilingDraft, setCeilingDraft] = useState(String(policy.measureCeilingUsdPerSecond));
  const [saving, setSaving] = useState(false);
  const ceiling = parseCeiling(ceilingDraft);
  const rows = workspaceFamilyRows({ defaults: initial.disabledModelFamilies, switchedOff: families });

  function addTyped() {
    setFamilies((current) => familiesFromText(typed).reduce((list, family) => withFamily(list, family, true), current));
    setTyped("");
  }

  async function save() {
    if (ceiling === null) return;
    setSaving(true);
    onMessage(null);
    try {
      await saveOrchestratorPolicyFor({ data: { brandId, disabledModelFamilies: families, measureCeilingUsdPerSecond: ceiling } });
      onMessage("Saved. Every run that starts from now on uses these values.");
      onSaved();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The policy could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Model families</p>
        {rows.length === 0 ? <p className="text-sm text-fg-muted">No model family is switched off.</p> : null}
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <FamilyCheckbox
              key={row.family}
              row={row}
              disabled={!canAdmin}
              onToggle={(on) => setFamilies((current) => withFamily(current, row.family, on))}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            id="policy-add-family"
            label="Switch off another model family"
            hint="Separate several with commas."
            className="sm:max-w-80"
            value={typed}
            disabled={!canAdmin}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={addTyped} disabled={!canAdmin || familiesFromText(typed).length === 0}>
            Add
          </Button>
        </div>
      </div>

      <Input
        id="policy-ceiling"
        type="number"
        inputMode="decimal"
        min={CEILING.min}
        max={CEILING.max}
        step="0.01"
        label="Measure ceiling (USD per second)"
        hint={`The most a video or avatar step with no engine price is held to, for each second of its length, in a run an admin starts in measure mode. Initial value: ${ceilingText(initial.measureCeilingUsdPerSecond)}.`}
        className="sm:max-w-40"
        value={ceilingDraft}
        disabled={!canAdmin}
        onChange={(event) => setCeilingDraft(event.target.value)}
        error={ceiling === null ? `Enter a ceiling from $${CEILING.min.toFixed(2)} to $${CEILING.max.toFixed(2)} per second.` : undefined}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void save()} disabled={saving || !canAdmin || ceiling === null}>
          Save the policy
        </Button>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BrandFamilies({
  brandId,
  data,
  canAdmin,
  message,
  onMessage,
  onSaved,
}: {
  brandId: string;
  data: BrandPolicyData;
  canAdmin: boolean;
  message: string | null;
  onMessage: (text: string | null) => void;
  onSaved: () => void;
}) {
  const { brandFamilies, workspaceFamilies } = data;
  // The brand's own families: the ones the workspace does not already switch off. Those are locked on, and shown with the brand's rows.
  const [own, setOwn] = useState<string[]>(() => brandFamilies.filter((family) => !workspaceFamilies.includes(family)));
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const rows = brandFamilyRows({ workspaceFamilies, brandFamilies: own });

  function addTyped() {
    setOwn((current) => familiesFromText(typed).reduce((list, family) => brandFamiliesAfter(list, workspaceFamilies, family, true), current));
    setTyped("");
  }

  async function save() {
    setSaving(true);
    onMessage(null);
    try {
      await saveBrandPolicyFor({ data: { brandId, disabledModelFamilies: own } });
      onMessage("Saved. The families of this brand apply from now on, with the workspace's.");
      onSaved();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The brand's families could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Families switched off for this brand</p>
        {rows.length === 0 ? <p className="text-sm text-fg-muted">This brand switches off no family of its own.</p> : null}
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <FamilyCheckbox
              key={row.family}
              row={row}
              disabled={!canAdmin}
              onToggle={(on) => setOwn((current) => brandFamiliesAfter(current, workspaceFamilies, row.family, on))}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            id="policy-brand-add-family"
            label="Switch off another model family for this brand"
            hint="Separate several with commas."
            className="sm:max-w-80"
            value={typed}
            disabled={!canAdmin}
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={addTyped} disabled={!canAdmin || familiesFromText(typed).length === 0}>
            Add
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void save()} disabled={saving || !canAdmin}>
          Save the brand's families
        </Button>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
