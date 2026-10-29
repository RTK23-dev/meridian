import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, Field, Input, SelectInput } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { createContentBatch, createContentVariations, getContentBatch, listContentBatches, retryContentBatchItem, startContentBatch } from "@/lib/meridian/content-factory/actions";
import { batchSummaryCsv, stateCounts, type BatchItemState } from "@/lib/meridian/content-factory/batch";
import { DEFAULT_VARIATIONS, MAX_VARIATIONS, MIN_VARIATIONS, minItemCents, splitBudget } from "@/lib/meridian/content-factory/variations";

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

/** The most a batch budget may be, in dollars. The server holds the same limit. */
const BATCH_BUDGET_MAX = 100_000;

/** A budget the server will accept: a positive amount in dollars, up to the limit. Empty is not a budget. */
function budgetOf(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value <= BATCH_BUDGET_MAX ? value : null;
}

/**
 * Batches of this brand's draft videos (prompt 15). A batch starts its videos in order under one budget: a start the engine refuses is kept
 * on its video and the batch goes on, and a start that would pass the budget stops the batch. Each video shows its own state, read from the
 * engine, and a failed one can be retried alone; its siblings are not changed.
 */
type DraftOption = { id: string; title: string };

export function BatchCard({ brandId, brandName, drafts, sources = [], onOpenSession, onBatchCreated }: { brandId: string; brandName: string; drafts: DraftOption[]; sources?: DraftOption[]; onOpenSession: (sessionId: string) => void; onBatchCreated?: () => void }) {
  const { user } = useCurrentUserState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [count, setCount] = useState(String(DEFAULT_VARIATIONS));
  const [total, setTotal] = useState("");
  const [variationError, setVariationError] = useState<string | null>(null);
  const queryClient = useQueryClient();

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
      const made = await createContentBatch({ data: { brandId, title: name, budgetUsd: budgetOf(budget) ?? Number.NaN, sessionIds: chosen } });
      setSelectedId(made.id);
      setName("");
      setBudget("");
      setChosen([]);
      await batches.refetch();
      // The videos in the batch are no longer free drafts, so the video list the other cards read is stale.
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && part.startsWith("content-factory")) });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The batch could not be made. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const chosenSource = sources.some((item) => item.id === sourceId) ? sourceId : (sources[0]?.id ?? "");
  const variationCount = Number(count);
  const variationTotal = total.trim() === "" ? Number.NaN : Number(total);
  const variationSplit = splitBudget(variationTotal, variationCount);
  const canVary = !busy && chosenSource !== "" && variationSplit.ok;

  async function vary() {
    setBusy(true);
    setVariationError(null);
    setNotice(null);
    setItemError(null);
    try {
      const made = await createContentVariations({ data: { sourceSessionId: chosenSource, count: variationCount, totalBudgetUsd: variationTotal } });
      setSelectedId(made.id);
      setTotal("");
      await batches.refetch();
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && part.startsWith("content-factory")) });
      onBatchCreated?.();
      setNotice(`Created ${made.items.length} draft videos in one batch. Nothing has started. Read the list, open any video, then press Start batch when you are ready.`);
    } catch (error) {
      setVariationError(error instanceof Error ? error.message : "The variations could not be made. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  function downloadSummary() {
    if (!detail.data) return;
    const csv = batchSummaryCsv(detail.data, detail.data.items.map((item) => ({ position: item.position, title: item.title, angle: item.angle, state: item.state, reason: item.reason, budgetUsd: item.budgetUsd, attempts: item.attempts })));
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${detail.data.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "batch"}-summary.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function start() {
    if (selectedId === null) return;
    setBusy(true);
    setItemError(null);
    setNotice(null);
    try {
      const outcome = await startContentBatch({ data: { batchId: selectedId } });
      const parts = [`Started ${outcome.started} ${outcome.started === 1 ? "video" : "videos"}.`];
      if (outcome.started === 0 && outcome.refused === 0) parts.push("No video in this batch is a draft, so nothing was started.");
      if (outcome.refused > 0) parts.push(`${outcome.refused} ${outcome.refused === 1 ? "was" : "were"} refused and stay draft, with the reason on each.`);
      if (outcome.stoppedAtBudget) parts.push("The batch stopped at its budget, so the videos after it were not started.");
      await detail.refetch();
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && part.startsWith("content-factory")) });
      setNotice(parts.join(" "));
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
      await detail.refetch();
      setNotice("A new attempt was made for that video. The other videos in the batch are unchanged.");
    } catch (error) {
      setItemError(error instanceof Error ? error.message : "The video could not be retried. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const items = detail.data?.items ?? [];
  // Start takes only the drafts in the batch. A started video is never started again, so it does not enable the button.
  const canStart = items.some((item) => item.draft);
  const budgetValue = budgetOf(budget);
  const canMake = !busy && name.trim().length > 0 && chosen.length > 0 && budgetValue !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Batches of videos for {brandName}</CardTitle>
        <CardDescription>
          Make a batch from draft videos and start them together under one budget. A start the engine refuses stays on its video with the reason. A start that would pass the budget stops the batch. A failed video can be retried alone.
        </CardDescription>
      </CardHeader>

      <form
        className="mt-4 space-y-3 border-b border-border pb-4"
        aria-label="Create video variations"
        onSubmit={(event) => {
          event.preventDefault();
          if (canVary) void vary();
        }}
      >
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Create video variations</legend>
          <p className="text-sm text-fg-muted">
            Pick a draft that has an uploaded reference video, attached Market research and a plain instruction. Meridian makes original drafts from it, each with its own angle, and groups them into one batch. The reference is used only for structure and pacing. Nothing starts until you press Start batch.
          </p>
          {sources.length === 0 ? (
            <p className="text-sm text-fg-muted">There is no draft to use as a source yet. Make a draft video with a reference, Market research and an instruction first.</p>
          ) : (
            <>
              <Field label="Source draft" hint="The source stays as it is and can be used again.">
                <SelectInput value={chosenSource} onChange={(event) => setSourceId(event.target.value)}>
                  {sources.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </SelectInput>
              </Field>
              <Input id="variations-count" type="number" min={MIN_VARIATIONS} max={MAX_VARIATIONS} step="1" label="Number of videos" hint={`Between ${MIN_VARIATIONS} and ${MAX_VARIATIONS}.`} value={count} onChange={(event) => setCount(event.target.value)} />
              <Input
                id="variations-budget"
                type="number"
                min="0"
                step="0.01"
                label="Total batch budget (USD)"
                hint={`Split equally across the videos. Each needs at least $${(minItemCents() / 100).toFixed(2)}.`}
                value={total}
                onChange={(event) => setTotal(event.target.value)}
              />
            </>
          )}
        </fieldset>
        {variationError !== null ? <p role="alert" className="text-sm text-danger">{variationError}</p> : null}
        {sources.length > 0 && total.trim() !== "" && !variationSplit.ok ? <p className="text-sm text-danger">{variationSplit.reason}</p> : null}
        <Button type="submit" disabled={!canVary}>Create video variations</Button>
      </form>

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
            hint={`Required. The most the batch's videos may commit together, up to $${BATCH_BUDGET_MAX.toLocaleString("en-US")}.`}
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </fieldset>
        {formError !== null ? <p role="alert" className="text-sm text-danger">{formError}</p> : null}
        {budgetValue === null && budget.trim() !== "" ? <p className="text-sm text-danger">{`Enter a budget above $0 and up to $${BATCH_BUDGET_MAX.toLocaleString("en-US")}.`}</p> : null}
        <Button type="submit" disabled={!canMake} aria-describedby={canMake ? undefined : "batch-make-reason"}>Make the batch</Button>
        {canMake ? null : <p id="batch-make-reason" className="text-sm text-fg-muted">{budgetValue === null ? "Enter a batch budget to make the batch." : name.trim().length === 0 ? "Give the batch a name to make it." : "Choose at least one draft video for the batch."}</p>}
      </form>

      {batches.isError && !batches.data ? <div className="mt-4"><PlainErrorState error={batches.error} onRetry={() => void batches.refetch()} /></div> : null}
      {batches.data && batches.data.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Batches</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {batches.data.map((batch) => (
              <li key={batch.id}>
                                <Button type="button" size="sm" variant="secondary" className="max-w-full whitespace-normal break-words text-left" aria-pressed={selectedId === batch.id} onClick={() => { setSelectedId(batch.id); setNotice(null); setItemError(null); }}>
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
          <p className="text-sm" aria-label="Videos by state">
            {stateCounts(items).map((entry, index) => <span key={entry.state}>{index > 0 ? " · " : ""}{entry.count} {STATE_LABEL[entry.state].toLowerCase()}</span>)}
          </p>
          <ol className="divide-y divide-border text-sm">
            {items.map((item) => (
              <li key={item.sessionId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold">{item.title}</p>
                  <p className="text-fg-muted">{item.reason}</p>
                  {item.budgetUsd === null ? <p className="text-fg-muted">No budget set on this video.</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant={STATE_VARIANT[item.state]}>{STATE_LABEL[item.state]}</Badge>
                  <Button type="button" variant="quiet" size="sm" onClick={() => onOpenSession(item.sessionId)}>Open video<span className="sr-only"> {item.title}</span></Button>
                  {item.retryable ? (
                    <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => void retry(item.sessionId)}>
                      Retry this video<span className="sr-only"> {item.title}</span>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={busy || !canStart} onClick={() => void start()}>Start the batch</Button>
            <Button type="button" variant="secondary" disabled={items.length === 0} onClick={downloadSummary}>Download batch summary (CSV)</Button>
          </div>
          <p className="text-sm text-fg-muted">The summary lists each video with the state the engine reports. It holds no video files, and a video that is not delivered is never shown as finished.</p>
          {!canStart ? <p className="text-sm text-fg-muted">Nothing in this batch is a draft, so there is nothing to start.</p> : null}
        </section>
      ) : null}
      {notice !== null ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      {itemError !== null ? <p role="alert" className="mt-3 text-sm text-danger">{itemError}</p> : null}
    </Card>
  );
}
