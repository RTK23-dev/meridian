import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { PlugZap } from "lucide-react";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, Textarea, toast } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { decideDeliveryApproval, getDeliveredMasterLink, getDeliveryApproval, reviseContentFactorySession, reviseContentFactoryWithDirection, startContentFactoryRun } from "@/lib/meridian/content-factory/actions";
import { approvalProblem, type ApprovalRecord, type ApprovalState } from "@/lib/meridian/content-factory/approval";
import { costLabel, type FeedCard } from "@/lib/meridian/content-factory/feed";
import { MAX_MESSAGE_CHARS } from "@/lib/meridian/content-factory/model";
import type { RunView } from "@/lib/meridian/content-factory/service";
import { FlowBoard } from "./run-board";
import { QualityScore } from "./quality-score";
import { STATUS_LABELS } from "./status";

export function RunPanel({ sessionId, run, lastRefusal, onStarted, guided = false }: { sessionId: string; run: UseQueryResult<RunView>; lastRefusal: string[]; onStarted: () => void; guided?: boolean }) {
  if (run.isError && !run.data) return <PlainErrorState error={run.error} onRetry={() => void run.refetch()} />;
  if (!run.data) {
    return (
      <Card aria-busy="true">
        <CardHeader><CardTitle>{guided ? "Video status" : "Decisions"}</CardTitle></CardHeader>
        <div role="status" aria-label="Loading the run" className="space-y-3"><Skeleton /><Skeleton /><Skeleton variant="card" /></div>
      </Card>
    );
  }
  const view = run.data;
  if (view.stage === "missing") return <ErrorState message={view.reason} onRetry={() => void run.refetch()} />;
  if (view.stage === "draft") return <DraftPanel sessionId={sessionId} view={view} lastRefusal={lastRefusal} onStarted={onStarted} guided={guided} />;
  const feed = view.feed;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{guided ? "Video status" : "Decisions"}</CardTitle>
        <CardDescription>
          {feed.headline} Request <code className="break-all">{feed.requestId}</code>.{feed.active ? " This view refreshes every few seconds while the engine works." : ""}
        </CardDescription>
      </CardHeader>
      <p className="mb-2 text-sm text-fg-muted">{view.referenceNote}</p>
      {view.inputs.length > 0 ? <div className="mb-4"><Lines title="Inputs" lines={view.inputs} /></div> : null}
      <p className="mb-4 text-sm">
        Whole request: {feed.total.calls} paid {feed.total.calls === 1 ? "call" : "calls"} · estimate {costLabel(feed.total.estimateUsd)} · reserved {costLabel(feed.total.reservedUsd)} · billed {costLabel(feed.total.billedUsd)}
        {feed.unattributedCalls > 0 ? <span className="block text-xs text-fg-muted">{feed.unattributedCalls} of these calls are not tied to one step on the ledger (for example a Claude check), so they appear only in this total.</span> : null}
      </p>
      <FlowBoard sessionId={sessionId} feed={feed} onChanged={onStarted} />
      {feed.status.status === "delivered" ? <DeliveredDownload sessionId={sessionId} /> : null}
      {feed.status.status === "delivered" ? <DeliveryApproval sessionId={sessionId} /> : null}
      {feed.status.status === "delivered" ? <QualityScore sessionId={sessionId} /> : null}
      <details className="mb-4">
        <summary className="cursor-pointer text-sm font-semibold">Step details: inputs, outputs, reasons and models</summary>
        <ol aria-label="Engine steps" className="mt-3 space-y-3">
          {feed.cards.map((card, index) => <StepCard key={card.id} card={card} index={index + 1} />)}
        </ol>
      </details>
      {view.canRevise ? <ReviseControl sessionId={sessionId} onStarted={onStarted} /> : null}
    </Card>
  );
}

