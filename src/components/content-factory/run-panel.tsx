import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { PlugZap } from "lucide-react";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, toast } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { reviseContentFactorySession, reviseContentFactoryWithDirection, startContentFactoryRun } from "@/lib/meridian/content-factory/actions";
import { costLabel, type FeedCard } from "@/lib/meridian/content-factory/feed";
import { MAX_MESSAGE_CHARS } from "@/lib/meridian/content-factory/model";
import type { RunView } from "@/lib/meridian/content-factory/service";
import { FlowBoard } from "./run-board";
import { STATUS_LABELS } from "./status";

export function RunPanel({ sessionId, run, lastRefusal, onStarted }: { sessionId: string; run: UseQueryResult<RunView>; lastRefusal: string[]; onStarted: () => void }) {
  if (run.isError && !run.data) return <PlainErrorState error={run.error} onRetry={() => void run.refetch()} />;
  if (!run.data) {
    return (
      <Card aria-busy="true">
        <CardHeader><CardTitle>Decisions</CardTitle></CardHeader>
        <div role="status" aria-label="Loading the run" className="space-y-3"><Skeleton /><Skeleton /><Skeleton variant="card" /></div>
      </Card>
    );
  }
  const view = run.data;
  if (view.stage === "missing") return <ErrorState message={view.reason} onRetry={() => void run.refetch()} />;
  if (view.stage === "draft") return <DraftPanel sessionId={sessionId} view={view} lastRefusal={lastRefusal} onStarted={onStarted} />;
  const feed = view.feed;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisions</CardTitle>
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

function DraftPanel({ sessionId, view, lastRefusal, onStarted }: { sessionId: string; view: Extract<RunView, { stage: "draft" }>; lastRefusal: string[]; onStarted: () => void }) {
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
        <CardDescription>When you ask for the video, the engine analyses the reference, writes the script (unless you sent script lines), plans the shots, picks the models, makes the voice and visuals, edits and renders. Each step appears here with its reason and its cost.</CardDescription>
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
        <Button size="md" loading={busy} disabled={busy || blocked} aria-describedby={blocked ? "cf-start-reason" : undefined} onClick={() => void start()}>Make the video</Button>
        {blocked ? <p id="cf-start-reason" className="text-sm text-fg-muted">{view.problems.length > 0 ? "Complete the items above first." : "Connect the engine first."}</p> : null}
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
