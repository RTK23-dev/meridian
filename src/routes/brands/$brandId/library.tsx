import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { BrandNav } from "@/components/brand-nav";
import { StatusText } from "@/components/status";
import { Button, ErrorState, Field, Notice, Panel, ScreenSkeleton, SelectInput, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { attachCreativeImage, recordObservation, recordPerformance } from "@/lib/meridian/machine";
import { publishPausedObjects } from "@/lib/meridian/providers/publish-action";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";
import { useLibraryQuery, useScopedMutation, useTraceQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { downloadCsv } from "@/lib/csv";
import { manualPerformanceSchema, type ManualPerformance, type ManualPerformanceFields } from "@/lib/meridian/schemas/performance";
import { observationFieldsSchema, type ObservationFields, type ObservationFieldsOutput } from "@/lib/meridian/schemas/observation";
import { pausedPublishingSchema, type PausedPublishing, type PausedPublishingFields } from "@/lib/meridian/schemas/paused-publishing";

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
  const performanceForm = useForm<ManualPerformanceFields, unknown, ManualPerformance>({
    resolver: zodResolver(manualPerformanceSchema),
    defaultValues: { observedOn: "", platform: "", reach: "0", impressions: "0", clicks: "0", conversions: "0", spendCents: "0", revenueCents: "0" },
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
  const [note, setNote] = useState<string | null>(null);
  const [stages, setStages] = useState<{ objectType: string; status: string; externalId: string | null; detail: string }[]>([]);
  const libraryKey = (name: string) => ["mutation", `library.${name}`, brandId] as const;
  const recordPerf = useScopedMutation({
    mutationKey: libraryKey("performance"),
    mutationFn: (values: ManualPerformance) => recordPerformance({ data: { brandId, creativeId: traceId ?? "", ...values } }),
    // A performance row changes the creative's trace, the learning patterns, and the overview counts.
    invalidate: () => [qk.trace(brandId), qk.learning(brandId), qk.machine(brandId)],
    success: "Performance recorded.",
    onSuccess: () => {
      setNote("Performance stored and a learning job was queued. Scoring opportunities drains that job. No ad account is connected.");
      performanceForm.reset({ observedOn: "", platform: "", reach: "0", impressions: "0", clicks: "0", conversions: "0", spendCents: "0", revenueCents: "0" });
    },
  });
  const ownCreative = useScopedMutation({
    mutationKey: libraryKey("own-creative"),
    mutationFn: (values: ObservationFieldsOutput) => recordObservation({ data: { brandId, ...values } }),
    invalidate: () => [qk.library(brandId), qk.machine(brandId)],
    success: "Creative recorded.",
    onSuccess: () => {
      setNote("Creative recorded.");
      observationForm.reset();
    },
  });
  const pausedObjects = useScopedMutation({
    mutationKey: libraryKey("paused-publish"),
    mutationFn: (values: PausedPublishing) => publishPausedObjects({ data: { brandId, ...values } }),
    invalidate: () => [qk.library(brandId), qk.machine(brandId)],
    success: (_values, result) => result.detail,
    onSuccess: (result) => {
      setStages(result.stages);
      setNote(`${result.detail} Correlation ${result.correlationId}.`);
      publishForm.reset({ ...publishForm.getValues(), name: "" });
    },
  });
  const attachImage = useScopedMutation({
    mutationKey: libraryKey("attach-image"),
    mutationFn: (creativeId: string) => attachCreativeImage({ data: { brandId, creativeId } }),
    invalidate: () => [qk.library(brandId), qk.trace(brandId)],
    success: (_creativeId, image) => image.message,
    onSuccess: (image) => setNote(image.message),
  });
  const failures = [recordPerf, ownCreative, pausedObjects, attachImage].map((action) => action.error).filter((error): error is Error => Boolean(error));

  if (query.isError && !data) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading library" shape="rows" />;
  const canEdit = hasRole(data.role, "member");

  async function savePerformance(values: ManualPerformance) {
    await recordPerf.mutateAsync(values).catch(() => undefined);
  }

  async function saveOwnCreative(values: ObservationFieldsOutput) {
    await ownCreative.mutateAsync(values).catch(() => undefined);
  }
  async function savePausedObjects(values: PausedPublishing) {
    await pausedObjects.mutateAsync(values).catch(() => undefined);
  }
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
              onSubmit={performanceForm.handleSubmit(savePerformance)}
            >
              <Field label="Date" error={performanceForm.formState.errors.observedOn?.message}><TextInput {...performanceForm.register("observedOn")} type="date" required /></Field>
              <Field label="Platform" error={performanceForm.formState.errors.platform?.message}><TextInput {...performanceForm.register("platform")} maxLength={80} /></Field>
              <Field label="Reach" error={performanceForm.formState.errors.reach?.message}><TextInput {...performanceForm.register("reach")} type="text" inputMode="numeric" /></Field>
              <Field label="Impressions" error={performanceForm.formState.errors.impressions?.message}><TextInput {...performanceForm.register("impressions")} type="text" inputMode="numeric" required /></Field>
              <Field label="Clicks" error={performanceForm.formState.errors.clicks?.message}><TextInput {...performanceForm.register("clicks")} type="text" inputMode="numeric" required /></Field>
              <Field label="Conversions" error={performanceForm.formState.errors.conversions?.message}><TextInput {...performanceForm.register("conversions")} type="text" inputMode="numeric" required /></Field>
              <Field label="Spend (cents)" error={performanceForm.formState.errors.spendCents?.message}><TextInput {...performanceForm.register("spendCents")} type="text" inputMode="numeric" required /></Field>
              <Field label="Revenue (cents)" error={performanceForm.formState.errors.revenueCents?.message}><TextInput {...performanceForm.register("revenueCents")} type="text" inputMode="numeric" required /></Field>
              {performanceForm.formState.isDirty ? <div className="md:col-span-2 flex items-center justify-between rounded-md border border-warning bg-warning-soft p-3 text-sm" role="status"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => performanceForm.reset()}>Discard</Button></div> : null}
              <div className="md:col-span-2 flex flex-wrap gap-2">
                <Button type="submit" disabled={recordPerf.isPending || performanceForm.formState.isSubmitting}>Record performance</Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={attachImage.isPending}
                  onClick={() => {
                    void attachImage.mutateAsync(traceId).catch(() => undefined);
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
