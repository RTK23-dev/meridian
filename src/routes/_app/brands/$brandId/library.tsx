import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { StatusText } from "@/components/status";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, TextArea, TextInput, errorText } from "@/components/ui";
import { CreativeCard } from "@/components/library/creative-card";
import { LibraryFilterBar } from "@/components/library/library-filters";
import {
  NO_LIBRARY_FILTERS,
  distinctValues,
  filterLibraryCreatives,
  groupMediaByCreative,
  mediaKindFor,
  primaryMedia,
  type LibraryFilters,
  type MediaLoad,
} from "@/components/library/library-model";
import { TraceDrawer } from "@/components/library/trace-drawer";
import { buildTraceTimeline } from "@/components/library/trace-model";
import { REVIEW_LIST_LIMIT } from "@/components/reviews/review-model";
import { hasRole } from "@/lib/meridian/access";
import { attachCreativeImage, recordObservation, recordPerformance } from "@/lib/meridian/machine";
import { publishPausedObjects } from "@/lib/meridian/providers/publish-action";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";
import { useLibraryQuery, useReviewsQuery, useScopedMutation, useStudioQuery, useTraceQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { downloadCsv } from "@/lib/csv";
import { manualPerformanceSchema, type ManualPerformance, type ManualPerformanceFields } from "@/lib/meridian/schemas/performance";
import { observationFieldsSchema, type ObservationFields, type ObservationFieldsOutput } from "@/lib/meridian/schemas/observation";
import { pausedPublishingSchema, type PausedPublishing, type PausedPublishingFields } from "@/lib/meridian/schemas/paused-publishing";

export const Route = createFileRoute("/_app/brands/$brandId/library")({ staticData: { pageTitle: "Library" }, component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Library brandId={brandId} />
  );
}

const EMPTY_PERFORMANCE = { observedOn: "", platform: "", reach: "0", impressions: "0", clicks: "0", conversions: "0", spendCents: "0", revenueCents: "0" };

function Library({ brandId }: { brandId: string }) {
  const query = useLibraryQuery(brandId);
  const data = query.data ?? null;
  // Media for the cards and the trace comes from the studio session. It is the only read that links an asset id to a creative.
  const studio = useStudioQuery(brandId);
  const variantsByCreative = useMemo(() => groupMediaByCreative(studio.data?.variants ?? []), [studio.data?.variants]);
  // The trace stays mounted after the drawer closes, so its content does not blank out during the exit animation.
  const [traceCreativeId, setTraceCreativeId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filters, setFilters] = useState<LibraryFilters>(NO_LIBRARY_FILTERS);
  const traceQuery = useTraceQuery(brandId, traceCreativeId, drawerOpen);
  const reviewsQuery = useReviewsQuery(brandId, drawerOpen);
  const trace = traceQuery.data ?? null;
  const performanceForm = useForm<ManualPerformanceFields, unknown, ManualPerformance>({
    resolver: zodResolver(manualPerformanceSchema),
    defaultValues: EMPTY_PERFORMANCE,
    mode: "onBlur",
  });
  const observationForm = useForm<ObservationFields, unknown, ObservationFieldsOutput>({
    resolver: zodResolver(observationFieldsSchema),
    defaultValues: { origin: "own", competitorId: "", angle: "curiosity", observedAngle: "", hookType: "", format: "", proofType: "", title: "", hook: "", message: "", offer: "", cta: "", claim: "", platform: "", productName: "", sourceUrl: "" },
    mode: "onBlur",
  });
  const publishForm = useForm<PausedPublishingFields, unknown, PausedPublishing>({
    resolver: zodResolver(pausedPublishingSchema),
    defaultValues: { provider: "meta", creativeId: "", name: "", dailyBudgetCents: "1000", countries: "", locationIds: "", pageId: "", link: "", message: "", scheduleStart: "", imageIds: "", videoId: "", headlines: "", descriptions: "", cpcBidCents: "0" },
    mode: "onBlur",
  });
  const formsDirty = performanceForm.formState.isDirty || observationForm.formState.isDirty || publishForm.formState.isDirty;
  useEffect(() => {
    if (!formsDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [formsDirty]);
  useEffect(() => {
    const firstCreative = data?.creatives[0]?.id;
    if (firstCreative && !publishForm.getValues("creativeId")) {
      publishForm.setValue("creativeId", firstCreative, { shouldDirty: false });
    }
  }, [data?.creatives, publishForm]);
  // Performance typed for one creative must not be saved against another, so the form starts empty for each creative.
  useEffect(() => {
    performanceForm.reset(EMPTY_PERFORMANCE);
  }, [traceCreativeId, performanceForm]);
  const [note, setNote] = useState<string | null>(null);
  const [stages, setStages] = useState<{ objectType: string; status: string; externalId: string | null; detail: string }[]>([]);
  const libraryKey = (name: string) => ["mutation", `library.${name}`, brandId] as const;
  const recordPerf = useScopedMutation({
    mutationKey: libraryKey("performance"),
    mutationFn: (values: ManualPerformance) => recordPerformance({ data: { brandId, creativeId: traceCreativeId ?? "", ...values } }),
    // A performance row changes the creative's trace, the learning patterns, and the overview counts.
    invalidate: () => [qk.trace(brandId), qk.learning(brandId), qk.machine(brandId)],
    onSuccess: () => {
      setNote("Performance stored and a learning job was queued. Scoring opportunities drains that job. No ad account is connected.");
      performanceForm.reset(EMPTY_PERFORMANCE);
      // The note sits on the page behind the drawer, so the drawer closes to show it and to free the other cards.
      setDrawerOpen(false);
    },
  });
  const ownCreative = useScopedMutation({
    mutationKey: libraryKey("own-creative"),
    mutationFn: (values: ObservationFieldsOutput) => recordObservation({ data: { brandId, ...values } }),
    invalidate: () => [qk.library(brandId), qk.machine(brandId)],
    onSuccess: () => {
      setNote("Creative recorded.");
      observationForm.reset();
    },
  });
  const pausedObjects = useScopedMutation({
    mutationKey: libraryKey("paused-publish"),
    mutationFn: (values: PausedPublishing) => publishPausedObjects({ data: { brandId, ...values } }),
    invalidate: () => [qk.library(brandId), qk.machine(brandId)],
    onSuccess: (result) => {
      setStages(result.stages);
      setNote(`${result.detail} Correlation ${result.correlationId}.`);
      publishForm.reset({ ...publishForm.getValues(), name: "" });
    },
  });
  const attachImage = useScopedMutation({
    mutationKey: libraryKey("attach-image"),
    mutationFn: (creativeId: string) => attachCreativeImage({ data: { brandId, creativeId } }),
    // A generated image adds a stored asset, so the media for the cards and the trace is refreshed too.
    invalidate: () => [qk.library(brandId), qk.trace(brandId), qk.studio(brandId)],
    onSuccess: (image) => setNote(image.message),
  });
  const failures = [recordPerf, ownCreative, pausedObjects, attachImage].map((action) => action.error).filter((error): error is Error => Boolean(error));

  // Hooks stop above this line. The screen renders from here down.
  if (query.isError && !data) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading library" shape="rows" />;
  const canEdit = hasRole(data.role, "member");

  const mediaLoad: MediaLoad = studio.isError ? "unavailable" : studio.data ? "ready" : "loading";
  const kindOf = (creativeId: string) => mediaKindFor(mediaLoad, variantsByCreative.get(creativeId) ?? []);
  const visibleCreatives = filterLibraryCreatives(data.creatives, filters, kindOf);
  const traceMedia = traceCreativeId ? variantsByCreative.get(traceCreativeId) ?? [] : [];
  const traceLabel = trace ? trace.creative.title || trace.creative.hook || "Creative" : "";
  const traceStages = trace
    ? buildTraceTimeline({
        creativeId: trace.creative.id,
        creativeStatus: trace.creative.status,
        opportunity: trace.opportunity,
        decisions: trace.decisions,
        brief: trace.brief,
        observations: trace.observations,
        mediaLoad,
        media: traceMedia,
        reviewsLoad: reviewsQuery.isError ? "unavailable" : reviewsQuery.data ? "ready" : "loading",
        reviews: reviewsQuery.data?.reviews ?? [],
        reviewsTruncated: (reviewsQuery.data?.reviews.length ?? 0) >= REVIEW_LIST_LIMIT,
      })
    : null;

  async function savePerformance(values: ManualPerformance) {
    await recordPerf.mutateAsync(values).catch(() => undefined);
  }

  async function saveOwnCreative(values: ObservationFieldsOutput) {
    await ownCreative.mutateAsync(values).catch(() => undefined);
  }
  async function savePausedObjects(values: PausedPublishing) {
    await pausedObjects.mutateAsync(values).catch(() => undefined);
  }
  function openTrace(creativeId: string) {
    setTraceCreativeId(creativeId);
    setDrawerOpen(true);
  }

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Library</p>
        <h1 className="font-display text-4xl">Creatives this brand owns</h1>
        <p className="text-muted">Competitor observations stay on Market. You can enter performance here. A worker sync runs only after a healthy connection and a schedule. Publishing stays paused and runs only when you submit the form below.</p>
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {failures.map((error, index) => <Notice key={index}>{errorText(error)}</Notice>)}
      <Button type="button" variant="quiet" disabled={!visibleCreatives.length} onClick={() => downloadCsv("meridian-library.csv", [
        { key: "id", label: "Creative ID" }, { key: "title", label: "Title" }, { key: "hook", label: "Hook" },
        { key: "angle", label: "Angle" }, { key: "status", label: "Status" }, { key: "origin", label: "Origin" }, { key: "createdAt", label: "Created at" },
      ], visibleCreatives)}>Export visible library</Button>
      <Panel>
        <h2 className="font-display text-2xl">Paused publishing</h2>
        <p className="mt-2 text-sm text-muted">
          This creates paused objects and stores an id only when the provider returns one. Auto-publish stays off. A missing token, page, location, or uploaded asset stops the chain. Nothing is marked published from this form’s click alone.
        </p>
        {hasRole(data.role, "admin") ? (
          <form
            className="mt-4 grid gap-3"
            onSubmit={publishForm.handleSubmit(savePausedObjects)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}
          >
            <Field label="Provider" error={publishForm.formState.errors.provider?.message}>
              <SelectInput {...publishForm.register("provider")}>
                <option value="meta">Meta</option>
                <option value="tiktok">TikTok</option>
                <option value="google">Google Ads</option>
              </SelectInput>
            </Field>
            <Field label="Creative" hint="Used only to resume this brand’s stored ids. It is not sent as an external id." error={publishForm.formState.errors.creativeId?.message}>
              <SelectInput {...publishForm.register("creativeId")} required>
                <option value="">Choose a creative</option>
                {data.creatives.length === 0 ? <option value="">Create a creative first</option> : null}
                {data.creatives.map((item) => (
                  <option key={item.id} value={item.id}>{item.title || item.hook || item.id}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Name" error={publishForm.formState.errors.name?.message}>
              <TextInput {...publishForm.register("name")} required maxLength={120} />
            </Field>
            <Field label="Daily budget (cents)" error={publishForm.formState.errors.dailyBudgetCents?.message}>
              <TextInput {...publishForm.register("dailyBudgetCents")} type="text" inputMode="decimal" required />
            </Field>
            <Field label="Link">
              <TextInput {...publishForm.register("link")} type="url" placeholder="https://" />
            </Field>
            <Field label="Message">
              <TextArea {...publishForm.register("message")} />
            </Field>
            <Field label="Meta countries" hint="Comma-separated, such as US. Used only for Meta.">
              <TextInput {...publishForm.register("countries")} />
            </Field>
            <Field label="Meta page id">
              <TextInput {...publishForm.register("pageId")} />
            </Field>
            <Field label="TikTok location ids" hint="Numeric location ids, not country codes. An ad also needs an uploaded image or video id.">
              <TextInput {...publishForm.register("locationIds")} />
            </Field>
            <Field label="TikTok schedule start">
              <TextInput {...publishForm.register("scheduleStart")} placeholder="2026-01-02 00:00:00" />
            </Field>
            <Field label="TikTok image ids">
              <TextInput {...publishForm.register("imageIds")} />
            </Field>
            <Field label="TikTok video id">
              <TextInput {...publishForm.register("videoId")} />
            </Field>
            <Field label="Google headlines" hint="Each headline is 30 characters or fewer.">
              <TextInput {...publishForm.register("headlines")} />
            </Field>
            <Field label="Google descriptions" hint="Each description is 90 characters or fewer.">
              <TextInput {...publishForm.register("descriptions")} />
            </Field>
            <Field label="Google CPC bid (cents)">
              <TextInput {...publishForm.register("cpcBidCents")} type="text" inputMode="decimal" />
            </Field>
            {publishForm.formState.isDirty ? <div role="status" className="flex items-center justify-between rounded-md border border-warning bg-warning-soft p-3 text-sm"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => publishForm.reset()}>Discard</Button></div> : null}
            <Button type="submit" disabled={pausedObjects.isPending || publishForm.formState.isSubmitting || data.creatives.length === 0}>{publishForm.formState.isSubmitting ? "Submitting…" : "Create paused objects"}</Button>
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
          {studio.isError ? <Notice>Media previews could not be loaded. {errorText(studio.error)}</Notice> : null}
          <LibraryFilterBar
            filters={filters}
            onChange={setFilters}
            statuses={distinctValues(data.creatives, (item) => item.status)}
            origins={distinctValues(data.creatives, (item) => item.origin)}
            angles={distinctValues(data.creatives, (item) => item.angle)}
          />
          <p className="text-sm text-muted" aria-live="polite">Showing {visibleCreatives.length} of {data.creatives.length} creatives.</p>
          {visibleCreatives.length ? (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleCreatives.map((item) => (
                <CreativeCard
                  key={item.id}
                  item={item}
                  variants={variantsByCreative.get(item.id) ?? []}
                  mediaLoad={mediaLoad}
                  onTrace={() => openTrace(item.id)}
                />
              ))}
            </ul>
          ) : (
            <Panel className="flex flex-wrap items-center justify-between gap-3">
              <span>No creatives match these filters.</span>
              <Button type="button" variant="quiet" onClick={() => setFilters(NO_LIBRARY_FILTERS)}>Clear filters</Button>
            </Panel>
          )}
        </section>
      )}
      <TraceDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Why this exists"
        summary={trace ? `${traceLabel} · ${trace.creative.status} · ${trace.creative.angle}` : "Opportunity to performance, in order."}
        loading={traceQuery.isPending}
        error={traceCreativeId && traceQuery.error ? errorText(traceQuery.error) : null}
        onRetry={() => void traceQuery.refetch()}
        stages={traceStages}
        script={trace?.creative.script ?? ""}
        learnedSummary={trace ? (trace.patterns.length === 0 ? "No learned pattern matches this creative yet." : trace.patterns.map((item) => item.summary).join(" ")) : ""}
        preview={primaryMedia(traceMedia)}
        canEdit={canEdit}
        performanceForm={performanceForm}
        onRecordPerformance={savePerformance}
        recordPending={recordPerf.isPending}
        onGenerateImage={() => {
          if (traceCreativeId) void attachImage.mutateAsync(traceCreativeId).catch(() => undefined);
        }}
        imagePending={attachImage.isPending}
      />
      {canEdit ? (
        <Panel>
          <h2 className="font-display text-2xl">Record a creative we already ran</h2>
          <p className="mt-2 text-sm text-muted">Use this for history the system did not generate. It can receive performance and feed learning.</p>
          <form
            className="mt-4 grid gap-3"
            onSubmit={observationForm.handleSubmit(saveOwnCreative)}
          >
            <Field label="Angle preset" error={observationForm.formState.errors.observedAngle?.message}>
              <SelectInput {...observationForm.register("angle")}>
                <option value="">Not in the list</option>
                {HYPOTHESES.map((item) => <option key={item.id} value={item.angle}>{item.label}</option>)}
              </SelectInput>
            </Field>
            <Field label="Observed angle, if it is not in the list">
              <TextInput {...observationForm.register("observedAngle")} placeholder="unboxing" maxLength={48} />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Hook type" error={observationForm.formState.errors.hookType?.message}><TextInput {...observationForm.register("hookType")} maxLength={48} /></Field>
              <Field label="Format" error={observationForm.formState.errors.format?.message}><TextInput {...observationForm.register("format")} maxLength={48} /></Field>
            </div>
            <Field label="Hook" error={observationForm.formState.errors.hook?.message} required><TextInput {...observationForm.register("hook")} required maxLength={400} /></Field>
            <Field label="Script" error={observationForm.formState.errors.message?.message} required><TextArea {...observationForm.register("message")} required maxLength={4000} /></Field>
            <Field label="Call to action" error={observationForm.formState.errors.cta?.message}><TextInput {...observationForm.register("cta")} maxLength={240} /></Field>
            <Field label="Product" error={observationForm.formState.errors.productName?.message}><TextInput {...observationForm.register("productName")} maxLength={160} /></Field>
            {observationForm.formState.isDirty ? <div className="flex items-center justify-between rounded-md border border-warning bg-warning-soft p-3 text-sm" role="status"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => observationForm.reset()}>Discard</Button></div> : null}
            <Button type="submit" disabled={ownCreative.isPending || observationForm.formState.isSubmitting}>Save to library</Button>
          </form>
        </Panel>
      ) : null}
    </div>
  );
}
