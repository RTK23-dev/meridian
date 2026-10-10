import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, Sheet, SheetContent, SheetDescription, SheetTitle, TextArea, TextInput, errorText } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
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
import { useMarketQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { competitorFieldsSchema, publicPageSchema, researchCollectionSchema, type CompetitorFields, type CompetitorFieldsOutput, type PublicPageFields, type ResearchCollection, type ResearchCollectionFields } from "@/lib/meridian/schemas/market";
import { observationFieldsSchema, type ObservationFields, type ObservationFieldsOutput } from "@/lib/meridian/schemas/observation";

export const Route = createFileRoute("/_app/brands/$brandId/market")({ staticData: { pageTitle: "Market" }, component: Page });

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
  const { reload } = useWorkspace();
  const researchForm = useForm<ResearchCollectionFields, unknown, ResearchCollection>({ resolver: zodResolver(researchCollectionSchema), defaultValues: { searchTerms: "", country: "US", limit: 50 }, mode: "onBlur" });
  const competitorForm = useForm<CompetitorFields, unknown, CompetitorFieldsOutput>({ resolver: zodResolver(competitorFieldsSchema), defaultValues: { name: "", website: "", notes: "", kind: "direct" }, mode: "onBlur" });
  const pageForm = useForm<PublicPageFields, unknown, { url: string }>({ resolver: zodResolver(publicPageSchema), defaultValues: { url: "" }, mode: "onBlur" });
  const observationForm = useForm<ObservationFields, unknown, ObservationFieldsOutput>({
    resolver: zodResolver(observationFieldsSchema),
    defaultValues: { origin: "competitor", competitorId: "", angle: "demonstration", observedAngle: "", hookType: "", format: "", proofType: "", title: "", hook: "", message: "", offer: "", cta: "", claim: "", platform: "", productName: "", sourceUrl: "" },
    mode: "onBlur",
  });
  // One mutation per action. Each invalidates only the keys it changes, and its pending state covers only its own control.
  const marketKey = (name: string) => ["mutation", `market.${name}`, brandId] as const;
  const startResearch = useScopedMutation({
    mutationKey: marketKey("research"),
    mutationFn: (values: ResearchCollection) => startResearchCollection({ data: { brandId, ...values } }),
    invalidate: () => [qk.market(brandId)],
    onSuccess: (result, values) => {
      setNote(result.status === "NOT_CONNECTED" ? result.error : `Research collection ${result.reused ? "already queued" : "queued"}. This page updates while the run is queued or running.`);
      if (result.status !== "NOT_CONNECTED") researchForm.reset(values);
    },
  });
  const addCompetitorMutation = useScopedMutation({
    mutationKey: marketKey("competitor-add"),
    mutationFn: (values: CompetitorFieldsOutput) => addCompetitor({ data: { brandId, ...values } }),
    invalidate: () => [qk.market(brandId), qk.machine(brandId)],
    success: "Competitor added.",
    onSuccess: () => competitorForm.reset({ name: "", website: "", notes: "", kind: "direct" }),
  });
  const reviewCompetitorMutation = useScopedMutation({
    mutationKey: marketKey("competitor-review"),
    mutationFn: (vars: { competitorId: string; action: "confirm" | "reject" }) => reviewCompetitor({ data: { brandId, ...vars } }),
    invalidate: () => [qk.market(brandId), qk.machine(brandId)],
    success: (vars) => vars.action === "confirm" ? "Competitor confirmed." : "Candidate rejected.",
  });
  const proposeCandidates = useScopedMutation({
    mutationKey: marketKey("propose"),
    mutationFn: () => proposeCompetitors({ data: { brandId } }),
    invalidate: () => [qk.market(brandId), qk.machine(brandId)],
    onSuccess: (result) => setNote(result.created === 0 ? "No new competitor candidates from stored evidence." : `${result.created} candidate(s) stored. They stay unconfirmed until you accept them.`),
  });
  const fetchPageMutation = useScopedMutation({
    mutationKey: marketKey("page-fetch"),
    mutationFn: (values: { url: string }) => fetchSourcePage({ data: { brandId, url: values.url } }),
    invalidate: () => [qk.market(brandId), qk.machine(brandId)],
    onSuccess: (result) => {
      setNote(result.status === "stored" ? "Page text stored. It is not part of the brand brain." : result.error);
      pageForm.reset({ url: "" });
    },
  });
  const storeObservationMutation = useScopedMutation({
    mutationKey: marketKey("observation"),
    mutationFn: (values: ObservationFieldsOutput) => recordObservation({ data: { brandId, ...values } }),
    invalidate: () => [qk.market(brandId), qk.machine(brandId), qk.intelligence(brandId), qk.studio(brandId)],
    onSuccess: (result) => {
      setNote(result.duplicate ? "That observation was already stored." : "Observation stored.");
      observationForm.reset();
    },
  });
  const suggestBrainEdits = useScopedMutation({
    mutationKey: marketKey("suggest"),
    mutationFn: (documentId: string) => suggestFromDocument({ data: { brandId, documentId } }),
    // Suggestions wait in the market screen. They change the brain only when accepted.
    invalidate: () => [qk.market(brandId)],
    onSuccess: (result) => setNote(result.message),
  });
  const resolveSuggestionMutation = useScopedMutation({
    mutationKey: marketKey("suggestion"),
    mutationFn: (vars: { suggestionId: string; action: "accept" | "dismiss" }) => resolveSuggestion({ data: { brandId, ...vars } }),
    invalidate: (vars) => vars.action === "accept" ? [qk.market(brandId), qk.brand(brandId)] : [qk.market(brandId)],
    success: (vars) => vars.action === "accept" ? "Suggestion accepted into the brain." : "Suggestion dismissed.",
    // An accepted suggestion changes the brain, which the workspace list shows as completeness.
    onSuccess: (_data, vars) => {
      if (vars.action === "accept") void reload();
    },
  });
  const reviewingCompetitors = usePendingVariables<{ competitorId: string }>(marketKey("competitor-review")).map((vars) => vars.competitorId);
  const suggestingDocuments = usePendingVariables<string>(marketKey("suggest"));
  const resolvingSuggestions = usePendingVariables<{ suggestionId: string }>(marketKey("suggestion")).map((vars) => vars.suggestionId);
  const marketActions = [startResearch, addCompetitorMutation, reviewCompetitorMutation, proposeCandidates, fetchPageMutation, storeObservationMutation, suggestBrainEdits, resolveSuggestionMutation];
  const failures = marketActions.map((action) => action.error).filter((error): error is Error => Boolean(error));

  const hasUnsavedChanges = researchForm.formState.isDirty || competitorForm.formState.isDirty || pageForm.formState.isDirty || observationForm.formState.isDirty;
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [hasUnsavedChanges]);

  if (query.isError && !market) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!market) return <ScreenSkeleton label="Loading market" shape="cards" />;
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

  async function collectResearch(values: ResearchCollection) {
    await startResearch.mutateAsync(values).catch(() => undefined);
  }

  async function saveCompetitor(values: CompetitorFieldsOutput) {
    await addCompetitorMutation.mutateAsync(values).catch(() => undefined);
  }

  async function fetchPage(values: { url: string }) {
    await fetchPageMutation.mutateAsync(values).catch(() => undefined);
  }

  async function storeObservation(values: ObservationFieldsOutput) {
    await storeObservationMutation.mutateAsync(values).catch(() => undefined);
  }

  return (
    <div className="space-y-8">
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
      {failures.map((error, index) => <Notice key={index}>{errorText(error)}</Notice>)}
      <Panel>
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">JEV Research</p>
          <h2 className="mt-2 font-display text-2xl">Collect external video-ad evidence</h2>
          <p className="mt-2 text-sm text-muted">Meta Ad Library collection is capped at 100 ads and 100 MB of stored source video per run. Each video is capped at 24 MB. Media, transcript and analysis each retain their own status. Ads without a public downloadable video are not analyzed.</p>
        </div>
        {canEdit ? (
          <form className="mt-4 grid gap-3 md:grid-cols-4" onSubmit={researchForm.handleSubmit(collectResearch)}>
            <Field label="Search ads" error={researchForm.formState.errors.searchTerms?.message} required><TextInput {...researchForm.register("searchTerms")} required maxLength={100} placeholder="Brand, product, or category" /></Field>
            <Field label="Country" error={researchForm.formState.errors.country?.message} required><TextInput {...researchForm.register("country")} required maxLength={2} /></Field>
            <Field label="Maximum ads" error={researchForm.formState.errors.limit?.message} required><SelectInput {...researchForm.register("limit", { valueAsNumber: true })}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></SelectInput></Field>
            <div className="flex items-end gap-2">{researchForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => researchForm.reset()}>Clear</Button> : null}<Button type="submit" disabled={startResearch.isPending || researchForm.formState.isSubmitting}>Start collection</Button></div>
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
                    <Button type="button" disabled={reviewingCompetitors.includes(item.id)} onClick={() => { void reviewCompetitorMutation.mutateAsync({ competitorId: item.id, action: "confirm" }).catch(() => undefined); }}>Confirm</Button>
                    <Button type="button" disabled={reviewingCompetitors.includes(item.id)} onClick={() => { void reviewCompetitorMutation.mutateAsync({ competitorId: item.id, action: "reject" }).catch(() => undefined); }}>Reject</Button>
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
            <Button type="button" disabled={proposeCandidates.isPending} onClick={() => { void proposeCandidates.mutateAsync().catch(() => undefined); }}>Find candidates</Button>
          </div>
        ) : null}
        {canEdit ? (
          <form
            className="mt-4 grid gap-3 md:grid-cols-2"
            onSubmit={competitorForm.handleSubmit(saveCompetitor)}
          >
            <Field label="Name" error={competitorForm.formState.errors.name?.message} required>
              <TextInput {...competitorForm.register("name")} required maxLength={120} />
            </Field>
            <Field label="Website" hint="Optional. Stored, not crawled." error={competitorForm.formState.errors.website?.message}>
              <TextInput {...competitorForm.register("website")} maxLength={500} />
            </Field>
            <Field label="Kind" error={competitorForm.formState.errors.kind?.message}>
              <SelectInput {...competitorForm.register("kind")}>
                <option value="direct">Direct</option>
                <option value="adjacent">Adjacent</option>
                <option value="inspirational">Inspirational</option>
              </SelectInput>
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" disabled={addCompetitorMutation.isPending || competitorForm.formState.isSubmitting}>Add competitor</Button>
              {competitorForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => competitorForm.reset()}>Clear</Button> : null}
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
            onSubmit={observationForm.handleSubmit(storeObservation)}
          >
            <Field label="Competitor" error={observationForm.formState.errors.competitorId?.message} required>
              <SelectInput {...observationForm.register("competitorId")} required>
                <option value="" disabled>Choose</option>
                {market.competitors.filter((item) => item.status === "confirmed").map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Angle preset" error={observationForm.formState.errors.observedAngle?.message}>
              <SelectInput {...observationForm.register("angle")}>
                <option value="">Not in the list</option>
                {HYPOTHESES.map((item) => (
                  <option key={item.id} value={item.angle}>{item.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Observed angle, if it is not in the list">
              <TextInput {...observationForm.register("observedAngle")} placeholder="unboxing" maxLength={48} />
            </Field>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Hook type" error={observationForm.formState.errors.hookType?.message}><TextInput {...observationForm.register("hookType")} placeholder="defaults from the preset" maxLength={48} /></Field>
              <Field label="Format" error={observationForm.formState.errors.format?.message}><TextInput {...observationForm.register("format")} placeholder="short_ugc" maxLength={48} /></Field>
              <Field label="Proof" error={observationForm.formState.errors.proofType?.message}><TextInput {...observationForm.register("proofType")} placeholder="demonstration" maxLength={48} /></Field>
            </div>
            <Field label="Hook" error={observationForm.formState.errors.hook?.message} required>
              <TextInput {...observationForm.register("hook")} required maxLength={400} />
            </Field>
            <Field label="What the creative says" error={observationForm.formState.errors.message?.message} required>
              <TextArea {...observationForm.register("message")} required maxLength={4000} />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Offer" error={observationForm.formState.errors.offer?.message}><TextInput {...observationForm.register("offer")} maxLength={400} /></Field>
              <Field label="Call to action" error={observationForm.formState.errors.cta?.message}><TextInput {...observationForm.register("cta")} maxLength={240} /></Field>
              <Field label="Claim you saw" error={observationForm.formState.errors.claim?.message}><TextInput {...observationForm.register("claim")} maxLength={400} /></Field>
              <Field label="Platform" error={observationForm.formState.errors.platform?.message}><TextInput {...observationForm.register("platform")} maxLength={80} /></Field>
              <Field label="Source URL" error={observationForm.formState.errors.sourceUrl?.message}><TextInput {...observationForm.register("sourceUrl")} maxLength={500} /></Field>
            </div>
            <div className="flex flex-wrap gap-2"><Button type="submit" disabled={storeObservationMutation.isPending || observationForm.formState.isSubmitting}>Store observation</Button>{observationForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => observationForm.reset()}>Discard changes</Button> : null}</div>
          </form>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Public page</h2>
        <p className="mt-2 text-sm text-muted">The text is stored as untrusted data. It does not change the brand brain unless you accept a suggestion.</p>
        {canEdit ? (
          <form
            className="mt-4 flex flex-wrap gap-3"
            onSubmit={pageForm.handleSubmit(fetchPage)}
          >
            <Field label="Public page URL" error={pageForm.formState.errors.url?.message} required className="min-w-64 flex-1">
              <TextInput {...pageForm.register("url")} placeholder="https://" className="max-w-md" required maxLength={500} />
            </Field>
            <div className="flex items-end gap-2">{pageForm.formState.isDirty ? <Button type="button" variant="quiet" onClick={() => pageForm.reset()}>Clear</Button> : null}<Button type="submit" disabled={fetchPageMutation.isPending || pageForm.formState.isSubmitting}>Fetch page</Button></div>
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
                  disabled={suggestingDocuments.includes(doc.id)}
                  onClick={() => {
                    void suggestBrainEdits.mutateAsync(doc.id).catch(() => undefined);
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
                      disabled={resolvingSuggestions.includes(item.id)}
                      onClick={() => void resolveSuggestionMutation.mutateAsync({ suggestionId: item.id, action: "accept" }).catch(() => undefined)}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={resolvingSuggestions.includes(item.id)}
                      onClick={() => void resolveSuggestionMutation.mutateAsync({ suggestionId: item.id, action: "dismiss" }).catch(() => undefined)}
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
