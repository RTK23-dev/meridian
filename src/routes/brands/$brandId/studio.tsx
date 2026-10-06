import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Authed, useBusy } from "@/components/gate";
import { Button, Field, Notice, Panel, SelectInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import {
  generateStudioVariants,
  getStudioSession,
  openStudioBrief,
  publishStudioVariant,
  recordStudioTestPerformance,
  reviewStudioVariant,
} from "@/lib/meridian/studio/actions";

type StudioSession = Awaited<ReturnType<typeof getStudioSession>>;

export const Route = createFileRoute("/brands/$brandId/studio")({ component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <Studio brandId={brandId} />
    </Authed>
  );
}

function Studio({ brandId }: { brandId: string }) {
  const [session, setSession] = useState<StudioSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const busy = useBusy();

  useEffect(() => {
    let cancelled = false;
    getStudioSession({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!session) return <p className="text-muted" role="status">Loading studio…</p>;
  const canEdit = hasRole(session.role, "member");
  const brief = session.briefs.find((item) => item.status === "ready") ?? session.brief;
  const previous = session.briefs[1];
  const changed = Boolean(brief && previous && brief.constraints !== previous.constraints);
  const recommendation = session.recommendation;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Studio</p>
          <h1 className="font-display text-3xl">Make the next ads from evidence</h1>
        </div>
        <p className="max-w-md text-sm text-muted">
          {session.observationCount} competitor observations. Image and video appear only after a provider stores bytes.
        </p>
      </div>
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      {busy.pending ? <p className="text-sm" role="status" aria-live="polite">Working. This screen keeps the last stored result until the step finishes.</p> : null}
      {recommendation ? (
        <Panel>
          <p className="text-xs font-semibold uppercase tracking-widest text-brass">Discovered · {recommendation.posture === "exploitation" ? "Exploitation" : "Exploration"} · {recommendation.angle}</p>
          <h2 className="mt-2 font-display text-3xl">{recommendation.label}</h2>
          <p className="mt-3">{recommendation.reason}</p>
          <p className="mt-2 text-sm">{recommendation.because}</p>
          <p className="mt-2 text-sm text-muted">{recommendation.uncertainty}</p>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Market density</dt><dd>{recommendation.marketSignal.toFixed(2)} signal, {recommendation.saturation.toFixed(2)} saturation</dd></div>
            <div><dt className="text-muted">Brand fit</dt><dd>{recommendation.brandFit.toFixed(2)}</dd></div>
            <div><dt className="text-muted">Novelty</dt><dd>{recommendation.novelty.toFixed(2)}</dd></div>
            <div><dt className="text-muted">Historical learning</dt><dd>{recommendation.historicalEvidence.toFixed(2)}</dd></div>
            <div><dt className="text-muted">Rank</dt><dd>{recommendation.expectedValue.toFixed(2)}</dd></div>
            <div><dt className="text-muted">JEV</dt><dd>{recommendation.decision || "Not stored yet"} {recommendation.decision ? recommendation.probability.toFixed(2) : ""}</dd></div>
          </dl>
          <ul className="mt-4 space-y-2 text-sm">
            {recommendation.evidence.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {canEdit ? (
            <Button
              className="mt-4"
              type="button"
              disabled={busy.pending}
              onClick={() => {
                void busy.run(async () => {
                  setSession(await openStudioBrief({ data: { brandId, forceNew: false } }));
                });
              }}
            >
              Accept direction and write the brief
            </Button>
          ) : null}
        </Panel>
      ) : (
        <Panel>
          <h2 className="font-display text-2xl">No discovered opportunity</h2>
          <p className="mt-2 text-sm text-muted">
            {session.observationCount === 0
              ? "Add competitor ads you have seen. An empty library is not whitespace."
              : "Stored creatives do not yet show a direction outside the exploration seeds. Nothing was invented."}
          </p>
        </Panel>
      )}
      {session.exploration ? (
        <p className="text-sm text-muted">Exploration, not a finding: {session.exploration.label}. {session.exploration.reason}</p>
      ) : null}
      {session.semantic.clusters.length > 0 ? (
        <Panel>
          <h2 className="font-display text-2xl">Semantic clusters</h2>
          <p className="mt-2 text-sm text-muted">{session.semantic.note}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {session.semantic.clusters.map((cluster) => <li key={cluster.label}>{cluster.summary}</li>)}
          </ul>
        </Panel>
      ) : (
        <p className="text-sm text-muted">{session.semantic.note}</p>
      )}
      {session.whitespace.length > 0 ? (
        <Panel>
          <h2 className="font-display text-2xl">Whitespace in the stored set</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {session.whitespace.map((item) => <li key={item.underused}>{item.whyTest}</li>)}
          </ul>
        </Panel>
      ) : null}
      {brief ? (
        <Panel>
          <h2 className="font-display text-2xl">Brief</h2>
          <p className="mt-1 text-sm text-muted">{brief.title}</p>
          {changed ? <p className="mt-2 text-sm font-semibold">These findings changed the next recommendation.</p> : null}
          <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
            <div><dt className="text-muted">Objective</dt><dd>{brief.why[0]}</dd></div>
            <div><dt className="text-muted">Audience</dt><dd>{brief.audience || "Not stored."}</dd></div>
            <div><dt className="text-muted">Angle</dt><dd>{brief.angle}</dd></div>
            <div><dt className="text-muted">Hook</dt><dd>{brief.hook}</dd></div>
            <div><dt className="text-muted">Promise</dt><dd>{brief.promise || "Not stored."}</dd></div>
            <div><dt className="text-muted">Proof</dt><dd>{brief.proofType || "Not stored."}</dd></div>
            <div><dt className="text-muted">Offer</dt><dd>{brief.offer || "None stored."}</dd></div>
            <div><dt className="text-muted">Call to action</dt><dd>{brief.cta}</dd></div>
            <div><dt className="text-muted">Format</dt><dd>{brief.format}</dd></div>
          </dl>
          <h3 className="mt-4 font-semibold">Why this, why now</h3>
          <ul className="mt-2 space-y-1 text-sm">{brief.why.map((line) => <li key={line}>{line}</li>)}</ul>
          <h3 className="mt-4 font-semibold">Visual direction</h3>
          <p className="mt-2 text-sm">{brief.format}. Proof: {brief.proofType || "Not stored."}</p>
          <h3 className="mt-4 font-semibold">What not to do</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm" data-testid="brief-constraints">{brief.constraints || "No stored constraint."}</p>
          <h3 className="mt-4 font-semibold">Learned positives</h3>
          {session.learned.some((pattern) => pattern.direction === "POSITIVE") ? (
            <ul className="mt-2 text-sm">{session.learned.filter((pattern) => pattern.direction === "POSITIVE").map((pattern) => <li key={`${pattern.attribute}:${pattern.value}:up`}>POSITIVE · {pattern.summary}</li>)}</ul>
          ) : <p className="mt-2 text-sm text-muted">No positive pattern is stored.</p>}
          <h3 className="mt-4 font-semibold">Learned negatives</h3>
          {session.learned.some((pattern) => pattern.direction === "NEGATIVE") ? (
            <ul className="mt-2 text-sm">{session.learned.filter((pattern) => pattern.direction === "NEGATIVE").map((pattern) => <li key={`${pattern.attribute}:${pattern.value}:down`}>NEGATIVE · {pattern.summary}</li>)}</ul>
          ) : <p className="mt-2 text-sm text-muted">No negative pattern is stored.</p>}
          {session.rejections.length > 0 ? (
            <>
              <h3 className="mt-4 font-semibold">Rejected directions</h3>
              <ul className="mt-2 text-sm">{session.rejections.map((line) => <li key={line}>{line}</li>)}</ul>
            </>
          ) : null}
          {brief.learningNotes.length > 0 ? (
            <ul className="mt-3 text-sm">{brief.learningNotes.map((line) => <li key={line}>Learned: {line}</li>)}</ul>
          ) : <p className="mt-3 text-sm text-muted">No learned pattern is attached to this brief yet.</p>}
          {canEdit ? (
            <form
              className="mt-4 grid gap-3 md:grid-cols-2"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void busy.run(async () => {
                  setSession(await generateStudioVariants({
                    data: {
                      brandId,
                      briefId: brief.id,
                      imageProvider: String(form.get("imageProvider") ?? ""),
                      videoProvider: String(form.get("videoProvider") ?? ""),
                    },
                  }));
                });
              }}
            >
              <Field label="Image provider" hint="test:image is not a live account. xai:image runs only when that key can return bytes.">
                <SelectInput name="imageProvider" defaultValue="" required>
                  <option value="" disabled>Choose</option>
                  <option value="test:image">test:image</option>
                  <option value="xai:image">xai:image</option>
                </SelectInput>
              </Field>
              <Field label="Video provider" hint="test:video is a fixture. xai:video stores a clip only after xAI returns one.">
                <SelectInput name="videoProvider" defaultValue="" required>
                  <option value="" disabled>Choose</option>
                  <option value="test:video">test:video</option>
                  <option value="xai:video">xai:video</option>
                </SelectInput>
              </Field>
              <div className="md:col-span-2">
                <Button type="submit" disabled={busy.pending || brief.status !== "ready"}>Generate 3 image + 3 video variants</Button>
                <p className="mt-2 text-sm text-muted">Estimated generation cost is not shown until a provider returns one. A run is blocked when the daily or concurrency limit is already used.</p>
              </div>
            </form>
          ) : null}
          {canEdit && brief.status !== "ready" ? (
            <Button
              className="mt-3"
              type="button"
              variant="quiet"
              disabled={busy.pending}
              onClick={() => {
                void busy.run(async () => {
                  setSession(await openStudioBrief({ data: { brandId, forceNew: true } }));
                });
              }}
            >
              Write the next brief
            </Button>
          ) : null}
        </Panel>
      ) : null}
      <section className="space-y-4" aria-label="Variants">
        <h2 className="font-display text-2xl">Variants</h2>
        {session.variants.length === 0 ? <p className="text-sm text-muted">No media yet.</p> : null}
        <ul className="grid gap-4 lg:grid-cols-2">
          {session.variants.map((variant) => (
            <li key={variant.assetId} className="rounded-lg border border-line bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">{variant.kind} {variant.index + 1} · {variant.provider || "no provider"}</p>
              <h3 className="font-display text-xl">{variant.title}</h3>
              {variant.preview ? <img className="mt-3 h-24 w-24 border border-line" src={variant.preview} alt={`${variant.provider} ${variant.kind} variant ${variant.index + 1}`} /> : null}
              {variant.frames.length > 0 ? (
                <div className="mt-3 flex gap-2">
                  {variant.frames.map((src, index) => (
                    <img key={`${variant.assetId}-frame-${index}`} className="h-16 w-16 border border-line" src={src} alt={`Sampled frame ${index + 1} from the stored ${variant.kind} bytes`} />
                  ))}
                </div>
              ) : null}
              {variant.kind === "video" ? (
                <p className="mt-3 text-sm" role="status">
                  {variant.provider === "test:video" ? "Fixture, not a camera recording. " : ""}
                  {variant.mediaStatus || "queued"}. {variant.durationMs ? `${(variant.durationMs / 1000).toFixed(1)}s. ` : "Duration not stored. "}
                  {variant.width ? `${variant.width}×${variant.height}. ` : "Dimensions not stored. "}
                  {variant.transcript || "No transcript stored. "}
                  {variant.scenes[0]?.summary ?? "No scene note stored."}
                </p>
              ) : null}
              <p className="mt-2 text-sm text-muted">
                {variant.model} · {variant.promptVersion} · {variant.byteSize || 0} bytes
                {variant.width ? ` · ${variant.width}×${variant.height}` : ""}
                {variant.checksum ? ` · ${variant.checksum.slice(0, 8)}` : ""}
              </p>
              <p className="text-sm">QA {variant.qaDecision || "pending"} · review {variant.reviewStatus} · {variant.creativeStatus}</p>
              {variant.error ? <p className="text-sm text-danger">{variant.error}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="quiet" aria-expanded={inspectId === variant.creativeId} onClick={() => setInspectId(inspectId === variant.creativeId ? null : variant.creativeId)}>
                  Inspect evidence
                </Button>
                {canEdit && variant.creativeStatus === "in_review" ? (
                  <>
                    <Button type="button" disabled={busy.pending} onClick={() => { void busy.run(async () => setSession(await reviewStudioVariant({ data: { brandId, creativeId: variant.creativeId, action: "approve", reasonCode: "", note: "" } }))); }}>Approve</Button>
                    <Button type="button" variant="danger" disabled={busy.pending} onClick={() => { void busy.run(async () => setSession(await reviewStudioVariant({ data: { brandId, creativeId: variant.creativeId, action: "reject", reasonCode: "too_similar", note: "Does not earn the angle." } }))); }}>Reject</Button>
                    <Button type="button" variant="quiet" disabled={busy.pending} onClick={() => { void busy.run(async () => setSession(await reviewStudioVariant({ data: { brandId, creativeId: variant.creativeId, action: "revision", reasonCode: "", note: "Revise the opening. Keep the product." } }))); }}>Request revision</Button>
                  </>
                ) : null}
                {canEdit && (variant.creativeStatus === "approved" || variant.creativeStatus === "testing") ? (
                  <Button type="button" disabled={busy.pending} onClick={() => { void busy.run(async () => setSession(await publishStudioVariant({ data: { brandId, creativeId: variant.creativeId, publisher: "test" } }))); }}>
                    Publish with test publisher
                  </Button>
                ) : null}
              </div>
              {inspectId === variant.creativeId ? (
                <ul className="mt-3 space-y-2 text-sm">
                  {variant.questions.length === 0 ? <li>No JEV row is stored for this variant.</li> : variant.questions.map((question) => (
                    <li key={question.id}>
                      <span className="font-semibold">{question.id}</span> {question.decision} · answer {question.answer || "unrecorded"} · p {question.probability.toFixed(2)} · confidence {question.confidence.toFixed(2)}
                      <span className="block text-muted">{question.reasons[0]}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        {session.variants.length > 1 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Compare">
              <SelectInput aria-label="Compare" value={compareA} onChange={(event) => setCompareA(event.target.value)}>
                <option value="">First variant</option>
                {session.variants.map((variant) => <option key={variant.assetId} value={variant.assetId}>{variant.kind} {variant.index + 1}</option>)}
              </SelectInput>
            </Field>
            <Field label="With">
              <SelectInput aria-label="With" value={compareB} onChange={(event) => setCompareB(event.target.value)}>
                <option value="">Second variant</option>
                {session.variants.map((variant) => <option key={variant.assetId} value={variant.assetId}>{variant.kind} {variant.index + 1}</option>)}
              </SelectInput>
            </Field>
            {compareA && compareB ? (
              <p className="md:col-span-2 text-sm">
                {session.variants.find((item) => item.assetId === compareA)?.promptVersion} beside {session.variants.find((item) => item.assetId === compareB)?.promptVersion}. They stay separate versions.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      <Panel>
        <h2 className="font-display text-2xl">What Meridian learned</h2>
        {session.learned.length === 0 ? <p className="mt-2 text-sm text-muted">No pattern has met the sample rule.</p> : (
          <ul className="mt-3 space-y-2 text-sm">
            {session.learned.map((pattern) => (
              <li key={`${pattern.attribute}:${pattern.value}`}>
                {pattern.direction} · {pattern.state} · n={pattern.sampleSize} · {pattern.impressions} impressions · {pattern.summary}
              </li>
            ))}
          </ul>
        )}
        {session.publications.length > 0 ? (
          <ul className="mt-3 text-sm">
            {session.publications.map((item) => <li key={item.externalId}>Test publication {item.externalId}</li>)}
          </ul>
        ) : <p className="mt-3 text-sm text-muted">Nothing from this brand has a stored publisher id.</p>}
        {canEdit ? (
          <Button
            className="mt-4"
            type="button"
            disabled={busy.pending || session.publications.length === 0}
            onClick={() => {
              void busy.run(async () => {
                setSession(await recordStudioTestPerformance({ data: { brandId } }));
              });
            }}
          >
            Record test-provider performance and learn
          </Button>
        ) : null}
      </Panel>
    </div>
  );
}
