import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, TextArea, TextInput, errorText } from "@/components/ui";
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
import { CompetitorCandidates } from "@/components/market/competitor-candidates";
import { ResearchDetailSheet } from "@/components/market/research-detail-sheet";
import { ResearchFilterBar } from "@/components/market/research-filter-bar";
import { ResearchList } from "@/components/market/research-list";
import { ResearchRunPanel } from "@/components/market/research-run-panel";
import { useResearchFilters } from "@/components/market/use-research-filters";
import type { ResearchAdRow } from "@/components/market/research-model";

export const Route = createFileRoute("/_app/brands/$brandId/market")({ staticData: { pageTitle: "Market" }, component: Page });

const NO_ADS: ResearchAdRow[] = [];

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
  const [researchView, setResearchView] = useState<"gallery" | "table">("gallery");
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
  const researchFilters = useResearchFilters(market?.researchAds ?? NO_ADS);
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
  // A retry sends the same collection call with the failed run's search and country. The form is left as the user set it.
  const retryResearch = useScopedMutation({
    mutationKey: marketKey("research-retry"),
    mutationFn: (vars: { runId: string; searchTerms: string; country: string; limit: number }) => startResearchCollection({ data: { brandId, searchTerms: vars.searchTerms, country: vars.country, limit: vars.limit } }),
    invalidate: () => [qk.market(brandId)],
    onSuccess: (result) => {
      setNote(result.status === "NOT_CONNECTED" ? result.error : `Retry ${result.reused ? "returned the existing run" : "queued"}. This page updates while the run is queued or running.`);
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
  const retryingRunIds = usePendingVariables<{ runId: string }>(marketKey("research-retry")).map((vars) => vars.runId);
  const marketActions = [startResearch, retryResearch, addCompetitorMutation, reviewCompetitorMutation, proposeCandidates, fetchPageMutation, storeObservationMutation, suggestBrainEdits, resolveSuggestionMutation];
  const failures = marketActions.map((action) => action.error).filter((error): error is Error => Boolean(error));

  const hasUnsavedChanges = researchForm.formState.isDirty || competitorForm.formState.isDirty || pageForm.formState.isDirty || observationForm.formState.isDirty;
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [hasUnsavedChanges]);

  // Hooks above this line run on every render. The early returns below only choose what to draw.
  const selectedAd = useMemo(() => market?.researchAds.find((ad) => ad.id === selectedAdId) ?? null, [market, selectedAdId]);
  if (query.isError && !market) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!market) return <ScreenSkeleton label="Loading market" shape="cards" />;
  const canEdit = hasRole(market.role, "member");
  const retryLimit = Number(researchForm.watch("limit")) || 50;
  const candidates = market.competitors.filter((item) => item.status === "candidate");

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
        <div className="mt-6">
          <ResearchRunPanel
            runs={market.researchRuns}
            ads={market.researchAds}
            canEdit={canEdit}
            retryLimit={retryLimit}
            retryingRunIds={retryingRunIds}
            onRetry={(run) => void retryResearch.mutateAsync({ runId: run.id, searchTerms: run.searchTerms, country: run.country, limit: retryLimit }).catch(() => undefined)}
          />
        </div>
        <div className="mt-6">
          <h3 className="font-display text-xl">Recurring patterns</h3>
          <p className="mt-1 text-sm text-muted">Counts describe the collected corpus, not ad effectiveness or causation.</p>
          {market.researchPatterns.length ? <ul className="mt-3 grid gap-2 md:grid-cols-2">{market.researchPatterns.filter((pattern) => pattern.dimension === "creative_pattern").map((pattern) => <li key={`${pattern.scope}:${pattern.dimension}:${pattern.value}`} className="rounded border border-line p-3"><p className="text-xs font-semibold uppercase tracking-widest text-brass">{pattern.scope === "organization" ? "Organization summary" : "Brand"} · {pattern.state} · {pattern.sampleCount}/{pattern.corpusSize} ads · confidence {pattern.confidence.toFixed(2)}</p><p className="mt-2 break-words text-sm">{pattern.value}</p><p className="mt-1 text-xs text-muted">{pattern.summary}</p>{pattern.scope !== "organization" ? <p className="mt-1 break-all text-xs text-muted">Source creative ids: {pattern.exampleCreativeIds.join(", ") || "none"} · Analysis ids: {pattern.analysisIds.join(", ") || "none"}</p> : null}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No repeated, confidence-rated ad patterns are stored.</p>}
        </div>
      </Panel>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-display text-2xl">Analyzed ads</h2><p className="text-sm text-muted">Showing saved source, media, transcript, and analysis states.</p></div><div role="group" className="flex gap-2" aria-label="Research display mode"><Button type="button" variant={researchView === "gallery" ? "primary" : "secondary"} aria-pressed={researchView === "gallery"} onClick={() => setResearchView("gallery")}>Gallery</Button><Button type="button" variant={researchView === "table" ? "primary" : "secondary"} aria-pressed={researchView === "table"} onClick={() => setResearchView("table")}>Table</Button></div></div>
        <div className="mt-4">
          <ResearchFilterBar
            filters={researchFilters.filters}
            update={researchFilters.update}
            reset={researchFilters.reset}
            topics={researchFilters.topics}
            activeCount={researchFilters.activeCount}
            visibleCount={researchFilters.visible.length}
            totalCount={market.researchAds.length}
          />
        </div>
        {researchFilters.visible.length ? <div className="mt-4"><ResearchList view={researchView} ads={researchFilters.visible} onView={setSelectedAdId} /></div> : <p className="mt-4 text-sm text-muted">No ads match these filters.</p>}
        <ResearchDetailSheet ad={selectedAd} onOpenChange={(open) => { if (!open) setSelectedAdId(null); }} />
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
        {candidates.length ? (
          <div className="mt-4">
            <CompetitorCandidates
              candidates={candidates}
              canEdit={canEdit}
              pendingIds={reviewingCompetitors}
              onDecide={(competitorId, action) => { void reviewCompetitorMutation.mutateAsync({ competitorId, action }).catch(() => undefined); }}
            />
          </div>
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
