import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, Notice, Panel, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { getLearning, refreshLearning, setOrganizationLearning, sharePatternWithOrganization } from "@/lib/meridian/machine";

export const Route = createFileRoute("/brands/$brandId/learning")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Learning brandId={brandId} />
    </Authed>
  );
}

function Learning({ brandId }: { brandId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLearning>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = useBusy();

  useEffect(() => {
    let cancelled = false;
    getLearning({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="text-muted">Loading learning…</p>;
  const canEdit = hasRole(data.role, "member");
  const canAdmin = hasRole(data.role, "admin");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-3">
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Learning</p>
          <h1 className="font-display text-4xl">What the results changed</h1>
          <p className="text-muted">{data.policy}</p>
        </div>
        {canEdit ? (
          <Button
            disabled={busy.pending}
            onClick={() => {
              void busy.run(async () => {
                const result = await refreshLearning({ data: { brandId } });
                setNote(result.patterns === 0
                  ? "No pattern met the sample rule. Queued learning jobs for this brand were still closed. Nothing was invented."
                  : `${result.patterns} pattern${result.patterns === 1 ? "" : "s"} stored. Queued learning jobs were drained. Score opportunities again to use them.`);
                setData(await getLearning({ data: { brandId } }));
              });
            }}
          >
            Recompute patterns
          </Button>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      <Panel>
        <h2 className="font-display text-2xl">Whose results count</h2>
        <p className="mt-2 text-sm text-muted">
          This brand's own patterns are always used. Patterns another brand in this workspace explicitly shared are used only if you turn that on. Global patterns are never used.
        </p>
        {canEdit ? (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.useOrganizationLearning}
              onChange={(event) => {
                const enabled = event.target.checked;
                void busy.run(async () => {
                  await setOrganizationLearning({ data: { brandId, enabled } });
                  setData(await getLearning({ data: { brandId } }));
                });
              }}
            />
            Use shared workspace patterns
          </label>
        ) : null}
      </Panel>
      {data.patterns.length === 0 ? (
        <Panel>No learned patterns. Enter performance on at least three creatives that share an attribute, with 300 impressions in that bucket, then recompute. CTR, conversion rate, and ROAS are calculated from those rows. Nothing is filled in for you.</Panel>
      ) : (
        <ul className="space-y-3">
          {data.patterns.map((pattern) => (
            <li key={pattern.id} className="rounded-lg border border-line bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">{pattern.scope} · {pattern.state} · {pattern.metric} · n={pattern.sampleSize}</p>
              <p className="mt-2">{pattern.summary}</p>
              {canAdmin && pattern.scope === "brand" ? (
                <Button
                  className="mt-3"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = await sharePatternWithOrganization({ data: { brandId, patternId: pattern.id } });
                      setNote(result.status === "shared" ? "Shared with this workspace. Other brands still ignore it until they opt in." : "That pattern was already shared.");
                      setData(await getLearning({ data: { brandId } }));
                    });
                  }}
                >
                  Share with workspace
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Panel>
        <h2 className="font-display text-2xl">Rejections</h2>
        {data.rejections.length === 0 ? <p className="mt-2 text-muted">No stored rejections.</p> : (
          <ul className="mt-3 space-y-1 text-sm">
            {data.rejections.map((item) => (
              <li key={item.reasonCode}>{item.reasonCode.replaceAll("_", " ")} · {item.count}</li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Decision log</h2>
        {data.decisions.length === 0 ? <p className="mt-2 text-muted">No decisions yet.</p> : (
          <ul className="mt-3 space-y-3 text-sm">
            {data.decisions.map((item) => (
              <li key={item.id}>
                <span className="font-semibold">{item.decision}</span> · {item.question} · {item.subject} · p {item.probability.toFixed(2)}
                <span className="block text-muted">{item.reasons[0]}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