function DraftPanel({ sessionId, view, lastRefusal, onStarted, guided = false }: { sessionId: string; view: Extract<RunView, { stage: "draft" }>; lastRefusal: string[]; onStarted: () => void; guided?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ problems: string[]; notConnected: string[] } | null>(null);
  const blocked = view.problems.length > 0 || view.notConnected.length > 0;
  const start = async () => {
    setBusy(true);
    try {
      const outcome = await startContentFactoryRun({ data: { sessionId } });
      if (outcome.status === "started") {
        toast.success("The engine accepted the request.");
        setRefusal(null);
      } else {
        setRefusal({ problems: outcome.problems, notConnected: outcome.notConnected });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The video was not started.");
    } finally {
      setBusy(false);
      onStarted();
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisions</CardTitle>
        <CardDescription>{guided ? "This is where the video status and any reason it cannot start appear. When the engine is connected, the finished video and review controls appear here." : "When you ask for the video, the engine analyses the reference, writes the script (unless you sent script lines), plans the shots, picks the models, makes the voice and visuals, edits and renders. Each step appears here with its reason and its cost."}</CardDescription>
      </CardHeader>
      <p className="mb-4 text-sm text-fg-muted">{view.referenceNote}</p>
      {view.problems.length > 0 ? (
        <section aria-labelledby="cf-needs" className="mb-4 space-y-2">
          <h3 id="cf-needs" className="text-sm font-semibold">Before the engine can start, the session needs</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{view.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        </section>
      ) : (
        <p className="mb-4 text-sm">The session has everything the engine's request needs.</p>
      )}
      {view.priorRequestIds.length > 0 ? (
        <p className="mb-4 text-sm text-fg-muted">This is a revision. The earlier {view.priorRequestIds.length === 1 ? "request stays" : "requests stay"} stored: {view.priorRequestIds.join(", ")}.</p>
      ) : null}
      {view.inputs.length > 0 ? <div className="mb-4"><Lines title="Inputs" lines={view.inputs} /></div> : null}
      {view.notConnected.length > 0 ? (
        <section aria-labelledby="cf-not-connected" className="mb-4 space-y-2 rounded-md border border-border bg-surface-2 p-3">
          <h3 id="cf-not-connected" className="flex items-center gap-2 text-sm font-semibold"><PlugZap aria-hidden="true" className="size-4" />The video engine is not connected</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{view.notConnected.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="md" loading={busy} disabled={busy || blocked} aria-describedby={blocked ? "cf-start-reason" : undefined} onClick={() => void start()}>Make this video</Button>
        {blocked ? <p id="cf-start-reason" className="text-sm text-fg-muted">{view.problems.length > 0 ? "Add the items listed above in the chat or Settings, on the left, then make the video." : "Connect the engine first."}</p> : null}
      </div>
      {refusal || lastRefusal.length > 0 ? (
        <div role="status" className="mt-4 space-y-1 text-sm">
          <p className="font-semibold">The last request was not started:</p>
          <ul className="list-disc space-y-1 pl-5">{(refusal ? [...refusal.problems, ...refusal.notConnected] : lastRefusal).map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>
      ) : null}
    </Card>
  );
}

function ReviseControl({ sessionId, onStarted }: { sessionId: string; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState("");
  const revise = async () => {
    setBusy(true);
    try {
      // A direction for the whole video is posted as the revision's next instruction, so the new brief carries it (D9).
      const outcome = direction.trim() === "" ? await reviseContentFactorySession({ data: { sessionId } }) : await reviseContentFactoryWithDirection({ data: { sessionId, direction } });
      if (outcome.status === "draft") {
        toast.success("The session is open for a revision. The earlier video stays stored.");
        setDirection("");
      } else {
        toast.error(outcome.reason);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The revision was not opened.");
    } finally {
      setBusy(false);
      onStarted();
    }
  };
  return (
    <div className="mt-4 space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="cf-revise-direction" className="block text-sm font-semibold">Direction for the whole video (optional)</label>
        <textarea
          id="cf-revise-direction"
          rows={2}
          maxLength={MAX_MESSAGE_CHARS}
          value={direction}
          disabled={busy}
          onChange={(event) => setDirection(event.target.value)}
          placeholder="For example: make the hook punchier and shorter"
          className="w-full rounded-md border border-border bg-surface p-2 text-sm disabled:opacity-60"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="md" variant="secondary" loading={busy} disabled={busy} onClick={() => void revise()}>
          {direction.trim() === "" ? "Revise this video" : "Revise with this direction"}
        </Button>
        <p className="text-sm text-fg-muted">Adds your next instruction, then makes another video. The video is planned again, and it reserves its own estimate up to the session&apos;s budget. This one is kept.</p>
      </div>
    </div>
  );
}

function Lines({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-fg-muted">{title}</h4>
      <ul className="mt-1 space-y-1 text-sm">{lines.map((line, index) => <li key={`${index}-${line}`} className="break-words">{line}</li>)}</ul>
    </div>
  );
}

function StepCard({ card, index }: { card: FeedCard; index: number }) {
  const status = STATUS_LABELS[card.status];
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{index}. {card.title}</h3>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="mt-1 text-sm text-fg-muted">{card.statusText}</p>
      <div className="mt-3 space-y-3">
        <Lines title="Inputs" lines={card.inputs} />
        <Lines title="Output" lines={card.output} />
        <Lines title="Reasons" lines={card.reasons} />
        {card.models.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold text-fg-muted">Models</h4>
            <ul className="mt-1 space-y-1 text-sm">
              {card.models.map((model, position) => (
                <li key={`${position}-${model.label}`} className="break-words">
                  {model.label}: {model.provider ?? "provider not recorded"} {model.model ?? "(model id not set yet)"}{" "}
                  <span className="text-xs text-fg-muted">{model.basis === "chosen" ? "chosen for this shot" : model.basis === "route" ? "the route this shot is sent on, not a recorded choice" : "used"}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {card.cost ? (
          <p className="text-sm">
            <span className="font-semibold">Cost:</span> estimate {costLabel(card.cost.estimateUsd)} · reserved {costLabel(card.cost.reservedUsd)} · billed {costLabel(card.cost.billedUsd)}
            {card.cost.unsettled > 0 ? <span className="block text-xs text-fg-muted">{card.cost.unsettled} {card.cost.unsettled === 1 ? "call has" : "calls have"} no bill yet.</span> : null}
            {card.cost.calls === 0 ? <span className="block text-xs text-fg-muted">No paid call is recorded for this step.</span> : null}
          </p>
        ) : card.costNote ? <p className="text-xs text-fg-muted">{card.costNote}</p> : null}
      </div>
    </li>
  );
}

type DeliveredLinkState = Awaited<ReturnType<typeof getDeliveredMasterLink>>;
type DeliveryApprovalState = Awaited<ReturnType<typeof getDeliveryApproval>>;

function whenLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString();
}

function stateSentence(state: ApprovalState): string {
  if (state.status === "not_decided") return "Not decided. Nobody has approved or rejected this video yet.";
  if (state.status === "approved") return `Approved on ${whenLabel(state.decidedAt)} by an admin of this workspace.`;
  return `Rejected on ${whenLabel(state.decidedAt)} by an admin of this workspace: ${state.reason}`;
}

function historyLine(record: ApprovalRecord): string {
  const verb = record.decision === "approved" ? "Approved" : "Rejected";
  const note = record.reason ? `: ${record.reason}` : "";
  return `${verb} on ${whenLabel(record.createdAt)} for the video from request ${record.engineRequestId}${note}`;
}

/**
 * The approval of the delivered video. A decision is written once, against this video, with who made it and when. A revision is a new
 * video and starts undecided. Publishing is not connected, so the panel says so and offers no publish control. Performance is not measured.
 */
function DeliveryApproval({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<DeliveryApprovalState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDeliveryApproval({ data: { sessionId } }).then(
      (value) => {
        if (active) setView(value);
      },
      (error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "The approval could not be read.");
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  async function decide(decision: "approved" | "rejected", note: string) {
    setBusy(true);
    setActionError(null);
    try {
      setView(await decideDeliveryApproval({ data: { sessionId, decision, reason: note } }));
      setRejecting(false);
      setReason("");
      setProblem(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The decision could not be saved. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) return <p role="alert" className="mb-4 text-sm text-danger">{loadError}</p>;
  if (view === null) return <p className="mb-4 text-sm text-fg-muted">Reading the approval of this video.</p>;
  const { state, history, publish, delivered } = view;
  return (
    <section aria-labelledby="cf-approval" className="mb-4 space-y-3 rounded-md border border-border p-3">
      <h3 id="cf-approval" className="text-sm font-semibold">Approval of this video</h3>
      <p className="text-sm">{stateSentence(state)}</p>
      {delivered ? null : <p className="text-sm text-fg-muted">The engine has not delivered the current video, so it cannot be decided yet.</p>}
      {delivered && view.rightsMissing.length > 0 ? (
        <p role="status" className="text-sm text-danger">
          Approval is blocked: no valid rights record covers {view.rightsMissing.join(", ")}. Add one under Content standards for this brand, then approve.
        </p>
      ) : null}
      {delivered && rejecting ? (
        <form
          className="space-y-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const found = approvalProblem({ decision: "rejected", reason });
            setProblem(found);
            if (found === null) void decide("rejected", reason.trim());
          }}
        >
          <Textarea
            label="Why reject this video?"
            hint="The reason stays on record with the decision."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            error={problem ?? undefined}
            rows={3}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>Reject this video</Button>
            <Button type="button" variant="quiet" disabled={busy} onClick={() => { setRejecting(false); setProblem(null); }}>Cancel</Button>
          </div>
        </form>
      ) : null}
      {delivered && !rejecting ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy || state.status === "approved" || view.rightsMissing.length > 0} onClick={() => void decide("approved", "")}>Approve this video</Button>
          <Button variant="quiet" disabled={busy || state.status === "rejected"} onClick={() => { setRejecting(true); setActionError(null); }}>Reject this video</Button>
        </div>
      ) : null}
      {actionError !== null ? <p role="alert" className="text-sm text-danger">{actionError}</p> : null}
      <div className="space-y-1 text-sm">
        <p><span className="font-semibold">Publish:</span> {publish.reason}</p>
        <p><span className="font-semibold">Performance:</span> Not measured. A video is measured only after it is published through a connected channel.</p>
      </div>
      {history.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold">History</h4>
          <ol className="mt-1 space-y-1 text-sm">
            {history.map((record, index) => <li key={`${record.createdAt}:${index}`}>{historyLine(record)}</li>)}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A download link to the engine's delivered master. It is made on request, and only once the engine delivered the request: the engine reads
 * the master back and refuses if the manifest and the video do not match. The link expires; asking again makes a new one.
 */
function DeliveredDownload({ sessionId }: { sessionId: string }) {
  const [link, setLink] = useState<DeliveredLinkState | null>(null);
  const [busy, setBusy] = useState(false);
  async function request() {
    setBusy(true);
    try {
      setLink(await getDeliveredMasterLink({ data: { sessionId } }));
    } catch (error) {
      setLink({ status: "refused", reason: error instanceof Error ? error.message : "The download link could not be made." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="cf-download" className="mb-4 space-y-2 rounded-md border border-border bg-surface-2 p-3">
      <h3 id="cf-download" className="text-sm font-semibold">The engine delivered this video</h3>
      <p className="text-sm text-fg-muted">The file is the engine's delivered master, read back and checked against its manifest before a link is made.</p>
      {link?.status === "ready" ? (
        <p className="text-sm">
          <a className="font-semibold text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent" href={link.url}>
            Download the MP4
          </a>
          <span className="text-fg-muted"> · {(link.durationMs / 1000).toFixed(1)} s · {(link.bytes / 1_000_000).toFixed(1)} MB · the link expires in {Math.round(link.ttlSeconds / 60)} minutes</span>
        </p>
      ) : null}
      {link !== null && link.status !== "ready" ? <p role="status" className="text-sm text-warning">{link.reason}</p> : null}
      <Button variant="secondary" loading={busy} disabled={busy} onClick={() => void request()}>
        {link?.status === "ready" ? "Make a new link" : "Get a download link"}
      </Button>
    </section>
  );
}
