import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { getOrchestratorPolicyFor, saveOrchestratorPolicyFor } from "@/lib/meridian/orchestrator/actions";
import { hasRole } from "@/lib/meridian/access";

/** The model family Veo is listed under. Switched off by default. The switch turns it back on or off, and nothing is deleted. */
const VEO_FAMILY = "google/veo";

type PolicyData = Awaited<ReturnType<typeof getOrchestratorPolicyFor>>;

/**
 * The workspace's budget tolerance and the model families the orchestrator may not use (owner direction 2026-10-23). A budget is a safe limit:
 * a run may go past it by the larger of the percentage and the cents, and past that it waits for an approval. Every value is adjustable here.
 * A viewer reads the values; only a workspace admin saves them.
 */
export function OrchestratorPolicyPanel({ brandId }: { brandId: string }) {
  const { user, isPending } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");
  // The message is kept here, not in the form: a save refetches the policy, and the form remounts on the new values.
  const [message, setMessage] = useState<string | null>(null);
  const policy = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["orchestrator-policy", brandId]),
    queryFn: () => getOrchestratorPolicyFor({ data: { brandId } }),
    enabled: !isPending && !!user && brandId !== "",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget tolerance and model policy</CardTitle>
        <CardDescription>The values every orchestrated run in this workspace uses. A budget is a safe limit, not a hard one.</CardDescription>
      </CardHeader>
      {policy.isError && !policy.data ? <PlainErrorState error={policy.error} onRetry={() => void policy.refetch()} /> : null}
      {policy.data ? (
        <PolicyForm
          key={JSON.stringify(policy.data.policy)}
          brandId={brandId}
          data={policy.data}
          canAdmin={canAdmin}
          message={message}
          onMessage={setMessage}
          onSaved={() => void policy.refetch()}
        />
      ) : policy.isError ? null : (
        <p role="status" className="p-4 text-sm text-fg-muted sm:p-6">
          Loading the policy.
        </p>
      )}
    </Card>
  );
}

function PolicyForm({
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
  const [percent, setPercent] = useState(String(policy.budgetTolerance.percent));
  const [cents, setCents] = useState(String(policy.budgetTolerance.cents));
  const [veoOff, setVeoOff] = useState(policy.disabledModelFamilies.includes(VEO_FAMILY));
  const [others, setOthers] = useState(policy.disabledModelFamilies.filter((family) => family !== VEO_FAMILY).join(", "));
  const [saving, setSaving] = useState(false);

  const percentValue = Number(percent);
  const centsValue = Number(cents);
  const percentValid = percent.trim() !== "" && Number.isFinite(percentValue) && percentValue >= 0 && percentValue <= 100;
  const centsValid = cents.trim() !== "" && Number.isFinite(centsValue) && centsValue >= 0 && centsValue <= 10000;
  const families = [
    ...new Set([
      ...(veoOff ? [VEO_FAMILY] : []),
      ...others
        .split(",")
        .map((family) => family.trim())
        .filter((family) => family !== ""),
    ]),
  ];

  async function save() {
    if (!percentValid || !centsValid) return;
    setSaving(true);
    onMessage(null);
    try {
      await saveOrchestratorPolicyFor({ data: { brandId, disabledModelFamilies: families, budgetTolerance: { percent: percentValue, cents: centsValue } } });
      onMessage("Saved. Every run that starts from now on uses these values.");
      onSaved();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The policy could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const initialVeo = initial.disabledModelFamilies.includes(VEO_FAMILY) ? "switched off" : "on";
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4 p-4 sm:p-6"
    >
      <p className="text-sm text-fg-muted">
        Initial values: a tolerance of {initial.budgetTolerance.percent} percent or {initial.budgetTolerance.cents} cents, whichever is larger,
        and Veo ({VEO_FAMILY}) {initialVeo}.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id="policy-percent"
          label="Tolerance, percent of the budget"
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step="0.1"
          disabled={!canAdmin}
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
          error={percentValid || !canAdmin ? undefined : "Enter a percentage from 0 to 100."}
        />
        <Input
          id="policy-cents"
          label="Tolerance, cents"
          type="number"
          inputMode="decimal"
          min={0}
          max={10000}
          step="1"
          disabled={!canAdmin}
          value={cents}
          onChange={(event) => setCents(event.target.value)}
          error={centsValid || !canAdmin ? undefined : "Enter a whole number of cents from 0 to 10,000."}
        />
      </div>
      <label className="inline-flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
        <input type="checkbox" checked={veoOff} disabled={!canAdmin} onChange={(event) => setVeoOff(event.target.checked)} className="size-4" />
        Switch off Veo ({VEO_FAMILY}). Unchecked, the orchestrator may choose Veo again.
      </label>
      <Input
        id="policy-families"
        label="Other model families to switch off"
        hint="Comma-separated. A switched-off family is not offered to the orchestrator, and a plan that names one is refused."
        disabled={!canAdmin}
        value={others}
        onChange={(event) => setOthers(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" type="submit" disabled={saving || !canAdmin || !percentValid || !centsValid} aria-describedby={canAdmin ? undefined : "policy-role"}>
          Save the policy
        </Button>
        {canAdmin ? null : (
          <p id="policy-role" className="text-sm text-fg-muted">
            Only a workspace admin can change the policy.
          </p>
        )}
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
