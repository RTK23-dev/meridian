import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { setStarterLimits } from "@/lib/meridian/billing/actions";
import { starterLimitPlan } from "@/lib/meridian/billing/starter";
import { qk } from "@/lib/query/keys";
import { useBillingPageQuery, useScopedMutation } from "@/lib/query/hooks";

/**
 * One number instead of a page of limits. Paid work is refused until limits are set, so a first run needs them. This sets the ones that are
 * not set yet (the monthly budget, each brand's budget and the decision cap per call) from one monthly amount, and says what it wrote.
 * Anything already set is left alone, and the full list stays on the Billing page. Admin only; each write is audited like any other.
 */
export function StarterLimits({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const page = useBillingPageQuery(organizationId, canAdmin);
  const [amount, setAmount] = useState("10");
  const [done, setDone] = useState<string | null>(null);
  const save = useScopedMutation({
    mutationKey: ["mutation", "billing.starter-limits", organizationId],
    mutationFn: (monthlyUsd: number) => setStarterLimits({ data: { organizationId, monthlyUsd } }),
    invalidate: () => [qk.billing(organizationId)],
    onSuccess: (result) => {
      const r = result as { monthlyUsd: number; decisionCapUsd: number; written: number };
      setDone(`Done. Monthly budget and each brand's budget are $${r.monthlyUsd.toFixed(2)}, and one decision may cost at most $${r.decisionCapUsd.toFixed(2)}.`);
    },
  });
  if (!canAdmin || !page.data) return null;
  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 100000;
  const pending = valid ? starterLimitPlan(page.data, parsed).steps.length : 1;
  if (pending === 0 && !done) return null;
  const error = save.error ? plainError(save.error) : null;
  return (
    <section aria-labelledby="starter-limits" className="rounded-sharp border border-hairline bg-raised p-5 space-y-3">
      <h2 id="starter-limits" className="text-lg font-semibold text-fg-primary">Set a spending limit</h2>
      <p className="text-sm text-fg-muted">
        Meridian will not spend anything until you set a limit, and it stops at that number. Enter how much you are willing to spend in a month
        and it sets the limits for you. You can change them any time on <Link to="/billing" className="font-semibold underline underline-offset-4">Billing</Link>.
      </p>
      {done ? <p className="text-sm font-medium text-success" role="status">{done}</p> : null}
      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {pending > 0 ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Input label="Monthly budget (USD)" inputMode="decimal" value={amount} onChange={(event) => { setDone(null); setAmount(event.target.value); }} />
          </div>
          <Button type="button" disabled={!valid || save.isPending} onClick={() => void save.mutateAsync(parsed).catch(() => undefined)}>
            {save.isPending ? "Setting..." : "Set my limits"}
          </Button>
          {!valid ? <p className="text-sm text-fg-muted">Enter an amount between 1 and 100,000.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
