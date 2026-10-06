import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, Notice, Panel, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { getCalibration, decideCalibration, proposeCalibration } from "@/lib/meridian/calibration/actions";
import { setPerformanceSchedule } from "@/lib/meridian/performance/actions";
import { getLearning, refreshLearning, setOrganizationLearning, sharePatternWithOrganization } from "@/lib/meridian/machine";
import { StatusText } from "@/components/status";

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
  const [calibration, setCalibration] = useState<Awaited<ReturnType<typeof getCalibration>> | null>(null);
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
    getCalibration({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setCalibration(next);
      })
      .catch(() => {
        if (!cancelled) setCalibration({ proposals: [], versions: [] });
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
        <h2 className="font-display text-2xl">Threshold versions</h2>
        <p className="mt-2 text-sm text-muted">A proposal does not change a gate. An admin has to approve it. The previous version stays in the log.</p>
        {canAdmin ? (
          <Button
            className="mt-3"
            variant="quiet"
            disabled={busy.pending}
            onClick={() => {
              void busy.run(async () => {
                const result = await proposeCalibration({ data: { brandId } });
                setNote("detail" in result && result.detail
                  ? result.detail
                  : result.status === "proposed"
                    ? `Proposal recorded from ${result.samples} reviews. Thresholds were not changed.`
                    : "No proposal was stored.");
                setCalibration(await getCalibration({ data: { brandId } }));
              });
            }}
          >
            Propose from reviewer outcomes
          </Button>
        ) : null}
        {calibration && calibration.versions.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {calibration.versions.map((version) => (
              <li key={version.id}>
                <StatusText status={`version ${version.version}`} description={`${version.questionId} approved by ${version.approvedBy}. ${version.thresholds}`} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No approved threshold version. The code defaults are still in use.</p>
        )}
        {calibration?.proposals.filter((item) => item.status === "proposed").map((proposal) => (
          <div key={proposal.id} className="mt-4 space-y-2">
            <StatusText
              status="proposed"
              description={proposal.samples != null
                ? `${proposal.samples} reviewer outcomes. Disagreement ${proposal.disagreement ?? "not recorded"}. Current ${proposal.current}. Proposed ${proposal.proposedThresholds}.`
                : proposal.proposed}
            />
            {canAdmin ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = await decideCalibration({ data: { brandId, proposalId: proposal.id, decision: "approved" } });
                      setNote(result.status === "approved" ? `Approved threshold version ${result.version}.` : "The proposal was not approved.");
                      setCalibration(await getCalibration({ data: { brandId } }));
                    });
                  }}
                >
                  Approve thresholds
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      await decideCalibration({ data: { brandId, proposalId: proposal.id, decision: "rejected" } });
                      setNote("The proposal was rejected. Thresholds were not changed.");
                      setCalibration(await getCalibration({ data: { brandId } }));
                    });
                  }}
                >
                  Reject proposal
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted">An admin approves or rejects this proposal.</p>
            )}
          </div>
        ))}
      </Panel>
      {canAdmin && data.organizationId ? (
        <Panel>
          <h2 className="font-display text-2xl">Performance schedule</h2>
          <p className="mt-2 text-sm text-muted">This only enqueues a sync after the provider has a successful connection. The worker fetches the metrics. Disconnect stops the schedule.</p>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const provider = form.get("provider");
              if (provider !== "meta" && provider !== "tiktok" && provider !== "google") return;
              void busy.run(async () => {
                const result = await setPerformanceSchedule({
                  data: {
                    organizationId: data.organizationId,
                    brandId,
                    provider,
                    creativeId: String(form.get("creativeId") ?? ""),
                    externalAdId: String(form.get("externalAdId") ?? ""),
                    currency: String(form.get("currency") ?? ""),
                    timezone: String(form.get("timezone") ?? ""),
                    startDate: String(form.get("startDate") ?? ""),
                    endDate: String(form.get("endDate") ?? ""),
                    everySeconds: Number(form.get("everySeconds") ?? 3600),
                  },
                });
                setNote(`${result.reason} Schedule ${result.id}.`);
              });
            }}
          >
            <label className="block text-sm font-semibold">
              Provider
              <select name="provider" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" defaultValue="meta">
                <option value="meta">Meta</option>
                <option value="tiktok">TikTok</option>
                <option value="google">Google Ads</option>
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Cadence in seconds
              <input name="everySeconds" type="number" min={30} defaultValue={3600} required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Creative id
              <input name="creativeId" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              External ad id
              <input name="externalAdId" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Currency
              <input name="currency" required defaultValue="USD" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Timezone
              <input name="timezone" required defaultValue="UTC" className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              Start date
              <input name="startDate" type="date" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <label className="block text-sm font-semibold">
              End date
              <input name="endDate" type="date" required className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-3" />
            </label>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy.pending}>Save performance schedule</Button>
            </div>
          </form>
        </Panel>
      ) : null}
      <Panel>
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
