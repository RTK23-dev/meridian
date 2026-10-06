import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { StatusText } from "@/components/status";
import { Button, Field, Notice, Panel, SelectInput, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { attachCreativeImage, getTrace, listLibrary, recordObservation, recordPerformance } from "@/lib/meridian/machine";
import { publishPausedObjects } from "@/lib/meridian/providers/publish-action";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";

export const Route = createFileRoute("/brands/$brandId/library")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Library brandId={brandId} />
    </Authed>
  );
}

function Library({ brandId }: { brandId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof listLibrary>> | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [trace, setTrace] = useState<Awaited<ReturnType<typeof getTrace>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stages, setStages] = useState<{ objectType: string; status: string; externalId: string | null; detail: string }[]>([]);
  const busy = useBusy();

  async function reload() {
    setData(await listLibrary({ data: { brandId } }));
  }

  useEffect(() => {
    let cancelled = false;
    listLibrary({ data: { brandId } })
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
  if (!data) return <p className="text-muted">Loading library…</p>;
  const canEdit = hasRole(data.role, "member");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Library</p>
        <h1 className="font-display text-4xl">Creatives this brand owns</h1>
        <p className="text-muted">Competitor observations stay on Market. You can enter performance here. A worker sync runs only after a healthy connection and a schedule. Publishing stays paused and runs only when you submit the form below.</p>
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      <Panel>
        <h2 className="font-display text-2xl">Paused publishing</h2>
        <p className="mt-2 text-sm text-muted">
          This creates paused objects and stores an id only when the provider returns one. Auto-publish stays off. A missing token, page, location, or uploaded asset stops the chain. Nothing is marked published from this form’s click alone.
        </p>
        {hasRole(data.role, "admin") ? (
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const provider = form.get("provider");
              if (provider !== "meta" && provider !== "tiktok" && provider !== "google") return;
              const split = (name: string) => String(form.get(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
              void busy.run(async () => {
                const result = await publishPausedObjects({
                  data: {
                    brandId,
                    provider,
                    creativeId: String(form.get("creativeId") ?? ""),
                    name: String(form.get("name") ?? ""),
                    dailyBudgetCents: Number(form.get("dailyBudgetCents") ?? 0),
                    countries: split("countries"),
                    locationIds: split("locationIds"),
                    pageId: String(form.get("pageId") ?? ""),
                    link: String(form.get("link") ?? ""),
                    message: String(form.get("message") ?? ""),
                    scheduleStart: String(form.get("scheduleStart") ?? ""),
                    imageIds: split("imageIds"),
                    videoId: String(form.get("videoId") ?? ""),
                    headlines: split("headlines"),
                    descriptions: split("descriptions"),
                    cpcBidCents: Number(form.get("cpcBidCents") ?? 0),
                  },
                });
                setStages(result.stages);
                setNote(`${result.detail} Correlation ${result.correlationId}.`);
              });
            }}
          >
            <Field label="Provider">
              <SelectInput name="provider" defaultValue="meta">
                <option value="meta">Meta</option>
                <option value="tiktok">TikTok</option>
                <option value="google">Google Ads</option>
              </SelectInput>
            </Field>
            <Field label="Creative" hint="Used only to resume this brand’s stored ids. It is not sent as an external id.">
              <SelectInput name="creativeId" required defaultValue={data.creatives[0]?.id ?? ""}>
                {data.creatives.length === 0 ? <option value="">Create a creative first</option> : null}
                {data.creatives.map((item) => (
                  <option key={item.id} value={item.id}>{item.title || item.hook || item.id}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Name">
              <TextInput name="name" required maxLength={120} />
            </Field>
            <Field label="Daily budget (cents)">
              <TextInput name="dailyBudgetCents" type="number" min={1} required defaultValue={1000} />
            </Field>
            <Field label="Link">
              <TextInput name="link" type="url" placeholder="https://" />
            </Field>
            <Field label="Message">
              <TextArea name="message" />
            </Field>
            <Field label="Meta countries" hint="Comma-separated, such as US. Used only for Meta.">
              <TextInput name="countries" />
            </Field>
            <Field label="Meta page id">
              <TextInput name="pageId" />
            </Field>
            <Field label="TikTok location ids" hint="Numeric location ids, not country codes. An ad also needs an uploaded image or video id.">
              <TextInput name="locationIds" />
            </Field>
            <Field label="TikTok schedule start">
              <TextInput name="scheduleStart" placeholder="2026-01-02 00:00:00" />
            </Field>
            <Field label="TikTok image ids">
              <TextInput name="imageIds" />
            </Field>
            <Field label="TikTok video id">
              <TextInput name="videoId" />
            </Field>
            <Field label="Google headlines" hint="Each headline is 30 characters or fewer.">
              <TextInput name="headlines" />
            </Field>
            <Field label="Google descriptions" hint="Each description is 90 characters or fewer.">
              <TextInput name="descriptions" />
            </Field>
            <Field label="Google CPC bid (cents)">
              <TextInput name="cpcBidCents" type="number" min={0} defaultValue={0} />
            </Field>
            <Button type="submit" disabled={busy.pending || data.creatives.length === 0}>Create paused objects</Button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-muted">An admin can send a paused publish.</p>
        )}
        {stages.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {stages.map((stage) => (
              <li key={stage.objectType}>
                <StatusText status={stage.status} label={stage.objectType} description={stage.externalId ? `Confirmed id ${stage.externalId}.` : stage.detail || "No id was stored."} />
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      {data.creatives.length === 0 ? <Panel>No brand creatives yet. Score an opportunity, brief it, and save a script. Or record one you already ran.</Panel> : (
        <ul className="space-y-3">
          {data.creatives.map((item) => (
            <li key={item.id} className="rounded-lg border border-line bg-panel p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-display text-2xl">{item.title || item.hook}</h2>
                <span className="text-xs font-semibold uppercase tracking-widest text-brass">{item.status}</span>
              </div>
              <p className="text-sm text-muted">{item.angle} · {item.origin}</p>
              <p className="mt-2">{item.hook}</p>
              <Button
                className="mt-3"
                variant="quiet"
                onClick={() => {
                  setTraceId(item.id);
                  void busy.run(async () => {
                    setTrace(await getTrace({ data: { brandId, creativeId: item.id } }));
                  });
                }}
              >
                Trace
              </Button>
            </li>
          ))}
        </ul>
      )}
      {trace && traceId ? (
        <Panel>
          <h2 className="font-display text-2xl">Why this exists</h2>
          <p className="mt-2 text-sm text-muted">{trace.creative.status} · {trace.creative.angle}</p>
          {trace.opportunity ? <p className="mt-3">{trace.opportunity.reason}</p> : <p className="mt-3 text-muted">No opportunity is linked. This creative was recorded directly.</p>}
          {trace.brief ? (
            <div className="mt-4 space-y-2 text-sm">
              <h3 className="font-semibold">Brief</h3>
              {trace.brief.why.map((line) => <p key={line}>{line}</p>)}
              {trace.brief.learningNotes.map((line) => <p key={line}>Learned: {line}</p>)}
              {trace.brief.failureNotes.map((line) => <p key={line}>Failure: {line}</p>)}
            </div>
          ) : null}
          <div className="mt-4">
            <h3 className="font-semibold">Decisions</h3>
            {trace.decisions.length === 0 ? <p className="text-sm text-muted">No JEV decision is linked.</p> : (
              <ul className="mt-2 space-y-2 text-sm">
                {trace.decisions.map((item) => (
                  <li key={item.id}>
                    <span className="font-semibold">{item.decision}</span> · {item.question} · p {item.probability.toFixed(2)}
                    <span className="block text-muted">{item.reasons[0]}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-4">
            <h3 className="font-semibold">Performance</h3>
            {trace.observations.length === 0 ? <p className="text-sm text-muted">No performance entered.</p> : (
              <ul className="mt-2 text-sm">
                {trace.observations.map((item) => (
                  <li key={`${item.observedOn}-${item.impressions}`}>
                    {item.observedOn}: {item.impressions} impressions, {item.clicks} clicks, {item.conversions} conversions.
                    {item.ctr === null ? " CTR not computable." : ` CTR ${(item.ctr * 100).toFixed(1)}%.`}
                    {item.cpmCents === null ? "" : ` CPM ${item.cpmCents} cents.`}
                    {" "}Source: {item.source}.
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-sm text-muted">
              {trace.patterns.length === 0 ? "No learned pattern matches this creative yet." : trace.patterns.map((item) => item.summary).join(" ")}
            </p>
          </div>
          {trace.creative.script ? <p className="mt-4 whitespace-pre-wrap text-sm">{trace.creative.script}</p> : null}
          {canEdit ? (
            <form
              className="mt-4 grid gap-3 md:grid-cols-2"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void busy.run(async () => {
                  await recordPerformance({
                    data: {
                      brandId,
                      creativeId: traceId,
                      platform: String(form.get("platform") ?? ""),
                      impressions: Number(form.get("impressions") ?? 0),
                      clicks: Number(form.get("clicks") ?? 0),
                      conversions: Number(form.get("conversions") ?? 0),
                      spendCents: Number(form.get("spendCents") ?? 0),
                      revenueCents: Number(form.get("revenueCents") ?? 0),
                      reach: Number(form.get("reach") ?? 0),
                      observedOn: String(form.get("observedOn") ?? ""),
                    },
                  });
                  setNote("Performance stored and a learning job was queued. Scoring opportunities drains that job. No ad account is connected.");
                  setTrace(await getTrace({ data: { brandId, creativeId: traceId } }));
                  await reload();
                });
              }}
            >
              <Field label="Date"><TextInput name="observedOn" type="date" required /></Field>
              <Field label="Platform"><TextInput name="platform" /></Field>
              <Field label="Reach"><TextInput name="reach" type="number" min={0} defaultValue={0} /></Field>
              <Field label="Impressions"><TextInput name="impressions" type="number" min={0} required defaultValue={0} /></Field>
              <Field label="Clicks"><TextInput name="clicks" type="number" min={0} required defaultValue={0} /></Field>
              <Field label="Conversions"><TextInput name="conversions" type="number" min={0} required defaultValue={0} /></Field>
              <Field label="Spend (cents)"><TextInput name="spendCents" type="number" min={0} required defaultValue={0} /></Field>
              <Field label="Revenue (cents)"><TextInput name="revenueCents" type="number" min={0} required defaultValue={0} /></Field>
              <div className="md:col-span-2 flex flex-wrap gap-2">
                <Button type="submit" disabled={busy.pending}>Record performance</Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const image = await attachCreativeImage({ data: { brandId, creativeId: traceId } });
                      setNote(image.status === "stored" ? image.message : image.message);
                    });
                  }}
                >
                  Generate image
                </Button>
              </div>
            </form>
          ) : null}
        </Panel>
      ) : null}
      {canEdit ? (
        <Panel>
          <h2 className="font-display text-2xl">Record a creative we already ran</h2>
          <p className="mt-2 text-sm text-muted">Use this for history the system did not generate. It can receive performance and feed learning.</p>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void busy.run(async () => {
                await recordObservation({
                  data: {
                    brandId,
                    origin: "own",
                    competitorId: "",
                    angle: String(form.get("angle") ?? ""),
                    observedAngle: String(form.get("observedAngle") ?? ""),
                    hookType: String(form.get("hookType") ?? ""),
                    format: String(form.get("format") ?? ""),
                    title: String(form.get("title") ?? ""),
                    hook: String(form.get("hook") ?? ""),
                    message: String(form.get("message") ?? ""),
                    offer: "",
                    cta: String(form.get("cta") ?? ""),
                    claim: "",
                    platform: "",
                    productName: String(form.get("productName") ?? ""),
                    sourceUrl: "",
                  },
                });
                setNote("Creative recorded.");
                event.currentTarget.reset();
                await reload();
              });
            }}
          >
            <Field label="Angle preset">
              <SelectInput name="angle" defaultValue="curiosity">
                <option value="">Not in the list</option>
                {HYPOTHESES.map((item) => <option key={item.id} value={item.angle}>{item.label}</option>)}
              </SelectInput>
            </Field>
            <Field label="Observed angle, if it is not in the list">
              <TextInput name="observedAngle" placeholder="unboxing" />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Hook type"><TextInput name="hookType" /></Field>
              <Field label="Format"><TextInput name="format" /></Field>
            </div>
            <Field label="Hook"><TextInput name="hook" required /></Field>
            <Field label="Script"><TextArea name="message" required /></Field>
            <Field label="Call to action"><TextInput name="cta" /></Field>
            <Field label="Product"><TextInput name="productName" /></Field>
            <Button type="submit" disabled={busy.pending}>Save to library</Button>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
