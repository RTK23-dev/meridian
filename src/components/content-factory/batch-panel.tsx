import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { createContentBatch, getContentBatch, listContentBatches, retryContentBatchItem, startContentBatch } from "@/lib/meridian/content-factory/actions";
import type { BatchItemState } from "@/lib/meridian/content-factory/batch";

const STATE_LABEL: Record<BatchItemState, string> = {
  ready: "Ready",
  queued: "Queued",
  running: "Running",
  awaiting_review: "Awaiting review",
  blocked: "Blocked",
  failed: "Failed",
  retryable: "Retryable",
  delivered: "Delivered",
};

const STATE_VARIANT: Record<BatchItemState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  ready: "neutral",
  queued: "info",
  running: "info",
  awaiting_review: "warning",
  blocked: "warning",
  failed: "danger",
  retryable: "warning",
  delivered: "success",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Batches of this brand's draft videos (prompt 15). A batch starts its videos in order under one budget: a start the engine refuses is kept
 * on its video and the batch goes on, and a start that would pass the budget stops the batch. Each video shows its own state, read from the
 * engine, and a failed one can be retried alone; its siblings are not changed.
 */
export function BatchCard({ brandId, brandName, drafts }: { brandId: string; brandName: string; drafts: Array<{ id: string; title: string }> }) {
  const { user } = useCurrentUserState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);

  const batches = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["content-factory", "batches", brandId]),
    queryFn: () => listContentBatches({ data: { brandId } }),
  });
  const detail = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["content-factory", "batch", selectedId]),
    queryFn: () => getContentBatch({ data: { batchId: selectedId ?? "" } }),
    enabled: selectedId !== null,
  });

  function toggle(sessionId: string) {
    setChosen((current) => (current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId]));
  }

  async function make() {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const made = await createContentBatch({
        data: { brandId, title: name, budgetUsd: budget.trim() === "" ? Number.NaN : Number(budget), sessionIds: chosen },
      });
      setSelectedId(made.id);
      setName("");
      setBudget("");
      setChosen([]);
      await batches.refetch();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The batch could not be made. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (selectedId === null) return;
    setBusy(true);
    setItemError(null);
    setNotice(null);
    try {
      const outcome = await startContentBatch({ data: { batchId: selectedId } });
      const parts = [`Started ${outcome.started} ${outcome.started === 1 ? "video" : "videos"}.`];
      if (outcome.refused > 0) parts.push(`${outcome.refused} ${outcome.refused === 1 ? "was" : "were"} refused and stay draft, with the reason on each.`);
      if (outcome.stoppedAtBudget) parts.push("The batch stopped at its budget, so the videos after it were not started.");
      setNotice(parts.join(" "));
      await detail.refetch();
    } catch (error) {
      setItemError(error instanceof Error ? error.message : "The batch could not be started. Nothing more was started.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(sessionId: string) {
    if (selectedId === null) return;
    setBusy(true);
    setItemError(null);
    setNotice(null);
    try {
      await retryContentBatchItem({ data: { batchId: selectedId, sessionId } });
      setNotice("A new attempt was made for that video. The other videos in the batch are unchanged.");
      await detail.refetch();
    } catch (error) {
      setItemError(error instanceof Error ? error.message : "The video could not be retried. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const items = detail.data?.items ?? [];
  const canStart = items.some((item) => item.state === "ready" || item.state === "blocked");
  const canMake = !busy && name.trim().length > 0 && chosen.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Batches of videos for {brandName}</CardTitle>
        <CardDescription>
          Make a batch from draft videos and start them together under one budget. A start the engine refuses stays on its video with the reason. A start that would pass the budget stops the batch. A failed video can be retried alone.
        </CardDescription>
      </CardHeader>

      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canMake) void make();
        }}
      >
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Make a batch from draft videos</legend>
          {drafts.length === 0 ? (
            <p className="text-sm text-fg-muted">There are no draft videos for this brand. Make a video first, then group it into a batch.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <label className="inline-flex min-h-11 items-center gap-2">
                    <input type="checkbox" checked={chosen.includes(draft.id)} onChange={() => toggle(draft.id)} />
                    {draft.title}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Input id="batch-name" label="Batch name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          <Input
            id="batch-budget"
            type="number"
            min="0"
            step="0.01"
            label="Batch budget (USD)"
            hint="A hard limit on what the batch's videos may commit. Leave it empty only if you do not want a batch."
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </fieldset>
        {formError !== null ? <p role="alert" className="text-sm text-danger">{formError}</p> : null}
        <Button type="submit" disabled={!canMake}>Make the batch</Button>
      </form>

      {batches.isError && !batches.data ? <div className="mt-4"><PlainErrorState error={batches.error} onRetry={() => void batches.refetch()} /></div> : null}
      {batches.data && batches.data.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Batches</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {batches.data.map((batch) => (
              <li key={batch.id}>
                <Button type="button" size="sm" variant="secondary" aria-pressed={selectedId === batch.id} onClick={() => { setSelectedId(batch.id); setNotice(null); setItemError(null); }}>
                  {batch.title} · {batch.itemCount} {batch.itemCount === 1 ? "video" : "videos"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.data ? (
        <section aria-labelledby="batch-detail-title" className="mt-5 space-y-3">
          <h3 id="batch-detail-title" className="text-sm font-semibold">{detail.data.title}</h3>
          <p className="text-sm text-fg-muted">
            Budget {money.format(detail.data.budgetUsd)} · committed {money.format(detail.data.committedUsd)} by the videos the engine has taken.
          </p>
          <ol className="divide-y divide-border text-sm">
            {items.map((item) => (
              <li key={item.sessionId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold">{item.title}</p>
                  <p className="text-fg-muted">{item.reason}</p>
                  {item.budgetUsd === null ? <p className="text-fg-muted">No budget set on this video.</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={STATE_VARIANT[item.state]}>{STATE_LABEL[item.state]}</Badge>
                  {item.retryable ? (
                    <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => void retry(item.sessionId)}>
                      Retry this video<span className="sr-only"> {item.title}</span>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <Button type="button" disabled={busy || !canStart} onClick={() => void start()}>Start the batch</Button>
          {!canStart ? <p className="text-sm text-fg-muted">Nothing in this batch is waiting to start.</p> : null}
        </section>
      ) : null}
      {notice !== null ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      {itemError !== null ? <p role="alert" className="mt-3 text-sm text-danger">{itemError}</p> : null}
    </Card>
  );
}
