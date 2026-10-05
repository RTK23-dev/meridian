import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, Field, Notice, Panel, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import {
  composeCreative,
  createBriefFromOpportunity,
  dismissOpportunity,
  generateCreative,
  listOpportunities,
  refreshOpportunities,
  type OpportunityView,
} from "@/lib/meridian/machine";

export const Route = createFileRoute("/brands/$brandId/opportunities")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Opportunities brandId={brandId} />
    </Authed>
  );
}

function Opportunities({ brandId }: { brandId: string }) {
  const [rows, setRows] = useState<OpportunityView[] | null>(null);
  const [role, setRole] = useState<"viewer" | "member" | "admin" | "owner">("viewer");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [briefId, setBriefId] = useState<string | null>(null);
  const busy = useBusy();

  async function reload() {
    const next = await listOpportunities({ data: { brandId } });
    setRole(next.role);
    setRows(next.opportunities);
  }

  useEffect(() => {
    let cancelled = false;
    listOpportunities({ data: { brandId } })
      .then((next) => {
        if (cancelled) return;
        setRole(next.role);
        setRows(next.opportunities);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!rows) return <p className="text-muted">Loading opportunities…</p>;
  const canEdit = hasRole(role, "member");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl space-y-3">
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Opportunities</p>
          <h1 className="font-display text-4xl">What to make next</h1>
          <p className="text-muted">
            Each card is ranked from stored evidence. A hypothesis is not a market finding. Refresh replaces open cards. Accepted work is kept.
          </p>
        </div>
        {canEdit ? (
          <Button
            disabled={busy.pending}
            onClick={() => {
              void busy.run(async () => {
                const result = await refreshOpportunities({ data: { brandId } });
                setNote(`${result.count} candidates scored. Priors stay labeled as priors. An angle is added only when stored observations or a learned pattern contain it.`);
                setBriefId(null);
                await reload();
              });
            }}
          >
            {busy.pending ? "Scoring…" : "Score from evidence"}
          </Button>
        ) : null}
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      {rows.length === 0 ? (
        <Panel>Nothing has been scored. Scoring uses the brand brain, stored observations, and learned patterns. It does not invent competitors.</Panel>
      ) : (
        <ul className="space-y-4">
          {rows.map((item) => (
            <li key={item.id} className="rounded-lg border border-line bg-panel p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-brass">
                    {item.category === "discovered" ? "Discovered" : item.category === "hypothesis" ? "Prior" : "Supported"} · {item.decision || item.status}
                  </p>
                  <h2 className="font-display text-2xl">{item.label}</h2>
                </div>
                <p className="text-sm text-muted">
                  Rank {item.expectedValue.toFixed(2)}
                  {item.decision ? ` · JEV ${item.decision} ${item.probability.toFixed(2)}` : ""}
                  {" "}· evidence confidence {item.confidence.toFixed(2)}
                </p>
              </div>
              <p className="mt-3">{item.reason}</p>
              {item.decision === "HUMAN_REVIEW" && item.status === "open" ? (
                <p className="mt-2 text-sm text-muted">This is on hold. Clear it under Reviews before a brief can be built.</p>
              ) : null}
              {openId === item.id ? (
                <div className="mt-4 space-y-4">
                  <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                    <Metric label="Brand fit" value={item.brandFit} />
                    <Metric label="History" value={item.historicalEvidence} />
                    <Metric label="Market" value={item.marketSignal} />
                    <Metric label="Novelty" value={item.novelty} />
                    <Metric label="Reproducible" value={item.reproducibility} />
                    <Metric label="Saturation" value={item.saturation} />
                    <Metric label="Risk" value={item.risk} />
                    <Metric label="Basis" value={item.evidenceBasis} />
                  </dl>
                  <div>
                    <h3 className="font-semibold">Why</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                      {item.evidence.map((entry) => (
                        <li key={entry.id}>{entry.summary}</li>
                      ))}
                    </ul>
                  </div>
                  {briefId && openId === item.id ? (
                    <Compose
                      brandId={brandId}
                      briefId={briefId}
                      pending={busy.pending}
                      onRun={busy.run}
                      onDone={(message) => setNote(message)}
                    />
                  ) : null}
                  {canEdit && item.status !== "rejected" && item.status !== "dismissed" ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busy.pending}
                        onClick={() => {
                          void busy.run(async () => {
                            const brief = await createBriefFromOpportunity({ data: { brandId, opportunityId: item.id } });
                            if (brief.decision === "REJECT") {
                              setBriefId(null);
                              setNote("The brief gate rejected this. Fill the missing brand or product fields and score again.");
                            } else {
                              setBriefId(brief.id);
                              setNote("Brief stored. Write the script below, or generate one if a model is configured.");
                            }
                            await reload();
                          });
                        }}
                      >
                        Build brief
                      </Button>
                      <Button variant="quiet" disabled={busy.pending} onClick={() => void busy.run(async () => {
                        await dismissOpportunity({ data: { brandId, opportunityId: item.id } });
                        await reload();
                      })}>
                        Dismiss
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <Button className="mt-4" variant="quiet" onClick={() => { setOpenId(item.id); setBriefId(null); }}>
                  Why this
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{typeof value === "number" ? value.toFixed(2) : value}</dd>
    </div>
  );
}

function Compose({
  brandId,
  briefId,
  pending,
  onRun,
  onDone,
}: {
  brandId: string;
  briefId: string;
  pending: boolean;
  onRun: (task: () => Promise<void>) => Promise<void>;
  onDone: (message: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onRun(async () => {
      const result = await composeCreative({
        data: {
          brandId,
          briefId,
          hook: String(form.get("hook") ?? ""),
          script: String(form.get("script") ?? ""),
          offer: String(form.get("offer") ?? ""),
          cta: String(form.get("cta") ?? ""),
          visualTreatment: String(form.get("visualTreatment") ?? ""),
        },
      });
      onDone(`Creative ${result.decision.replaceAll("_", " ").toLowerCase()}. ${result.reasons[0] ?? ""}`);
    });
  }
  return (
    <form onSubmit={submit} className="grid gap-3 border-t border-line pt-4">
      <h3 className="font-display text-xl">Produce from this brief</h3>
      <Field label="Hook"><TextInput name="hook" required /></Field>
      <Field label="Script"><TextArea name="script" required /></Field>
      <Field label="Offer"><TextInput name="offer" /></Field>
      <Field label="Call to action"><TextInput name="cta" required /></Field>
      <Field label="Visual treatment"><TextInput name="visualTreatment" /></Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>Check and save</Button>
        <Button
          type="button"
          variant="quiet"
          disabled={pending}
          onClick={() => {
            void onRun(async () => {
              const result = await generateCreative({ data: { brandId, briefId } });
              if (result.status !== "completed") {
                onDone(result.message);
                return;
              }
              onDone(`Generated creative ${result.decision.replaceAll("_", " ").toLowerCase()}. ${result.reasons[0] ?? ""}`);
            });
          }}
        >
          Generate script
        </Button>
      </div>
    </form>
  );
}
