import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, toast } from "@/components/ui";
import { getContentFactoryShotTake, quoteContentFactoryShotRemake, remakeContentFactoryShot } from "@/lib/meridian/content-factory/actions";
import { costLabel, type BoardShot, type CardStatus, type FeedCard, type RunFeed } from "@/lib/meridian/content-factory/feed";
import { REMAKE_DIRECTION_MAX_CHARS } from "@/lib/meridian/content-factory/model";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { STATUS_LABELS } from "./status";
import { quoteAllowsRemake, quoteSentence, type QuoteState } from "./shot-presentation";

/** A take's link lasts 15 minutes (ENGINE_MEDIA_LINK_TTL_SECONDS). The board reads it again after 10, so a link on screen is never one that has expired. */
const SHOT_LINK_STALE_MS = 10 * 60 * 1000;

/** The colour of a step's node. Running steps pulse (motion-safe, so reduced motion stops it). */
const NODE_DOT: Record<CardStatus, string> = {
  not_started: "bg-border-strong",
  waiting: "bg-info-soft ring-2 ring-info",
  running: "bg-info motion-safe:animate-pulse",
  done: "bg-success",
  failed: "bg-danger",
  needs_review: "bg-warning",
  paused: "bg-warning",
};

const SHOT_DOT: Record<BoardShot["status"], string> = {
  pending: "bg-info motion-safe:animate-pulse",
  replanning: "bg-info motion-safe:animate-pulse",
  accepted: "bg-success",
  escalated: "bg-warning",
};

/**
 * The run drawn as a flow, the way a workflow editor draws one: each engine step is a node and a line runs from each node to the next. The
 * shots of the visuals step are nodes of their own. A line that leads into a step that is running or queued moves. Selecting a shot opens
 * its panel, where a reviewer can ask for that one shot to be made again while the rest of the video is kept (Bible 5.5).
 */
export function FlowBoard({ sessionId, feed, onChanged }: { sessionId: string; feed: RunFeed; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const shot = feed.board.shots.find((item) => item.shotId === selected) ?? null;
  return (
    <section aria-labelledby="cf-board" className="mb-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 id="cf-board" className="text-sm font-semibold">The video, step by step</h3>
        {feed.board.revision > 0 ? <Badge variant="info">Revision {feed.board.revision}</Badge> : null}
      </div>
      <ol aria-label="Video steps">
        {feed.cards.map((card, index) => (
          <Fragment key={card.id}>
            {index > 0 ? <li aria-hidden="true" className="flex h-6 pl-[0.55rem]"><span className={connectorClass(card.status)} /></li> : null}
            <li className="flex gap-3">
              <div className="flex w-5 shrink-0 flex-col items-center pt-4">
                <span className={`size-3 rounded-full ${NODE_DOT[card.status]}`} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface p-3">
                <StepHeader card={card} index={index + 1} />
                {card.id === "visuals" ? <Shots shots={feed.board.shots} selected={selected} onSelect={setSelected} /> : null}
              </div>
            </li>
          </Fragment>
        ))}
      </ol>
      {shot ? <ShotPanel key={shot.shotId} sessionId={sessionId} shot={shot} onChanged={onChanged} /> : null}
    </section>
  );
}

/** The line into a node. It moves while the node it leads into is running or queued. */
function connectorClass(next: CardStatus): string {
  const moving = next === "running" || next === "waiting";
  return `ml-[0.55rem] w-0.5 rounded-full ${moving ? "cf-flow" : "bg-border"}`;
}

function StepHeader({ card, index }: { card: FeedCard; index: number }) {
  const status = STATUS_LABELS[card.status];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">{index}. {card.title}</h4>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="mt-1 text-sm text-fg-muted">{card.statusText}</p>
      {card.cost && card.cost.calls > 0 ? (
        <p className="mt-1 text-xs text-fg-muted">Cost: estimate {costLabel(card.cost.estimateUsd)} · billed {costLabel(card.cost.billedUsd)}</p>
      ) : null}
    </div>
  );
}

