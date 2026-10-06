import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed } from "@/components/gate";
import { Notice, Panel, errorText } from "@/components/ui";
import { getStudioBoard } from "@/lib/meridian/studio/board";

export const Route = createFileRoute("/brands/$brandId/studio")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Studio brandId={brandId} />
    </Authed>
  );
}

function Studio({ brandId }: { brandId: string }) {
  const [board, setBoard] = useState<Awaited<ReturnType<typeof getStudioBoard>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStudioBoard({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setBoard(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!board) return <p className="text-muted">Loading studio…</p>;
  const top = board.discovered[0];

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Studio</p>
        <h1 className="font-display text-4xl">What to make from the evidence</h1>
        <p className="text-muted">
          {board.observationCount} stored creatives. A direction is a finding only when observations leave a gap this brand has not used. Exploration seeds are not findings. No image or video is shown until a provider stores one.
        </p>
      </div>
      {top ? (
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Discovered · {top.angle}</p>
          <h2 className="mt-2 font-display text-3xl">{top.label}</h2>
          <p className="mt-3">{top.reason}</p>
          <p className="mt-2 text-sm text-muted">Score {top.score.toFixed(2)}. Posterior draw {top.draw.toFixed(2)}. Shrunk lift {top.shrunkLift.toFixed(2)}.</p>
          <Link className="mt-4 inline-flex min-h-11 items-center rounded-md bg-brass px-4 font-semibold text-paper" to="/brands/$brandId/opportunities" params={{ brandId }}>
            Create variants
          </Link>
        </Panel>
      ) : (
        <Panel>
          <h2 className="font-display text-2xl">No discovered opportunity</h2>
          <p className="mt-2 text-sm text-muted">
            {board.observationCount === 0
              ? "Add competitor ads you have seen. An empty library is not whitespace."
              : "Stored creatives do not yet show an underused direction that matches this brand. Nothing was invented to fill the gap."}
          </p>
          <Link className="mt-3 inline-flex min-h-11 items-center font-semibold" to="/brands/$brandId/market" params={{ brandId }}>Add an observation</Link>
        </Panel>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <h2 className="font-display text-2xl">Whitespace</h2>
          {board.whitespace.length === 0 ? <p className="mt-2 text-sm text-muted">No whitespace claim. That requires competitor observations and a direction this brand has not used.</p> : (
            <ul className="mt-3 space-y-3 text-sm">
              {board.whitespace.map((finding) => (
                <li key={finding.id}>
                  <p className="font-semibold">{finding.underused}</p>
                  <p>{finding.whyTest}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <h2 className="font-display text-2xl">What learning changed</h2>
          {board.winning.length === 0 && board.losing.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No pattern has met the sample rule, so the next brief is not being pulled by a result.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {board.winning.map((line) => <li key={line}>Winning: {line}</li>)}
              {board.losing.map((line) => <li key={line}>Avoid: {line}</li>)}
            </ul>
          )}
          {board.exploration ? <p className="mt-3 text-sm text-muted">Exploration held back: {board.exploration.label}.</p> : null}
          <Link className="mt-3 inline-flex min-h-11 items-center font-semibold" to="/brands/$brandId/learning" params={{ brandId }}>Open learning</Link>
        </Panel>
      </div>
    </div>
  );
}
