import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { StatusText } from "@/components/status";
import { Button, ErrorState, Field, Notice, Panel, SelectInput, Skeleton, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { attachCreativeImage, recordObservation, recordPerformance } from "@/lib/meridian/machine";
import { parseCount } from "@/lib/meridian/scoring";
import { publishPausedObjects } from "@/lib/meridian/providers/publish-action";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";
import { useLibraryQuery, useTraceQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/brands/$brandId/library")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Library brandId={brandId} />
  );
}

function Library({ brandId }: { brandId: string }) {
  const query = useLibraryQuery(brandId);
  const data = query.data ?? null;
  const [traceId, setTraceId] = useState<string | null>(null);
  const [creativeSearch, setCreativeSearch] = useState("");
  const [creativeStatus, setCreativeStatus] = useState("all");
  const [creativeOrigin, setCreativeOrigin] = useState("all");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const traceQuery = useTraceQuery(brandId, traceId);
  const trace = traceQuery.data ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [stages, setStages] = useState<{ objectType: string; status: string; externalId: string | null; detail: string }[]>([]);
  const busy = useBusy([qk.library(brandId), qk.trace(brandId), qk.learning(brandId)]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!data) return <div role="status" aria-label="Loading library" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(data.role, "member");
  const visibleCreatives = data.creatives.filter((item) => {
    const queryText = `${item.title} ${item.hook} ${item.angle}`.toLowerCase();
    if (creativeSearch.trim() && !queryText.includes(creativeSearch.trim().toLowerCase())) return false;
    if (creativeStatus !== "all" && item.status !== creativeStatus) return false;
    if (creativeOrigin !== "all" && item.origin !== creativeOrigin) return false;
    const created = Date.parse(item.createdAt);
    if (createdAfter && created < Date.parse(`${createdAfter}T00:00:00`)) return false;
    if (createdBefore && created > Date.parse(`${createdBefore}T23:59:59.999`)) return false;
    return true;
  });

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
                    dailyBudgetCents: parseCount(form.get("dailyBudgetCents"), "Daily budget"),
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
                    cpcBidCents: parseCount(form.get("cpcBidCents"), "CPC bid", true),
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
              <TextInput name="dailyBudgetCents" type="text" inputMode="decimal" min={1} required defaultValue={1000} />
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
              <TextInput name="cpcBidCents" type="text" inputMode="decimal" min={0} defaultValue={0} />
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
        <section aria-labelledby="library-creatives-title" className="space-y-4">
        <div><h2 id="library-creatives-title" className="font-display text-2xl">Creative library</h2><p className="text-sm text-muted">Search and filter the 50 most recent stored creatives. Media preview appears when its stored asset can be served.</p></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Search"><TextInput value={creativeSearch} onChange={(event) => setCreativeSearch(event.currentTarget.value)} placeholder="Title, hook, angle" /></Field>
          <Field label="Status"><SelectInput value={creativeStatus} onChange={(event) => setCreativeStatus(event.currentTarget.value)}><option value="all">All statuses</option>{[...new Set(data.creatives.map((item) => item.status))].map((status) => <option key={status} value={status}>{status}</option>)}</SelectInput></Field>
          <Field label="Origin"><SelectInput value={creativeOrigin} onChange={(event) => setCreativeOrigin(event.currentTarget.value)}><option value="all">All origins</option>{[...new Set(data.creatives.map((item) => item.origin))].map((origin) => <option key={origin} value={origin}>{origin}</option>)}</SelectInput></Field>
          <Field label="Created after"><TextInput type="date" value={createdAfter} onChange={(event) => setCreatedAfter(event.currentTarget.value)} /></Field>
          <Field label="Created before"><TextInput type="date" value={createdBefore} onChange={(event) => setCreatedBefore(event.currentTarget.value)} /></Field>
        </div>
        <p className="text-sm text-muted">Showing {visibleCreatives.length} of {data.creatives.length} creatives.</p>
        {visibleCreatives.length ? <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleCreatives.map((item) => (
            <li key={item.id} className="rounded-lg border border-line bg-panel p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="font-display text-xl">{item.title || item.hook}</h3>
                <span className="text-xs font-semibold uppercase tracking-widest text-brass">{item.status}</span>
              </div>
              <p className="text-sm text-muted">{item.angle} · {item.origin} · {new Date(item.createdAt).toLocaleDateString()}</p>
              <p className="mt-2 line-clamp-3">{item.hook}</p>
              <Button
                className="mt-3"
                variant="quiet"
                onClick={() => {
                  setTraceId(item.id);
                }}
              >
                Trace
              </Button>
            </li>
          ))}
        </ul> : <Panel>No creatives match these filters.</Panel>}
        </section>
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
                      impressions: parseCount(form.get("impressions"), "Impressions"),
                      clicks: parseCount(form.get("clicks"), "Clicks"),
                      conversions: parseCount(form.get("conversions"), "Conversions"),
                      spendCents: parseCount(form.get("spendCents"), "Spend"),
                      revenueCents: parseCount(form.get("revenueCents"), "Revenue"),
                      reach: parseCount(form.get("reach"), "Reach", true),
                      observedOn: String(form.get("observedOn") ?? ""),
                    },
                  });
                  setNote("Performance stored and a learning job was queued. Scoring opportunities drains that job. No ad account is connected.");
                });
              }}
            >
              <Field label="Date"><TextInput name="observedOn" type="date" required /></Field>
              <Field label="Platform"><TextInput name="platform" /></Field>
              <Field label="Reach"><TextInput name="reach" type="text" inputMode="decimal" min={0} defaultValue={0} /></Field>
              <Field label="Impressions"><TextInput name="impressions" type="text" inputMode="decimal" min={0} required defaultValue={0} /></Field>
              <Field label="Clicks"><TextInput name="clicks" type="text" inputMode="decimal" min={0} required defaultValue={0} /></Field>
              <Field label="Conversions"><TextInput name="conversions" type="text" inputMode="decimal" min={0} required defaultValue={0} /></Field>
              <Field label="Spend (cents)"><TextInput name="spendCents" type="text" inputMode="decimal" min={0} required defaultValue={0} /></Field>
              <Field label="Revenue (cents)"><TextInput name="revenueCents" type="text" inputMode="decimal" min={0} required defaultValue={0} /></Field>
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
      {traceId && traceQuery.error ? <ErrorState message={errorText(traceQuery.error)} onRetry={() => void traceQuery.refetch()} /> : null}
      {canEdit ? (
        <Panel>
          <h2 className="font-display text-2xl">Record a creative we already ran</h2>
          <p className="mt-2 text-sm text-muted">Use this for history the system did not generate. It can receive performance and feed learning.</p>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void busy.run(async () => {
                await recordObservation({
                  data: {
                    brandId,
                    origin: "own",
                    competitorId: "",
                    angle: String(data.get("angle") ?? ""),
                    observedAngle: String(data.get("observedAngle") ?? ""),
                    hookType: String(data.get("hookType") ?? ""),
                    format: String(data.get("format") ?? ""),
                    title: String(data.get("title") ?? ""),
                    hook: String(data.get("hook") ?? ""),
                    message: String(data.get("message") ?? ""),
                    offer: "",
                    cta: String(data.get("cta") ?? ""),
                    claim: "",
                    platform: "",
                    productName: String(data.get("productName") ?? ""),
                    sourceUrl: "",
                  },
                });
                setNote("Creative recorded.");
                form.reset();
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
