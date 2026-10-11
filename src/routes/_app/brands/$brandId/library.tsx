import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Button, DisabledReason, Field, Card, ScreenSkeleton, SelectInput, StatusBadge, Textarea, Input } from "@/components/ui";
import { PlainErrorMessage, PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { plainError } from "@/lib/copy";
import { CreativeCard } from "@/components/library/creative-card";
import { LibraryFilterBar } from "@/components/library/library-filters";
import {
  NO_LIBRARY_FILTERS,
  distinctValues,
  filterLibraryCreatives,
  mediaByCreative,
  mediaKindFor,
  primaryMedia,
  type LibraryFilters,
  type MediaLoad,
} from "@/components/library/library-model";
import { TraceDrawer } from "@/components/library/trace-drawer";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { buildTraceTimeline } from "@/components/library/trace-model";
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
  // Each card's media comes from the studio variants where they exist, and from the asset id in the library list otherwise.
  const variantsByCreative = useMemo(() => mediaByCreative(data?.creatives ?? [], studio.data?.variants ?? []), [data?.creatives, studio.data?.variants]);
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
  const [publishDiscard, setPublishDiscard] = useState(false);
  const [observationDiscard, setObservationDiscard] = useState(false);
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
  if (query.isError && !data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading library" shape="rows" />;
  const canEdit = hasRole(data.role, "member");

  // The cards read media from the library list, which always answers with the asset ids. The studio read adds detail only.
  const mediaLoad: MediaLoad = "ready";
  const studioLoad: MediaLoad = studio.isError ? "unavailable" : studio.data ? "ready" : "loading";
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
        mediaLoad: studioLoad,
        media: traceMedia,
        reviewsLoad: reviewsQuery.isError ? "unavailable" : reviewsQuery.data ? "ready" : "loading",
        reviews: reviewsQuery.data?.reviews ?? [],
        reviewsTruncated: reviewsQuery.data?.hasMore ?? false,
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
      <UnsavedChangesGuard dirty={formsDirty} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Library</p>
        <h1 className="font-display text-4xl">Creatives this brand owns</h1>
        <p className="text-muted">Competitor observations stay on Market. You can enter performance here. A worker sync runs only after a healthy connection and a schedule. Publishing stays paused and runs only when you submit the form below.</p>
      </div>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {failures.map((error, index) => <PlainErrorNotice key={index} error={error} />)}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="quiet" disabled={!visibleCreatives.length} aria-describedby={visibleCreatives.length ? undefined : "library-export-reason"} onClick={() => downloadCsv("meridian-library.csv", [
          { key: "id", label: "Creative ID" }, { key: "title", label: "Title" }, { key: "hook", label: "Hook" },
          { key: "angle", label: "Angle" }, { key: "status", label: "Status" }, { key: "origin", label: "Origin" }, { key: "createdAt", label: "Created at" },
        ], visibleCreatives)}>Export visible library</Button>
        {visibleCreatives.length ? null : (
          <DisabledReason id="library-export-reason" className="basis-full">
            {data.creatives.length === 0
              ? "There are no creatives to export yet. Record or generate one first."
              : "No creatives match the filters, so there is nothing to export. Clear the filters to export the library."}
          </DisabledReason>
        )}
      </div>
      <Card>
        <h2 className="font-display text-2xl">Paused publishing</h2>
        <p className="mt-2 text-sm text-muted">
          This creates paused objects and stores an id only when the provider returns one. Auto-publish stays off. A missing token, page, location, or uploaded asset stops the chain. Nothing is marked published from this form’s click alone.
        </p>
        {hasRole(data.role, "admin") ? (
          <form
            className="mt-4 grid gap-3"
            onSubmit={publishForm.handleSubmit(savePausedObjects)}
            onKeyDown={(event) => submitOnShortcut(event)}
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
              <Input {...publishForm.register("name")} required maxLength={120} />
            </Field>
            <Field label="Daily budget (cents)" error={publishForm.formState.errors.dailyBudgetCents?.message}>
              <Input {...publishForm.register("dailyBudgetCents")} type="text" inputMode="decimal" required />
            </Field>
            <Field label="Link" error={publishForm.formState.errors.link?.message}>
              <Input {...publishForm.register("link")} type="url" placeholder="https://" />
            </Field>
            <Field label="Message" error={publishForm.formState.errors.message?.message}>
              <Textarea {...publishForm.register("message")} />
            </Field>
            <Field label="Meta countries" hint="Comma-separated, such as US. Used only for Meta." error={publishForm.formState.errors.countries?.message}>
              <Input {...publishForm.register("countries")} />
            </Field>
            <Field label="Meta page id" error={publishForm.formState.errors.pageId?.message}>
              <Input {...publishForm.register("pageId")} />
            </Field>
            <Field label="TikTok location ids" hint="Numeric location ids, not country codes. An ad also needs an uploaded image or video id." error={publishForm.formState.errors.locationIds?.message}>
              <Input {...publishForm.register("locationIds")} />
            </Field>
            <Field label="TikTok schedule start" error={publishForm.formState.errors.scheduleStart?.message}>
              <Input {...publishForm.register("scheduleStart")} placeholder="2026-01-02 00:00:00" />
            </Field>
            <Field label="TikTok image ids" error={publishForm.formState.errors.imageIds?.message}>
              <Input {...publishForm.register("imageIds")} />
            </Field>
            <Field label="TikTok video id" error={publishForm.formState.errors.videoId?.message}>
              <Input {...publishForm.register("videoId")} />
            </Field>
            <Field label="Google headlines" hint="Each headline is 30 characters or fewer." error={publishForm.formState.errors.headlines?.message}>
              <Input {...publishForm.register("headlines")} />
            </Field>
            <Field label="Google descriptions" hint="Each description is 90 characters or fewer." error={publishForm.formState.errors.descriptions?.message}>
              <Input {...publishForm.register("descriptions")} />
            </Field>
            <Field label="Google CPC bid (cents)" error={publishForm.formState.errors.cpcBidCents?.message}>
              <Input {...publishForm.register("cpcBidCents")} type="text" inputMode="decimal" />
            </Field>
            <UnsavedChangesBar
              dirty={publishForm.formState.isDirty}
              subject="paused publish"
              confirming={publishDiscard}
              onConfirmingChange={setPublishDiscard}
              onDiscard={() => { publishForm.reset(); setPublishDiscard(false); }}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button type="submit" disabled={pausedObjects.isPending || publishForm.formState.isSubmitting || data.creatives.length === 0} aria-describedby={data.creatives.length === 0 ? "paused-publish-reason" : undefined}>{pausedObjects.isPending || publishForm.formState.isSubmitting ? "Submitting…" : "Create paused objects"}</Button>
              {data.creatives.length === 0 ? <DisabledReason id="paused-publish-reason" className="basis-full">Create or record a creative first. A paused object needs a creative to point at.</DisabledReason> : null}
            </div>
          </form>
        ) : (
          <p className="mt-2 text-sm text-muted">An admin can send a paused publish.</p>
        )}
        {stages.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {stages.map((stage) => (
              <li key={stage.objectType} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-fg">{stage.objectType}</span>
                  <StatusBadge status={stage.status} />
                </div>
                <p className="text-sm text-muted">{stage.externalId ? `Confirmed id ${stage.externalId}.` : stage.detail || "No id was stored."}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {data.creatives.length === 0 ? <Card>No brand creatives yet. Rank an opportunity, brief it, and save a script. Or record one you already ran.</Card> : (
        <section aria-labelledby="library-creatives-title" className="space-y-4">
          <div><h2 id="library-creatives-title" className="font-display text-2xl">Creative library</h2><p className="text-sm text-muted">Search and filter the 50 most recent stored creatives. Media preview appears when its stored asset can be served.</p></div>
          {studio.isError ? <PlainErrorMessage message="Media details could not be loaded. Thumbnails still come from the library list. Open Details for the exact message." raw={plainError(studio.error).raw} /> : null}
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
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <span>No creatives match these filters.</span>
              <Button type="button" variant="quiet" onClick={() => setFilters(NO_LIBRARY_FILTERS)}>Clear filters</Button>
            </Card>
          )}
        </section>
      )}
      <TraceDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Why this exists"
        summary={trace ? `${traceLabel} · ${trace.creative.status} · ${trace.creative.angle}` : "Opportunity to performance, in order."}
        loading={traceQuery.isPending}
        error={traceCreativeId && traceQuery.error ? plainError(traceQuery.error) : null}
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
        <Card>
          <h2 className="font-display text-2xl">Record a creative we already ran</h2>
          <p className="mt-2 text-sm text-muted">Use this for history the system did not generate. It can receive performance and feed learning.</p>
          <form
            className="mt-4 grid gap-3"
            onSubmit={observationForm.handleSubmit(saveOwnCreative)}
            onKeyDown={(event) => submitOnShortcut(event)}
          >
            <Field label="Angle preset" error={observationForm.formState.errors.angle?.message}>
              <SelectInput {...observationForm.register("angle")}>
                <option value="">Not in the list</option>
                {HYPOTHESES.map((item) => <option key={item.id} value={item.angle}>{item.label}</option>)}
              </SelectInput>
            </Field>
            <Field label="Observed angle, if it is not in the list" error={observationForm.formState.errors.observedAngle?.message}>
              <Input {...observationForm.register("observedAngle")} placeholder="unboxing" maxLength={48} />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Hook type" error={observationForm.formState.errors.hookType?.message}><Input {...observationForm.register("hookType")} maxLength={48} /></Field>
              <Field label="Format" error={observationForm.formState.errors.format?.message}><Input {...observationForm.register("format")} maxLength={48} /></Field>
            </div>
            <Field label="Hook" error={observationForm.formState.errors.hook?.message} required><Input {...observationForm.register("hook")} required maxLength={400} /></Field>
            <Field label="Script" error={observationForm.formState.errors.message?.message} required><Textarea {...observationForm.register("message")} required maxLength={4000} /></Field>
            <Field label="Call to action" error={observationForm.formState.errors.cta?.message}><Input {...observationForm.register("cta")} maxLength={240} /></Field>
            <Field label="Product" error={observationForm.formState.errors.productName?.message}><Input {...observationForm.register("productName")} maxLength={160} /></Field>
            <UnsavedChangesBar
              dirty={observationForm.formState.isDirty}
              subject="creative"
              confirming={observationDiscard}
              onConfirmingChange={setObservationDiscard}
              onDiscard={() => { observationForm.reset(); setObservationDiscard(false); }}
            />
            <Button type="submit" disabled={ownCreative.isPending || observationForm.formState.isSubmitting}>{ownCreative.isPending || observationForm.formState.isSubmitting ? "Saving…" : "Save to library"}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
