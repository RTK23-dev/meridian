import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, ErrorState, Field, Input, Card, Textarea } from "@/components/ui";
import { PlainErrorNotice } from "@/components/plain-error";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { resolveHeldBudgetReservation } from "@/lib/meridian/studio/actions";
import type { HeldReservationResolution } from "@/lib/meridian/security/held-reservations";
import { qk } from "@/lib/query/keys";
import { useHeldReservationsQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";

/**
 * The resolution note is trimmed and must be 10 to 500 characters, as resolveHeldReservation reads it. The billed amount is
 * optional; when given, it is read with Number() and must be a finite amount of zero or more.
 */
const heldDraftSchema = z.object({
  note: z.string()
    .refine((value) => value.trim().length >= 10, "Write at least 10 characters.")
    .refine((value) => value.trim().length <= 500, "Use 500 characters or fewer."),
  reference: z.string(),
  spend: z.string().refine(
    (value) => value.trim() === "" || (Number.isFinite(Number(value)) && Number(value) >= 0),
    "Enter an amount of 0 or more, in dollars.",
  ),
});

type HeldDraftInput = z.input<typeof heldDraftSchema>;
const EMPTY_DRAFT: HeldDraftInput = { note: "", reference: "", spend: "" };

type ResolveVars = {
  reservationId: string;
  resolution: HeldReservationResolution;
  note: string;
  reference: string;
  observed: number | undefined;
};

type HeldRow = { reservationId: string; amountUsd: number; provider: string; jobStatus: string; errorCode?: string | null; heldSince: string };

/**
 * Admin-only list of budget reservations held for an uncertain provider outcome. Each row is
 * resolved explicitly: release it when the provider confirms nothing was billed, or settle it at
 * the billed amount with the invoice reference. The server re-checks the role and the tenant.
 */
export function HeldReservationsPanel({ brandId }: { brandId: string }) {
  const held = useHeldReservationsQuery(brandId);
  const resolveKey = ["mutation", "held-reservation.resolve", brandId] as const;
  const resolving = usePendingVariables<ResolveVars>(resolveKey).map((vars) => vars.reservationId);
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
    onSuccess: (result) => {
      setNotice(result.outcome === "RELEASED" ? "Released. The held budget is back in the account." : "Settled at the recorded provider amount.");
    },
  });

  if (held.isPending) return null;
  if (held.isError && !held.data) return <ErrorState message="Held budget reservations could not be loaded." onRetry={() => void held.refetch()} />;
  if (!held.data) return null;
  if (held.data.length === 0 && !notice) return null;

  return (
    <Card>
      <h3 className="font-display text-xl">Held budget reservations</h3>
      <p className="mt-1 text-sm text-muted">
        The provider outcome is uncertain, so this budget stays reserved until an admin resolves it. Nothing settles on its own.
      </p>
      {resolveAction.error ? <PlainErrorNotice error={resolveAction.error} /> : null}
      {notice ? <p role="status" className="mt-2 text-sm">{notice}</p> : null}
      <ul className="mt-4 space-y-4">
        {held.data.map((row) => (
          <HeldReservationRow
            key={row.reservationId}
            row={row}
            busy={resolving.includes(row.reservationId)}
            onResolve={(resolution, draft) => {
              const observed = draft.spend.trim() === "" ? undefined : Number(draft.spend);
              return resolveAction.mutateAsync({ reservationId: row.reservationId, resolution, note: draft.note, reference: draft.reference, observed }).then(() => undefined, () => undefined);
            }}
          />
        ))}
      </ul>
    </Card>
  );
}

/** One held reservation with its own draft. The draft is checked before either resolution is sent. */
function HeldReservationRow({ row, busy, onResolve }: {
  row: HeldRow;
  busy: boolean;
  onResolve: (resolution: HeldReservationResolution, draft: HeldDraftInput) => Promise<void>;
}) {
  const form = useForm<HeldDraftInput>({ resolver: zodResolver(heldDraftSchema), defaultValues: EMPTY_DRAFT, mode: "onChange" });
  const { register, formState: { errors, isDirty } } = form;

  async function resolve(resolution: HeldReservationResolution) {
    const valid = await form.trigger();
    if (!valid) return;
    await onResolve(resolution, form.getValues());
    form.reset(EMPTY_DRAFT);
  }

  return (
    <li className="space-y-3 rounded-md border border-border p-4">
      <UnsavedChangesGuard dirty={isDirty} />
      <p className="text-sm">
        <strong>${row.amountUsd.toFixed(2)}</strong> reserved for {row.provider}. Job status: {row.jobStatus}
        {row.errorCode ? ` (${row.errorCode})` : ""}. Held since {new Date(row.heldSince).toLocaleString()}.
      </p>
      <Field label="Why this outcome was resolved" hint="Required. At least 10 characters." required error={errors.note?.message}>
        <Textarea {...register("note")} />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Provider invoice or usage reference" hint="Needed only when the provider billed the job." error={errors.reference?.message}>
          <Input {...register("reference")} />
        </Field>
        <Field label="Billed amount (USD)" hint="Needed only when the provider billed the job." error={errors.spend?.message}>
          <Input {...register("spend")} type="number" min="0" step="0.01" />
        </Field>
      </div>
      <FormDiscardBar dirty={isDirty} subject="held reservation" onDiscard={() => form.reset(EMPTY_DRAFT)} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy || form.formState.isSubmitting} onClick={() => void resolve("not_accepted")}>
          Provider confirms not billed: release
        </Button>
        <Button type="button" disabled={busy || form.formState.isSubmitting} onClick={() => void resolve("billed_no_artifact")}>
          Billed, no artifact: settle at amount
        </Button>
      </div>
    </li>
  );
}
