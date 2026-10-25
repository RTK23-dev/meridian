import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { releaseGenerationHold } from "@/lib/meridian/providers/hold-review.server";
import { qk } from "@/lib/query/keys";
import { useScopedMutation, useUncertainHoldsQuery } from "@/lib/query/hooks";

type UncertainHold = { id: string; operation: string; model: string; estimateUsd: number; createdAt: string; error: string };

type ReleaseResult = { status: "released"; holdId: string } | { status: "refused"; reason: string };

/** The smallest reason an administrator may give. The server enforces the same bound. */
const MIN_REASON = 10;

/**
 * The budget holds whose call may have been billed. Each one counts against the month until an administrator checks the provider's
 * account and releases it with a reason. Nothing releases a hold on its own, and each release is recorded with who released it.
 */
export function UncertainHoldsPanel({ organizationId }: { organizationId: string }) {
  const holds = useUncertainHoldsQuery(organizationId);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const release = useScopedMutation<{ holdId: string; reason: string }, ReleaseResult>({
    mutationKey: ["mutation", "uncertain-hold.release", organizationId],
    mutationFn: async ({ holdId, reason }) => {
      const result = (await releaseGenerationHold({ data: { organizationId, holdId, reason } })) as ReleaseResult;
      // A refused release is thrown, so its reason is shown and the hold stays as it was.
      if (result.status === "refused") throw new Error(result.reason);
      return result;
    },
    invalidate: () => [qk.uncertainHolds(organizationId), qk.generationModels(organizationId)],
    onSuccess: (result) => {
      if (result.status === "released") setNotice(`Hold ${result.holdId} is released. It no longer counts against the month.`);
    },
  });

  const list = (holds.data?.holds ?? []) as UncertainHold[];
  const releaseError = release.error ? plainError(release.error) : null;

  return (
    <section className="space-y-3 border-t border-border pt-4" aria-labelledby="uncertain-holds-title" data-row="uncertain_holds">
      <div className="space-y-1">
        <h3 id="uncertain-holds-title" className="font-semibold text-fg">
          Uncertain holds
        </h3>
        <p className="text-sm text-fg-muted">
          A call that may have been billed keeps its hold, and the hold counts against the month, until an administrator checks the
          provider's account and releases it. Nothing releases a hold automatically. Each release is recorded with who released it and why.
        </p>
      </div>
      {holds.isPending ? <p className="text-sm text-fg-muted">Reading the uncertain holds...</p> : null}
      {holds.isError ? <p className="text-sm text-warning" role="status">The uncertain holds could not be read.</p> : null}
      {holds.isSuccess && list.length === 0 ? <p className="text-sm text-fg-muted">No hold is uncertain.</p> : null}
      {notice ? (
        <p className="text-sm text-fg" role="status">
          {notice}
        </p>
      ) : null}
      {releaseError ? <PlainErrorMessage message={releaseError.message} raw={releaseError.raw} /> : null}
      {list.map((hold) => {
        const reason = reasons[hold.id] ?? "";
        const tooShort = reason.trim().length < MIN_REASON;
        return (
          <div key={hold.id} className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm text-fg">
              <span className="font-medium">{hold.operation}</span> with <span className="font-mono">{hold.model}</span>, held at up to $
              {hold.estimateUsd.toFixed(6)}, on {new Date(hold.createdAt).toLocaleString()}.
            </p>
            <p className="text-xs text-fg-muted">{hold.error}</p>
            <Input
              label="Reason for releasing this hold"
              value={reason}
              onChange={(event) => setReasons((current) => ({ ...current, [hold.id]: event.target.value }))}
              hint={`At least ${MIN_REASON} characters, such as what the provider account shows for this call.`}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={tooShort || release.isPending}
              onClick={() => {
                setNotice(null);
                release.mutate({ holdId: hold.id, reason: reason.trim() });
              }}
            >
              Release this hold
            </Button>
          </div>
        );
      })}
    </section>
  );
}
