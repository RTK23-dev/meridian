import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import { Button, ErrorState, Field, Notice, Panel, SelectInput, Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import {
  addCompetitor,
  fetchSourcePage,
  proposeCompetitors,
  recordObservation,
  resolveSuggestion,
  reviewCompetitor,
  suggestFromDocument,
  startResearchCollection,
} from "@/lib/meridian/machine";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";
import { useMarketQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";

export const Route = createFileRoute("/brands/$brandId/market")({ component: Page });

type AnalysisFieldView = { value?: string; confidence?: number; evidence?: string[] };
type AnalysisView = {
  topic?: AnalysisFieldView;
  openingMove?: AnalysisFieldView;
  hookMechanism?: AnalysisFieldView;
  hook?: AnalysisFieldView;
  structure?: AnalysisFieldView;
  evidenceOffered?: AnalysisFieldView;
  emotionalAppeal?: AnalysisFieldView;
  adviceSpecificity?: AnalysisFieldView;
  cta?: AnalysisFieldView;
  segments?: { id?: string; text?: string; startMs?: number | null; endMs?: number | null; role?: string; confidence?: number }[];
  claims?: { text?: string; type?: string; evidence?: string[] }[];
};

function parseAnalysis(value: string): AnalysisView | null {
  try { return JSON.parse(value) as AnalysisView; } catch { return null; }
}

function researchAdState(ad: { analysisStatus: string; reviewRequired: boolean; transcriptStatus: string; mediaStatus: string }) {
  if (ad.analysisStatus === "review" || (ad.analysisStatus === "analyzed" && ad.reviewRequired)) return "needs review";
  if (ad.analysisStatus === "analyzed") return "analyzed";
  if (ad.transcriptStatus === "completed") return "transcribed";
  if (ad.mediaStatus === "stored") return "media stored";
  return "collected";
}

function Page() {
  const { brandId } = Route.useParams();
  return (
    <MarketPage brandId={brandId} />
  );
}

function MarketPage({ brandId }: { brandId: string }) {
  const query = useMarketQuery(brandId);
  const market = query.data ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [researchText, setResearchText] = useState("");
  const [researchField, setResearchField] = useState("all");
  const [minimumConfidence, setMinimumConfidence] = useState("0");
  const [captureAfter, setCaptureAfter] = useState("");
  const [captureBefore, setCaptureBefore] = useState("");
  const [minimumDuration, setMinimumDuration] = useState("");
  const [maximumDuration, setMaximumDuration] = useState("");
  const [researchView, setResearchView] = useState<"gallery" | "table">("gallery");
  const [researchState, setResearchState] = useState("all");
  const [advertiserFilter, setAdvertiserFilter] = useState("");
  const [selectedAdId, setSelectedAdId] = useState<string | null>(null);
  const busy = useBusy([qk.market(brandId), qk.intelligence(brandId), qk.opportunities(brandId), qk.studio(brandId)]);

  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!market) return <div role="status" aria-label="Loading market" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const canEdit = hasRole(market.role, "member");
  const visibleResearch = market.researchAds.filter((ad) => {
    const analysis = parseAnalysis(ad.analysis);
    const query = researchText.trim().toLowerCase();
    const values: Record<string, string> = {
      topic: analysis?.topic?.value ?? "",
      openingMove: analysis?.openingMove?.value ?? "",
      hookMechanism: analysis?.hookMechanism?.value ?? "",
      hook: analysis?.hook?.value ?? "",
      structure: analysis?.structure?.value ?? "",
      cta: analysis?.cta?.value ?? "",
      segmentRole: analysis?.segments?.map((segment) => segment.role ?? "").join(" ") ?? "",
    };
    const corpus = `${ad.advertiser} ${ad.copy} ${ad.headline} ${ad.transcript} ${JSON.stringify(analysis ?? {})}`.toLowerCase();
    if (query && !corpus.includes(query)) return false;
    if (advertiserFilter.trim() && !ad.advertiser.toLowerCase().includes(advertiserFilter.trim().toLowerCase())) return false;
    const state = researchAdState(ad);
    if (researchState !== "all" && state !== researchState) return false;
    if (researchField !== "all" && !(values[researchField] ?? "").trim()) return false;
    const captureTime = Date.parse(ad.capturedAt);
    if (captureAfter && captureTime < Date.parse(`${captureAfter}T00:00:00`)) return false;
    if (captureBefore && captureTime > Date.parse(`${captureBefore}T23:59:59.999`)) return false;
    if (minimumDuration && (!ad.durationMs || ad.durationMs < Number(minimumDuration) * 1000)) return false;
    if (maximumDuration && (!ad.durationMs || ad.durationMs > Number(maximumDuration) * 1000)) return false;
    return !analysis || ad.confidence >= Number(minimumConfidence);
  });
  const selectedAd = market.researchAds.find((ad) => ad.id === selectedAdId) ?? null;
  const selectedAnalysis = selectedAd ? parseAnalysis(selectedAd.analysis) : null;

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Market</p>
        <h1 className="font-display text-4xl">What has actually been seen</h1>
        <p className="text-muted">
          Collect bounded public Meta video-ad records, preserve source and transcript evidence, and let JEV Research identify recurring structures. Missing media stays unavailable; no observations or outcomes are invented.
        </p>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {market.adapters.map((adapter) => (
          <li key={adapter.id} className="rounded-lg border border-line bg-panel p-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-brass">{adapter.status}</p>
            <h2 className="mt-2 font-display text-xl">{adapter.label}</h2>
            <p className="mt-2 text-sm text-muted">{adapter.note}</p>
            {adapter.connectionError ? <p className="mt-2 text-xs text-muted">{adapter.connectionError}</p> : null}
          </li>
        ))}
      </ul>
      {note ? <Notice>{note}</Notice> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      <Panel>
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">JEV Research</p>
          <h2 className="mt-2 font-display text-2xl">Collect external video-ad evidence</h2>
          <p className="mt-2 text-sm text-muted">Meta Ad Library collection is capped at 100 ads and 100 MB of stored source video per run. Each video is capped at 24 MB. Media, transcript and analysis each retain their own status. Ads without a public downloadable video are not analyzed.</p>
        </div>
        {canEdit ? (
          <form className="mt-4 grid gap-3 md:grid-cols-4" onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void busy.run(async () => {
              const result = await startResearchCollection({ data: {
                brandId, searchTerms: String(form.get("research-terms") ?? ""), country: String(form.get("research-country") ?? "US"), limit: Number(form.get("research-limit") ?? 50),
              } });
              setNote(result.status === "NOT_CONNECTED" ? result.error : `Research collection ${result.reused ? "already queued" : "queued"}. Refresh this page to see worker progress.`);
            });
          }}>
            <Field label="Search ads"><TextInput name="research-terms" required maxLength={100} placeholder="Brand, product, or category" /></Field>
            <Field label="Country"><TextInput name="research-country" defaultValue="US" required maxLength={2} /></Field>
            <Field label="Maximum ads"><SelectInput name="research-limit" defaultValue="50"><option value="25">25</option><option value="50">50</option><option value="100">100</option></SelectInput></Field>
            <div className="flex items-end"><Button type="submit" disabled={busy.pending}>Start collection</Button></div>
          </form>
        ) : null}
        <div className="mt-5">
          <h3 className="font-semibold">Collection runs</h3>
          {market.researchRuns.length ? <ul className="mt-2 space-y-1 text-sm">{market.researchRuns.map((run) => <li key={run.id}>{run.searchTerms} · {run.country} · {run.status} · {run.collectedCount} collected / {run.analyzedCount} analyzed{run.error ? ` · ${run.error}` : ""}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No external research collected for this brand yet.</p>}
        </div>
        <div className="mt-6">
          <h3 className="font-display text-xl">Recurring patterns</h3>
          <p className="mt-1 text-sm text-muted">Counts describe the collected corpus, not ad effectiveness or causation.</p>
          {market.researchPatterns.length ? <ul className="mt-3 grid gap-2 md:grid-cols-2">{market.researchPatterns.filter((pattern) => pattern.dimension === "creative_pattern").map((pattern) => <li key={`${pattern.scope}:${pattern.dimension}:${pattern.value}`} className="rounded border border-line p-3"><p className="text-xs font-semibold uppercase tracking-widest text-brass">{pattern.scope === "organization" ? "Organization summary" : "Brand"} · {pattern.state} · {pattern.sampleCount}/{pattern.corpusSize} ads · confidence {pattern.confidence.toFixed(2)}</p><p className="mt-2 break-words text-sm">{pattern.value}</p><p className="mt-1 text-xs text-muted">{pattern.summary}</p>{pattern.scope !== "organization" ? <p className="mt-1 break-all text-xs text-muted">Source creative ids: {pattern.exampleCreativeIds.join(", ") || "none"} · Analysis ids: {pattern.analysisIds.join(", ") || "none"}</p> : null}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No repeated, confidence-rated ad patterns are stored.</p>}
        </div>
      </Panel>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-display text-2xl">Analyzed ads</h2><p className="text-sm text-muted">Showing saved source, media, transcript, and analysis states.</p></div><div className="flex gap-2" aria-label="Research display mode"><Button type="button" variant={researchView === "gallery" ? "primary" : "secondary"} aria-pressed={researchView === "gallery"} onClick={() => setResearchView("gallery")}>Gallery</Button><Button type="button" variant={researchView === "table" ? "primary" : "secondary"} aria-pressed={researchView === "table"} onClick={() => setResearchView("table")}>Table</Button></div></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search"><TextInput value={researchText} onChange={(event) => setResearchText(event.currentTarget.value)} placeholder="Advertiser, transcript, hook…" /></Field>
          <Field label="Advertiser"><TextInput value={advertiserFilter} onChange={(event) => setAdvertiserFilter(event.currentTarget.value)} placeholder="Filter advertiser" /></Field>
          <Field label="Research state"><SelectInput value={researchState} onChange={(event) => setResearchState(event.currentTarget.value)}><option value="all">All states</option><option value="collected">Collected</option><option value="media stored">Media stored</option><option value="transcribed">Transcribed</option><option value="analyzed">Analyzed</option><option value="needs review">Needs review</option></SelectInput></Field>
          <Field label="Has field"><SelectInput value={researchField} onChange={(event) => setResearchField(event.currentTarget.value)}><option value="all">Any analysis</option><option value="topic">Topic</option><option value="openingMove">Opening move</option><option value="hookMechanism">Hook mechanism</option><option value="hook">Hook</option><option value="structure">Structure</option><option value="cta">CTA</option><option value="segmentRole">Segment role</option></SelectInput></Field>
          <Field label="Minimum analysis confidence"><SelectInput value={minimumConfidence} onChange={(event) => setMinimumConfidence(event.currentTarget.value)}><option value="0">Any confidence</option><option value="0.65">0.65</option><option value="0.8">0.80</option></SelectInput></Field>
          <Field label="Captured after"><TextInput type="date" value={captureAfter} onChange={(event) => setCaptureAfter(event.currentTarget.value)} /></Field>
          <Field label="Captured before"><TextInput type="date" value={captureBefore} onChange={(event) => setCaptureBefore(event.currentTarget.value)} /></Field>
          <Field label="Minimum duration (seconds)"><TextInput type="number" min="0" step="1" value={minimumDuration} onChange={(event) => setMinimumDuration(event.currentTarget.value)} /></Field>
          <Field label="Maximum duration (seconds)"><TextInput type="number" min="0" step="1" value={maximumDuration} onChange={(event) => setMaximumDuration(event.currentTarget.value)} /></Field>
        </div>
        <p className="mt-3 text-sm text-muted">Showing {visibleResearch.length} of {market.researchAds.length} recent source records. Filter labels apply to JEV Research classifications.</p>
        {visibleResearch.length ? <ul className={`mt-4 ${researchView === "gallery" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-line"}`}>{visibleResearch.map((ad) => (
          <li key={ad.id} className={researchView === "gallery" ? "min-w-0 rounded-lg border border-line p-4" : "grid gap-2 py-3 md:grid-cols-[minmax(10rem,1fr)_10rem_10rem_8rem] md:items-center"}>
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><a className="font-semibold underline" href={ad.url} target="_blank" rel="noreferrer">{ad.advertiser}</a><span className="rounded-full border border-line px-2 py-0.5 text-xs">{researchAdState(ad)}</span></div><p className="mt-1 text-xs text-muted">Meta Ad Library · {ad.mediaType} · captured {new Date(ad.capturedAt).toLocaleDateString()}</p>{researchView === "gallery" ? <p className="mt-3 line-clamp-3 text-sm">{ad.copy || ad.headline || "No source copy available."}</p> : null}</div>
            <p className="text-xs text-muted">Media {ad.mediaStatus} · transcript {ad.transcriptStatus}</p>
            <p className="text-xs text-muted">{ad.durationMs ? `${(ad.durationMs / 1000).toFixed(1)} sec` : "duration unavailable"} · confidence {ad.confidence.toFixed(2)}</p>
            <Button type="button" variant="secondary" onClick={() => setSelectedAdId(ad.id)}>View analysis</Button>
          </li>
        ))}</ul> : <p className="mt-3 text-sm text-muted">No ads match these filters.</p>}
        <Sheet open={!!selectedAd} onOpenChange={(open) => { if (!open) setSelectedAdId(null); }}>
          <SheetContent className="left-auto right-0 top-0 bottom-0 max-h-none w-full max-w-2xl rounded-none border-l border-t-0">
            {selectedAd ? <>
              <SheetTitle className="font-display text-2xl">{selectedAd.advertiser || "Research ad"}</SheetTitle>
              <SheetDescription>Source {selectedAd.externalId} · Meta Ad Library · {new Date(selectedAd.capturedAt).toLocaleDateString()}</SheetDescription>
              <div className="mt-5 space-y-5">
                <p className="text-xs text-muted">Media {selectedAd.mediaStatus} · transcript {selectedAd.transcriptStatus} · analysis {selectedAd.analysisStatus} · duration {selectedAd.durationMs ? `${(selectedAd.durationMs / 1000).toFixed(1)} sec` : "unavailable"}</p>
                {selectedAnalysis ? <>
                  <p className="text-sm">{selectedAd.transcript || selectedAd.copy || "No transcript or source copy stored."}</p>
                  <dl className="grid gap-2 sm:grid-cols-2">{([ ["Topic", selectedAnalysis.topic], ["Opening move", selectedAnalysis.openingMove], ["Hook mechanism", selectedAnalysis.hookMechanism], ["Hook", selectedAnalysis.hook], ["Structure", selectedAnalysis.structure], ["Evidence offered", selectedAnalysis.evidenceOffered], ["Emotional appeal", selectedAnalysis.emotionalAppeal], ["Advice specificity", selectedAnalysis.adviceSpecificity], ["CTA", selectedAnalysis.cta] ] as [string, AnalysisFieldView | undefined][]).map(([label, field]) => <div key={label} className="rounded border border-line p-3"><dt className="text-xs font-semibold uppercase text-muted">{label}</dt><dd className="mt-1 text-sm">{field?.value ?? "unclear"}</dd><dd className="mt-1 text-xs text-muted">Confidence {(field?.confidence ?? 0).toFixed(2)} · evidence {(field?.evidence ?? []).join(", ") || "none"}</dd></div>)}</dl>
                  <p className="text-xs text-muted">JEV Research confidence {selectedAd.confidence.toFixed(2)} · {selectedAd.reviewRequired ? "review required" : "no review flagged"} · {selectedAd.provider}/{selectedAd.model} · schema {selectedAd.schemaVersion}</p>
                  <div><h3 className="font-semibold">Transcript segments</h3><ul className="mt-2 space-y-2">{(selectedAnalysis.segments ?? []).map((segment, index) => <li key={segment.id ?? index} className="border-l-2 border-brass pl-3 text-sm"><strong>{segment.role ?? "unclear"}</strong>{segment.startMs != null ? ` · ${segment.startMs}–${segment.endMs ?? "?"} ms` : " · time unavailable"} · {segment.text}</li>)}</ul></div>
                </> : <p className="text-sm text-muted">{selectedAd.copy || selectedAd.headline || "No source copy available."} {selectedAd.error ? `· ${selectedAd.error}` : "· Structured analysis is not available for this ad."}</p>}
                {selectedAnalysis?.claims?.length ? <div><h3 className="font-semibold">Claims and evidence</h3><ul className="mt-2 space-y-2">{selectedAnalysis.claims.map((claim, index) => <li key={`${claim.type}:${index}`} className="text-sm"><strong>{claim.type ?? "Claim"}:</strong> {claim.text} · evidence {(claim.evidence ?? []).join(", ") || "none"}</li>)}</ul></div> : null}
                {selectedAd.error ? <Notice>{selectedAd.error}</Notice> : null}
              </div>
            </> : null}
          </SheetContent>
        </Sheet>
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Competitors</h2>
        {market.competitors.filter((item) => item.status === "confirmed").length === 0 ? (
          <p className="mt-3 text-muted">No competitors yet. Add one you actually compete with.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {market.competitors.filter((item) => item.status === "confirmed").map((item) => (
              <li key={item.id}>
                <span className="font-semibold">{item.name}</span>
                <span className="text-muted"> · {item.kind}</span>
                {item.website ? <span className="text-muted"> · {item.website}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {market.competitors.some((item) => item.status === "candidate") ? (
          <ul className="mt-4 space-y-2">
            {market.competitors.filter((item) => item.status === "candidate").map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-widest text-brass">Candidate</span>
                <span className="font-semibold">{item.name}</span>
                {canEdit ? (
                  <>
                    <Button type="button" disabled={busy.pending} onClick={() => { void busy.run(async () => { await reviewCompetitor({ data: { brandId, competitorId: item.id, action: "confirm" } }); }); }}>Confirm</Button>
                    <Button type="button" disabled={busy.pending} onClick={() => { void busy.run(async () => { await reviewCompetitor({ data: { brandId, competitorId: item.id, action: "reject" } }); }); }}>Reject</Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">No unconfirmed candidates. Discovery never marks a competitor confirmed on its own.</p>
        )}
        {canEdit ? (
          <div className="mt-3">
            <Button type="button" disabled={busy.pending} onClick={() => { void busy.run(async () => { const result = await proposeCompetitors({ data: { brandId } }); setNote(result.created === 0 ? "No new competitor candidates from stored evidence." : `${result.created} candidate(s) stored. They stay unconfirmed until you accept them.`); }); }}>Find candidates</Button>
          </div>
        ) : null}
        {canEdit ? (
          <form
            className="mt-4 grid gap-3 md:grid-cols-2"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void busy.run(async () => {
                await addCompetitor({
                  data: {
                    brandId,
                    name: String(data.get("name") ?? ""),
                    website: String(data.get("website") ?? ""),
                    notes: String(data.get("notes") ?? ""),
                    kind: String(data.get("kind") ?? "direct"),
                  },
                });
                form.reset();
              });
            }}
          >
            <Field label="Name">
              <TextInput name="name" required maxLength={120} />
            </Field>
            <Field label="Website" hint="Optional. Stored, not crawled.">
              <TextInput name="website" />
            </Field>
            <Field label="Kind">
              <SelectInput name="kind" defaultValue="direct">
                <option value="direct">Direct</option>
                <option value="adjacent">Adjacent</option>
                <option value="inspirational">Inspirational</option>
              </SelectInput>
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy.pending}>Add competitor</Button>
            </div>
          </form>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Observed creatives</h2>
        <p className="mt-2 text-sm text-muted">These rows are the only competitor evidence the ranker will use.</p>
        {market.observations.length === 0 ? <p className="mt-3 text-muted">No observations stored.</p> : (
          <ul className="mt-4 space-y-3">
            {market.observations.map((item) => (
              <li key={item.id} className="border-t border-line pt-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.angle}</p>
                <p className="font-semibold">{item.hook}</p>
                <p className="text-sm text-muted">{item.message}</p>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void busy.run(async () => {
                const saved = await recordObservation({
                  data: {
                    brandId,
                    origin: "competitor",
                    competitorId: String(data.get("competitorId") ?? ""),
                    angle: String(data.get("angle") ?? ""),
                    observedAngle: String(data.get("observedAngle") ?? ""),
                    hookType: String(data.get("hookType") ?? ""),
                    format: String(data.get("format") ?? ""),
                    proofType: String(data.get("proofType") ?? ""),
                    title: String(data.get("title") ?? ""),
                    hook: String(data.get("hook") ?? ""),
                    message: String(data.get("message") ?? ""),
                    offer: String(data.get("offer") ?? ""),
                    cta: String(data.get("cta") ?? ""),
                    claim: String(data.get("claim") ?? ""),
                    platform: String(data.get("platform") ?? ""),
                    productName: "",
                    sourceUrl: String(data.get("sourceUrl") ?? ""),
                  },
                });
                setNote(saved.duplicate ? "That observation was already stored." : "Observation stored.");
                if (!saved.duplicate) form.reset();
              });
            }}
          >
            <Field label="Competitor">
              <SelectInput name="competitorId" required defaultValue="">
                <option value="" disabled>Choose</option>
                {market.competitors.filter((item) => item.status === "confirmed").map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Angle preset">
              <SelectInput name="angle" defaultValue="demonstration">
                <option value="">Not in the list</option>
                {HYPOTHESES.map((item) => (
                  <option key={item.id} value={item.angle}>{item.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Observed angle, if it is not in the list">
              <TextInput name="observedAngle" placeholder="unboxing" />
            </Field>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Hook type"><TextInput name="hookType" placeholder="defaults from the preset" /></Field>
              <Field label="Format"><TextInput name="format" placeholder="short_ugc" /></Field>
              <Field label="Proof"><TextInput name="proofType" placeholder="demonstration" /></Field>
            </div>
            <Field label="Hook">
              <TextInput name="hook" required maxLength={400} />
            </Field>
            <Field label="What the creative says">
              <TextArea name="message" required />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Offer"><TextInput name="offer" /></Field>
              <Field label="Call to action"><TextInput name="cta" /></Field>
              <Field label="Claim you saw"><TextInput name="claim" /></Field>
              <Field label="Platform"><TextInput name="platform" /></Field>
              <Field label="Source URL"><TextInput name="sourceUrl" /></Field>
            </div>
            <Button type="submit" disabled={busy.pending}>Store observation</Button>
          </form>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Public page</h2>
        <p className="mt-2 text-sm text-muted">The text is stored as untrusted data. It does not change the brand brain unless you accept a suggestion.</p>
        {canEdit ? (
          <form
            className="mt-4 flex flex-wrap gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void busy.run(async () => {
                const result = await fetchSourcePage({ data: { brandId, url: String(form.get("url") ?? "") } });
                setNote(result.status === "stored" ? "Page text stored. It is not part of the brand brain." : result.error);
              });
            }}
          >
            <TextInput name="url" placeholder="https://" className="max-w-md" required />
            <Button type="submit" disabled={busy.pending}>Fetch page</Button>
          </form>
        ) : null}
        <ul className="mt-4 space-y-3">
          {market.documents.length === 0 ? <li className="text-muted">No pages stored.</li> : market.documents.map((doc) => (
            <li key={doc.id} className="border-t border-line pt-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">{doc.status}</p>
              <p className="break-all text-sm">{doc.url}</p>
              {doc.error ? <p className="text-sm text-danger">{doc.error}</p> : <p className="text-sm text-muted">{doc.excerpt}</p>}
              {canEdit && doc.status === "stored" ? (
                <Button
                  className="mt-2"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = await suggestFromDocument({ data: { brandId, documentId: doc.id } });
                      setNote(result.message);
                    });
                  }}
                >
                  Suggest brain edits
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {market.suggestions.length > 0 ? (
          <div className="mt-6 space-y-3">
            <h3 className="font-display text-xl">Suggestions waiting</h3>
            {market.suggestions.map((item) => (
              <div key={item.id} className="rounded-md border border-line p-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.field}</p>
                <p className="mt-1">{item.value}</p>
                {canEdit ? (
                  <div className="mt-3 flex gap-2">
                    <Button
                      disabled={busy.pending}
                      onClick={() => void busy.run(async () => {
                        await resolveSuggestion({ data: { brandId, suggestionId: item.id, action: "accept" } });
                      })}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={busy.pending}
                      onClick={() => void busy.run(async () => {
                        await resolveSuggestion({ data: { brandId, suggestionId: item.id, action: "dismiss" } });
                      })}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
