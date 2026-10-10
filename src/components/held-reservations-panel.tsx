import { useState } from "react";
import { Button, ErrorState, Field, Input, Notice, Panel, TextArea, errorText } from "@/components/ui";
import { resolveHeldBudgetReservation } from "@/lib/meridian/studio/actions";
import type { HeldReservationResolution } from "@/lib/meridian/security/held-reservations";
import { qk } from "@/lib/query/keys";
import { useHeldReservationsQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";

type Draft = { note: string; reference: string; spend: string };
const EMPTY_DRAFT: Draft = { note: "", reference: "", spend: "" };

type ResolveVars = {
  reservationId: string;
  resolution: HeldReservationResolution;
  note: string;
  reference: string;
  observed: number | undefined;
};

/**
 * Admin-only list of budget reservations held for an uncertain provider outcome. Each row is
 * resolved explicitly: release it when the provider confirms nothing was billed, or settle it at
 * the billed amount with the invoice reference. The server re-checks the role and the tenant.
 */
export function HeldReservationsPanel({ brandId }: { brandId: string }) {
  const held = useHeldReservationsQuery(brandId);
  const resolveKey = ["mutation", "held-reservation.resolve", brandId] as const;
  const resolving = usePendingVariables<ResolveVars>(resolveKey).map((vars) => vars.reservationId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const resolveAction = useScopedMutation({
    mutationKey: resolveKey,
    mutationFn: (vars: ResolveVars) => resolveHeldBudgetReservation({
      data: {
        brandId,
        reservationId: vars.reservationId,
        resolution: vars.resolution,
        note: vars.note,
        providerReference: vars.reference,
        observedSpendUsd: vars.observed,
      },
    }),
    // A resolved reservation changes the held list and the budget shown on the studio screen.
    invalidate: () => [qk.heldReservations(brandId), qk.studio(brandId)],
    onSuccess: (result, vars) => {
      setNotice(result.outcome === "RELEASED" ? "Released. The held budget is back in the account." : "Settled at the recorded provider amount.");
      setDrafts((current) => {
        const next = { ...current };
        delete next[vars.reservationId];
        return next;
      });
    },
  });

  function draftFor(reservationId: string) {
    return drafts[reservationId] ?? EMPTY_DRAFT;
  }
  function patch(reservationId: string, change: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [reservationId]: { ...draftFor(reservationId), ...change } }));
  }

  async function resolve(reservationId: string, resolution: HeldReservationResolution) {
    const draft = draftFor(reservationId);
    const observed = draft.spend.trim() === "" ? undefined : Number(draft.spend);
    await resolveAction
      .mutateAsync({ reservationId, resolution, note: draft.note, reference: draft.reference, observed })
      .catch(() => undefined);
  }

  if (held.isPending) return null;
  if (held.isError && !held.data) return <ErrorState message="Held budget reservations could not be loaded." onRetry={() => void held.refetch()} />;
  if (!held.data) return null;
  if (held.data.length === 0 && !notice) return null;

  return (
    <Panel>
      <h3 className="font-display text-xl">Held budget reservations</h3>
      <p className="mt-1 text-sm text-muted">
        The provider outcome is uncertain, so this budget stays reserved until an admin resolves it. Nothing settles on its own.
      </p>
      {resolveAction.error ? <Notice>{errorText(resolveAction.error)}</Notice> : null}
      {notice ? <p role="status" className="mt-2 text-sm">{notice}</p> : null}
      <ul className="mt-4 space-y-4">
        {held.data.map((row) => {
          const draft = draftFor(row.reservationId);
          const noteValid = draft.note.trim().length >= 10;
          const busy = resolving.includes(row.reservationId);
          return (
            <li key={row.reservationId} className="space-y-3 rounded-md border border-border p-4">
              <p className="text-sm">
                <strong>${row.amountUsd.toFixed(2)}</strong> reserved for {row.provider}. Job status: {row.jobStatus}
                {row.errorCode ? ` (${row.errorCode})` : ""}. Held since {new Date(row.heldSince).toLocaleString()}.
              </p>
              <Field label="Why this outcome was resolved" hint="Required. At least 10 characters." required>
                <TextArea value={draft.note} onChange={(event) => patch(row.reservationId, { note: event.currentTarget.value })} />
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Provider invoice or usage reference" hint="Needed only when the provider billed the job.">
                  <Input value={draft.reference} onChange={(event) => patch(row.reservationId, { reference: event.currentTarget.value })} />
                </Field>
                <Field label="Billed amount (USD)" hint="Needed only when the provider billed the job.">
                  <Input type="number" min="0" step="0.01" value={draft.spend} onChange={(event) => patch(row.reservationId, { spend: event.currentTarget.value })} />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={busy || !noteValid} onClick={() => void resolve(row.reservationId, "not_accepted")}>
                  Provider confirms not billed: release
                </Button>
                <Button type="button" disabled={busy || !noteValid} onClick={() => void resolve(row.reservationId, "billed_no_artifact")}>
                  Billed, no artifact: settle at amount
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