function Shots({ shots, selected, onSelect }: { shots: BoardShot[]; selected: string | null; onSelect: (shotId: string | null) => void }) {
  if (shots.length === 0) return <p className="mt-3 text-sm text-fg-muted">The shots appear once the plan is made.</p>;
  return (
    <ul aria-label="Shots" className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {shots.map((shot) => {
        const active = selected === shot.shotId;
        return (
          <li key={shot.shotId}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : shot.shotId)}
              className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-surface-2 ${active ? "border-accent bg-accent-soft" : "border-border"}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{shot.label}</span>
                <span className={`size-2.5 shrink-0 rounded-full ${SHOT_DOT[shot.status]}`} aria-hidden="true" />
              </span>
              <span className="mt-0.5 block text-xs text-fg-muted">
                {shot.visualLabel ?? "Visual not recorded"}
                {shot.span ? ` · ${shot.span}` : ""}
              </span>
              <span className="mt-2 block text-sm">{shot.statusText}</span>
              {shot.remakes > 0 ? <span className="mt-1 block text-xs text-fg-muted">Remade {shot.remakes} {shot.remakes === 1 ? "time" : "times"}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The engine's rule names read as words: "slop.hands" is "slop hands". */
function ruleName(rule: string): string {
  return rule.replace(/[._]/g, " ");
}

function ShotPanel({ sessionId, shot, onChanged }: { sessionId: string; shot: BoardShot; onChanged: () => void }) {
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const blocked = shot.remakeRefusal !== null;
  const { user } = useCurrentUserState();
  const userId = user?.id ?? null;
  const take = useQuery({
    queryKey: userScopedQueryKey(userId, ["content-factory-shot-take", sessionId, shot.shotId]),
    queryFn: () => getContentFactoryShotTake({ data: { sessionId, shotId: shot.shotId } }),
    enabled: !!userId && shot.takes > 0,
    staleTime: SHOT_LINK_STALE_MS,
  });
  const quote = useQuery({
    queryKey: userScopedQueryKey(userId, ["content-factory-shot-quote", sessionId, shot.shotId, shot.remakes]),
    queryFn: () => quoteContentFactoryShotRemake({ data: { sessionId, shotId: shot.shotId } }),
    enabled: !!userId && !blocked,
  });
  const quoteState: QuoteState = quote.data ? { state: "ready", quote: quote.data } : quote.isError ? { state: "unavailable" } : { state: "loading" };
  const remake = async () => {
    setBusy(true);
    setReasons([]);
    try {
      const outcome = await remakeContentFactoryShot({ data: { sessionId, shotId: shot.shotId, directive: direction.trim() === "" ? null : direction } });
      if (outcome.status === "queued") {
        toast.success(`${shot.label} is being made again. The video is on revision ${outcome.revision}.`);
        setDirection("");
      } else {
        setReasons(outcome.reasons);
      }
    } catch (error) {
      setReasons([error instanceof Error ? error.message : "The shot was not remade."]);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <section aria-labelledby="cf-shot-title" className="mt-4 rounded-xl border border-border bg-surface-2 p-4">
      <h3 id="cf-shot-title" className="font-semibold">
        {shot.label}
        {shot.visualLabel ? ` · ${shot.visualLabel}` : ""}
      </h3>
      <p className="mt-1 text-sm text-fg-muted">
        {shot.span ? `${shot.span}. ` : ""}
        {shot.statusText}. {shot.takes} {shot.takes === 1 ? "take" : "takes"} checked.
      </p>
      {shot.lastVerdict ? (
        <p className="mt-2 text-sm">
          {shot.lastVerdict.pass
            ? "The last check passed."
            : `The last check failed on ${shot.lastVerdict.failing.length > 0 ? shot.lastVerdict.failing.map(ruleName).join(", ") : "a check the engine did not name"}.`}
        </p>
      ) : null}
      {shot.takes > 0 ? (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">The take</h4>
          {take.data?.status === "ready" ? (
            <video
              src={take.data.url}
              controls
              preload="metadata"
              playsInline
              aria-label={`The take of ${shot.label}`}
              onError={() => void take.refetch()}
              className="mt-2 max-h-80 w-full rounded-md bg-black"
            />
          ) : take.data ? (
            <p className="mt-1 text-sm text-fg-muted">{take.data.reason}</p>
          ) : take.isError ? (
            <p className="mt-1 text-sm text-fg-muted">The take could not be loaded.</p>
          ) : (
            <p className="mt-1 text-sm text-fg-muted">Loading the take.</p>
          )}
        </div>
      ) : null}
      {shot.directives.length > 0 ? (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Earlier directions</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {shot.directives.map((text, position) => <li key={`${position}-${text}`} className="break-words">{text}</li>)}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 space-y-2">
        <label htmlFor="cf-direction" className="block text-sm font-semibold">Direction for this shot</label>
        <textarea
          id="cf-direction"
          rows={3}
          maxLength={REMAKE_DIRECTION_MAX_CHARS}
          value={direction}
          disabled={blocked || busy}
          onChange={(event) => setDirection(event.target.value)}
          aria-describedby="cf-direction-help"
          placeholder="For example: the product in her hand, close to the lens"
          className="w-full rounded-md border border-border bg-surface p-2 text-sm disabled:opacity-60"
        />
        <p id="cf-direction-help" className="text-xs text-fg-muted">
          Say what to change. The rest of the video is kept: its voice, its captions, its other shots and its plan. {direction.length} of {REMAKE_DIRECTION_MAX_CHARS} characters.
        </p>
      </div>
      {!blocked && quoteState.state === "ready" ? (
        <p id="cf-remake-quote" className="mt-4 text-sm">{quoteSentence(quoteState.quote)}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="md"
          loading={busy}
          disabled={busy || blocked || !quoteAllowsRemake(quoteState)}
          aria-describedby={blocked ? "cf-remake-reason" : !blocked && quoteState.state === "ready" ? "cf-remake-quote" : undefined}
          onClick={() => void remake()}
        >
          Remake this shot
        </Button>
        {blocked ? <p id="cf-remake-reason" className="text-sm text-fg-muted">{shot.remakeRefusal}</p> : null}
      </div>
      {reasons.length > 0 ? (
        <div role="status" className="mt-3 space-y-1 text-sm">
          <p className="font-semibold">The shot was not remade:</p>
          <ul className="list-disc space-y-1 pl-5">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}
