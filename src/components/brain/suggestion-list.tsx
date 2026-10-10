import { Button, Notice, Skeleton, errorText } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BrainKey } from "@/lib/meridian/brain";
import { resolveSuggestion } from "@/lib/meridian/machine";
import { useMarketQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { fieldLabel } from "./brain-sections";
import { acceptBlockReason, savedText, suggestionListState, type BrainSuggestion } from "./suggestions";

/**
 * Pending suggestions from stored documents. Accept writes the suggested text into its field. Reject
 * only marks the suggestion dismissed. Neither action runs on a document alone.
 */
export function SuggestionList({ brandId, canEdit, saved, formDirty }: {
  brandId: string;
  canEdit: boolean;
  saved: Partial<Record<BrainKey, string>>;
  formDirty: boolean;
}) {
  const marketQuery = useMarketQuery(brandId);
  const { reload } = useWorkspace();
  const resolveMutation = useScopedMutation({
    mutationKey: ["mutation", "brain.suggestion", brandId],
    mutationFn: (vars: { suggestionId: string; action: "accept" | "dismiss" }) => resolveSuggestion({ data: { brandId, ...vars } }),
    invalidate: (vars) => vars.action === "accept"
      ? [qk.market(brandId), qk.brand(brandId), qk.machine(brandId)]
      : [qk.market(brandId)],
    success: (vars) => (vars.action === "accept" ? "Suggestion accepted into the brain." : "Suggestion rejected."),
    // An accepted suggestion changes the brain, which the workspace list shows as completeness.
    onSuccess: (_data, vars) => {
      if (vars.action === "accept") void reload();
    },
  });
  const busyIds = usePendingVariables<{ suggestionId: string }>(["mutation", "brain.suggestion", brandId]).map((vars) => vars.suggestionId);

  const suggestions: BrainSuggestion[] = marketQuery.data?.suggestions ?? [];
  const documents = marketQuery.data?.documents ?? [];
  const state = suggestionListState(suggestions);
  const blockReason = acceptBlockReason(formDirty);

  return <div className="space-y-3">
    <h4 className="text-sm font-semibold">Suggestions waiting</h4>
    {marketQuery.isError ? (
      <div className="space-y-2">
        <Notice>{errorText(marketQuery.error)}</Notice>
        <Button type="button" variant="secondary" onClick={() => void marketQuery.refetch()}>Try again</Button>
      </div>
    ) : null}
    {marketQuery.isPending && !marketQuery.isError ? <Skeleton variant="card" className="h-24" /> : null}
    {!marketQuery.isPending && state.kind === "empty" ? (
      <p className="text-sm text-fg-muted">No suggestions are waiting. Suggestions appear here after a stored document is read by the text model.</p>
    ) : null}

    {state.kind === "ready" ? (
      <>
        <p className="text-sm text-fg-muted">Accepting replaces the saved text of that field with the suggestion. Rejecting leaves the field as it is.</p>
        {canEdit && blockReason ? <p role="note" className="rounded-md border border-warning bg-warning-soft p-3 text-sm">{blockReason}</p> : null}
        <ul className="space-y-3">
          {suggestions.map((item) => {
            const label = fieldLabel(item.field) ?? "Unknown field";
            const current = savedText(saved, item.field);
            const source = documents.find((document) => document.id === item.documentId);
            const busy = busyIds.includes(item.id);
            return <li key={item.id} className="space-y-3 rounded-md border border-border p-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold">{label}</p>
                <p className="break-all text-xs text-fg-muted">From {source?.url ? source.url : "a stored document"}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-fg-muted">Saved text</p>
                  <p className="whitespace-pre-wrap break-words text-sm">{current || "Empty"}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-fg-muted">Suggested text</p>
                  <p className="whitespace-pre-wrap break-words text-sm">{item.value}</p>
                </div>
              </div>
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    aria-label={`Accept suggestion for ${label}`}
                    disabled={busy || formDirty}
                    onClick={() => void resolveMutation.mutateAsync({ suggestionId: item.id, action: "accept" }).catch(() => undefined)}
                  >
                    Accept
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`Reject suggestion for ${label}`}
                    disabled={busy}
                    onClick={() => void resolveMutation.mutateAsync({ suggestionId: item.id, action: "dismiss" }).catch(() => undefined)}
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
            </li>;
          })}
        </ul>
      </>
    ) : null}
  </div>;
}
