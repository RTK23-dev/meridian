import { useState } from "react";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, errorText, Input, toast } from "@/components/ui";
import { checkContentFactoryRepurposeRender, getContentFactoryRepurposeOutput, listContentFactoryRepurposeReviews, previewContentFactoryRepurpose, reviewContentFactoryRepurposeVariant, startContentFactoryRepurpose, uploadContentFactoryRepurposeVariant, listContentFactoryPausedAdChoices, createContentFactoryPausedAd, listContentFactoryRepurposeFacebookPages, measureContentFactoryRepurposeRun, publishContentFactoryRepurposeToFacebook } from "@/lib/meridian/content-factory/actions";
import type { EngineMediaLinkResult } from "@/lib/meridian/storage/engine-media-link";
import type { RepurposeReviewState } from "@/lib/meridian/content-factory/repurpose-review";
import type { CreatePausedAdOutcome, PausedAdChoices } from "@/lib/meridian/content-factory/repurpose-paused-ad";
import type { OrganicPublishOutcome } from "@/lib/meridian/content-factory/repurpose-organic";
import type { RepurposeRunView, RepurposeVariationRow } from "@/lib/meridian/content-factory/repurpose";
import {
  CATEGORY_LABELS,
  MAX_REPURPOSE_VARIANTS,
  REPURPOSE_CATEGORIES,
  UNAVAILABLE_CAPABILITIES,
  optionsOf,
  type RepurposeCategory,
} from "@/engine/repurpose/catalog";

/** The intensity scale as the person reads it. Level 3 is the default. */
const INTENSITY_NAMES: Record<number, string> = { 1: "Light", 2: "Soft", 3: "Moderate", 4: "Strong", 5: "Full" };

const STATUS_LABELS: Record<RepurposeVariationRow["status"], string> = {
  planned: "Planned, not rendered",
  not_priced: "Not rendered: no verified render price",
  not_connected: "Not rendered: renderer not connected",
  rendering: "Rendering, or interrupted: not sent again",
  rendered: "Rendered",
  failed: "Render failed",
};

type CategoryChoice = { enabled: boolean; options: string[] };
type Choice = { enabled: boolean; intensity: number; variantCount: number; categories: Record<RepurposeCategory, CategoryChoice> };

/** The default choice: off, moderate, three variations, and every category that has an applicable option on with all of them. */
function defaultChoice(): Choice {
  const categories = Object.fromEntries(
    REPURPOSE_CATEGORIES.map((category) => {
      const available = optionsOf(category).filter((option) => option.availability.available);
      return [category, { enabled: available.length > 0, options: available.map((option) => option.id) }];
    }),
  ) as Record<RepurposeCategory, CategoryChoice>;
  return { enabled: false, intensity: 3, variantCount: 3, categories };
}

type PreviewOutcome = Awaited<ReturnType<typeof previewContentFactoryRepurpose>>;

export function RepurposePanel({ sessionId }: { sessionId: string }) {
  const [choice, setChoice] = useState<Choice>(defaultChoice);
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [run, setRun] = useState<RepurposeRunView | null>(null);
  const [busy, setBusy] = useState<"preview" | "plan" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, RepurposeReviewState>>({});

  // A change to the choice makes any earlier preview or plan out of date, so both are cleared.
  function change(next: Choice) {
    setChoice(next);
    setPreview(null);
    setRun(null);
    setReviews({});
    setProblem(null);
  }

  async function loadReviews(runId: string) {
    try {
      setReviews(await listContentFactoryRepurposeReviews({ data: { sessionId, runId } }));
    } catch (error) {
      setProblem(errorText(error));
    }
  }

  function setCategory(category: RepurposeCategory, next: CategoryChoice) {
    change({ ...choice, categories: { ...choice.categories, [category]: next } });
  }

  const settings = { enabled: choice.enabled, intensity: choice.intensity, variantCount: choice.variantCount, categories: choice.categories };
  const resolved = preview !== null && preview.status === "resolved";

  async function runPreview() {
    setBusy("preview");
    setProblem(null);
    setRun(null);
    try {
      const outcome = await previewContentFactoryRepurpose({ data: { sessionId, settings } });
      setPreview(outcome);
      if (outcome.status === "off") setProblem("Switch repurposing on to preview variations.");
      if (outcome.status === "refused") setProblem(outcome.reasons.join(" "));
    } catch (error) {
      setPreview(null);
      setProblem(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  async function plan() {
    setBusy("plan");
    setProblem(null);
    try {
      const result = await startContentFactoryRepurpose({ data: { sessionId, settings } });
      setRun(result);
      void loadReviews(result.runId);
      toast.success(result.created ? "The variations are planned." : "These variations were already planned.");
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card aria-labelledby="cf-repurpose-title">
      <CardHeader>
        <CardTitle id="cf-repurpose-title">Repurpose this video</CardTitle>
        <CardDescription>
          Make variations of this delivered video with deterministic visual treatments. No AI call is made for a treatment. Each variation is a
          child of this video. A variation is rendered only when the render price is verified and the renderer is connected.
        </CardDescription>
      </CardHeader>

      <div className="space-y-4 p-4">
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={choice.enabled} onChange={(event) => change({ ...choice, enabled: event.target.checked })} />
          Repurpose this video into variations
        </label>

        {choice.enabled ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="font-semibold">Intensity</span>
                <select
                  className="block min-h-11 w-full rounded-md border border-border bg-surface px-3"
                  value={choice.intensity}
                  aria-describedby="cf-repurpose-intensity-help"
                  onChange={(event) => change({ ...choice, intensity: Number(event.target.value) })}
                >
                  {[1, 2, 3, 4, 5].map((level) => (
                    <option key={level} value={level}>{`${level} · ${INTENSITY_NAMES[level]}`}</option>
                  ))}
                </select>
                <span id="cf-repurpose-intensity-help" className="block text-xs text-muted">Level 3 (Moderate) is the default. Each treatment is scaled to this level.</span>
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-semibold">Variations</span>
                <select
                  className="block min-h-11 w-full rounded-md border border-border bg-surface px-3"
                  value={choice.variantCount}
                  aria-describedby="cf-repurpose-count-help"
                  onChange={(event) => change({ ...choice, variantCount: Number(event.target.value) })}
                >
                  {Array.from({ length: MAX_REPURPOSE_VARIANTS }, (_, index) => index + 1).map((count) => (
                    <option key={count} value={count}>{count}</option>
                  ))}
                </select>
                <span id="cf-repurpose-count-help" className="block text-xs text-muted">At most {MAX_REPURPOSE_VARIANTS}. Each variation takes one option from each category that is on.</span>
              </label>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Treatments</h3>
              {REPURPOSE_CATEGORIES.map((category) => {
                const options = optionsOf(category);
                const applicable = options.filter((option) => option.availability.available);
                const chosen = choice.categories[category];
                const unavailableReason = applicable.length === 0 ? options.map((option) => (option.availability.available ? "" : option.availability.reason)).join(" ").trim() : null;
                return (
                  <details key={category} className="rounded-md border border-border p-3" open={category === "warp_rotation"}>
                    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm font-semibold">
                      <span>{CATEGORY_LABELS[category]}</span>
                      <span className="text-xs font-normal text-muted">
                        {unavailableReason !== null ? "Unavailable" : chosen.enabled ? `${chosen.options.length} selected` : "Off"}
                      </span>
                    </summary>
                    {unavailableReason !== null ? (
                      <p className="mt-2 text-sm text-muted">{unavailableReason}</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <label className="flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={chosen.enabled}
                            onChange={(event) => setCategory(category, { ...chosen, enabled: event.target.checked })}
                          />
                          Use {CATEGORY_LABELS[category]} in each variation
                        </label>
                        <fieldset className="space-y-1" disabled={!chosen.enabled}>
                          <legend className="text-xs text-muted">Options in the pool</legend>
                          {applicable.map((option) => (
                            <label key={option.id} className="flex min-h-11 items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={chosen.options.includes(option.id)}
                                onChange={(event) =>
                                  setCategory(category, {
                                    ...chosen,
                                    options: event.target.checked
                                      ? [...chosen.options, option.id]
                                      : chosen.options.filter((id) => id !== option.id),
                                  })
                                }
                              />
                              {option.label}
                            </label>
                          ))}
                        </fieldset>
                      </div>
                    )}
                  </details>
                );
              })}
            </div>

            <div className="space-y-1 text-sm">
              <h3 className="font-semibold">Not offered in this release</h3>
              <ul className="space-y-1">
                {UNAVAILABLE_CAPABILITIES.map((capability) => (
                  <li key={capability.id} className="text-muted">
                    <span className="font-semibold text-fg">{capability.label}:</span> {capability.reason}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" loading={busy === "preview"} disabled={busy !== null} onClick={() => void runPreview()}>
                Preview variations
              </Button>
              <Button type="button" loading={busy === "plan"} disabled={busy !== null || !resolved} onClick={() => void plan()}>
                Plan variations
              </Button>
            </div>

            {problem !== null ? <p role="alert" className="text-sm text-danger">{problem}</p> : null}

            {preview !== null && preview.status === "resolved" && run === null ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Variations to plan</h3>
                {preview.reasons.map((reason) => (
                  <p key={reason} className="text-sm text-muted">{reason}</p>
                ))}
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {preview.variations.map((variation) => (
                    <li key={variation.key}>{variation.treatments.map((treatment) => treatment.label).join(" · ")}</li>
                  ))}
                </ol>
              </div>
            ) : null}

            {run !== null ? (
              <div className="space-y-2" aria-live="polite">
                <h3 className="text-sm font-semibold">Variations</h3>
                <p className="text-sm text-muted">
                  {run.decision.outcome === "not_consulted"
                    ? "Decision check: not consulted. No decision engine answered for this workspace, so the plan is the deterministic one."
                    : run.decision.outcome === "review"
                      ? "Decision check: sent to review. Uncalibrated scores never approve or block a plan, so this is a note, not a gate."
                      : run.decision.outcome === "approved"
                        ? "Decision check: approved."
                        : "Decision check: rejected."}
                </p>
                <p className="text-sm text-muted">
                  Each variation is a child cut of this video&rsquo;s master cut. The master is not changed. A rendered variation is stored as its own video. A reviewer can approve or
                  reject a rendered variation. Variations are not ranked: the brand-fit check reads only the treatment names, so it cannot
                  tell rendered variations apart.
                </p>
                <p className="text-sm text-muted">
                  Publishing, measurement and learning for a repurposed variation are not built. A variation is not a library creative yet,
                  so it cannot reach the publishing queue, and no publishing account can receive it until it is.
                </p>
                <ol className="space-y-2 text-sm">
                  {run.variations.map((variation) => (
                    <li key={variation.key} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">Variation {variation.ordinal + 1}</span>
                        <Badge>{STATUS_LABELS[variation.status]}</Badge>
                      </div>
                      <p className="text-muted">{variation.treatments.map((treatment) => treatment.label).join(" · ")}</p>
                      {variation.reason !== "" ? <p className="text-xs text-muted">{variation.reason}</p> : null}
                      {variation.status === "rendered" ? <p className="text-xs text-muted">{brandFitLine(variation.decision.outcome)}</p> : null}
                      {variation.status === "rendered" ? <OpenOutput sessionId={sessionId} runId={run.runId} variantKey={variation.key} /> : null}
                      {variation.status === "rendered" ? <UploadToMeta sessionId={sessionId} runId={run.runId} variantKey={variation.key} /> : null}
                      {variation.status === "rendered" ? <PausedAd sessionId={sessionId} runId={run.runId} variantKey={variation.key} /> : null}
                      {variation.status === "rendered" ? <OrganicPost sessionId={sessionId} runId={run.runId} variantKey={variation.key} /> : null}
                      {variation.status === "rendering" ? <CheckRenderer sessionId={sessionId} runId={run.runId} variantKey={variation.key} /> : null}
                      {variation.status === "rendered" ? (
                        <ReviewVariation
                          sessionId={sessionId}
                          runId={run.runId}
                          variantKey={variation.key}
                          state={reviews[variation.key] ?? { status: "not_decided" }}
                          onChanged={() => void loadReviews(run.runId)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The brand-fit check on one rendered variation, in words. It is advisory: an uncalibrated score never approves or blocks a variation, and
 * the reviewer decides. A variation rendered before the check existed, or with no engine, says that it was not consulted.
 */
function brandFitLine(outcome: "approved" | "review" | "rejected" | "not_consulted"): string {
  if (outcome === "approved") return "Brand-fit check: approved. A note for the reviewer, not a decision.";
  if (outcome === "review") return "Brand-fit check: sent to review. A note for the reviewer. Uncalibrated scores never approve or block a variation.";
  if (outcome === "rejected") return "Brand-fit check: rejected. A note for the reviewer. It blocks nothing.";
  return "Brand-fit check: not consulted. No decision engine answered for this variation.";
}

/**
 * Uploads a rendered, approved variation's video to the brand's Meta ad account. Admins only. It uploads the video and nothing more: no post
 * or ad is created from it. The server says why nothing was sent, and the message names that reason.
 */
function UploadToMeta({ sessionId, runId, variantKey }: { sessionId: string; runId: string; variantKey: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function upload() {
    setBusy(true);
    try {
      const outcome = await uploadContentFactoryRepurposeVariant({ data: { sessionId, runId, variantKey } });
      if (outcome.status === "uploaded") setMessage("Uploaded to the Meta ad account, and Meta's video id is recorded. No post or ad was created.");
      else if (outcome.status === "already_uploaded") setMessage("Already uploaded to this ad account. Nothing was sent again.");
      else if (outcome.status === "blocked") setMessage(outcome.reason);
      else setMessage(outcome.error);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <Button type="button" variant="secondary" loading={busy} disabled={busy} onClick={() => void upload()}>
        Upload to the Meta ad account
      </Button>
      {message !== null ? <p role="status" className="text-sm text-muted">{message}</p> : null}
    </div>
  );
}

/** The outcome of a paused-ad request, in words. A paused ad is not an active one, and the message says so. */
function pausedAdMessage(outcome: CreatePausedAdOutcome): string {
  switch (outcome.status) {
    case "created_paused":
      return "Created a PAUSED ad and confirmed it in Meta. It is not active, and nothing has been switched on.";
    case "already_created":
      if (!outcome.bindingMatches) {
        return outcome.reconciled
          ? "Found the paused ad from an earlier attempt and confirmed it in Meta. The inputs you entered differ from that attempt, so the original inputs were kept and nothing was created."
          : "This variation already has a paused ad in this ad account. The inputs you entered differ from it, so nothing was changed.";
      }
      return outcome.reconciled
        ? "Found the paused ad from an earlier attempt and confirmed it in Meta. Nothing was created again."
        : "This variation already has a paused ad in this ad account. Nothing was created again.";
    case "blocked":
    case "in_progress":
    case "conflict":
    case "refused":
      return outcome.reason;
    case "uncertain":
      return `${outcome.reason} Press the button again to reconcile it: Meridian searches the ad account by name before it creates anything.`;
    case "absent":
      return `${outcome.reason} If you start a new attempt, it uses the same inputs and is sent once.`;
    case "unexpected":
      return `${outcome.reason} Meridian never switches an ad on or off.`;
  }
}

/**
 * Creates one PAUSED Meta ad from this uploaded variation, inside an ad set the person chooses and then chooses again to confirm. The
 * server checks everything again. Nothing is activated, and the page says so before the button is pressed.
 */
function PausedAd({ sessionId, runId, variantKey }: { sessionId: string; runId: string; variantKey: string }) {
  const [choices, setChoices] = useState<PausedAdChoices | null>(null);
  const [adSetId, setAdSetId] = useState("");
  const [confirmAdSetId, setConfirmAdSetId] = useState("");
  const [pageId, setPageId] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Offered only after a complete search found no ad. Its confirmation is what lets the server start a new attempt.
  const [absentConfirmable, setAbsentConfirmable] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setChoices(await listContentFactoryPausedAdChoices({ data: { sessionId } }));
    } catch (error) {
      setChoices({ status: "failed", error: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  const ready = adSetId !== "" && confirmAdSetId === adSetId && pageId !== "" && destinationUrl.trim() !== "";
  async function create(confirmRetryAfterAbsence: boolean) {
    setBusy(true);
    try {
      const outcome = await createContentFactoryPausedAd({ data: { sessionId, runId, variantKey, adSetId, confirmAdSetId, pageId, destinationUrl, message, confirmRetryAfterAbsence } });
      setAbsentConfirmable(outcome.status === "absent");
      setNote(pausedAdMessage(outcome));
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted">
        Create a paused Meta ad from this video. The ad is paused and nothing is switched on. Choose the ad set, then choose it again to confirm.
      </p>
      <Button type="button" variant="secondary" loading={busy} disabled={busy} onClick={() => void load()}>
        Load ad sets and Pages
      </Button>
      {choices?.status === "blocked" || choices?.status === "failed" ? <p role="status" className="text-sm text-muted">{choices.status === "blocked" ? choices.reason : choices.error}</p> : null}
      {choices?.status === "listed" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Ad set
            <select className="block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm" value={adSetId} onChange={(event) => setAdSetId(event.target.value)}>
              <option value="">Choose an ad set</option>
              {choices.adSets.map((set) => <option key={set.id} value={set.id}>{set.name} ({set.status})</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Confirm the ad set
            <select className="block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm" value={confirmAdSetId} onChange={(event) => setConfirmAdSetId(event.target.value)}>
              <option value="">Choose the same ad set again</option>
              {choices.adSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Facebook Page
            <select className="block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm" value={pageId} onChange={(event) => setPageId(event.target.value)}>
              <option value="">Choose a Page</option>
              {choices.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Destination link (https)
            <Input value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} placeholder="https://" />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            Ad text
            <textarea className="block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="button" loading={busy} disabled={busy || !ready} onClick={() => void create(false)}>
              Create a paused ad in this ad set
            </Button>
            {absentConfirmable ? (
              <Button type="button" variant="secondary" loading={busy} disabled={busy || !ready} onClick={() => void create(true)}>
                Start a new attempt with these inputs
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {note !== null ? <p role="status" className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}

/** A short-lived link to a rendered variation's video. The server signs it only for a variation recorded as rendered, and says why when it cannot. */
function OpenOutput({ sessionId, runId, variantKey }: { sessionId: string; runId: string; variantKey: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EngineMediaLinkResult | null>(null);
  async function open() {
    setBusy(true);
    try {
      setResult(await getContentFactoryRepurposeOutput({ data: { sessionId, runId, variantKey } }));
    } catch (error) {
      setResult({ status: "refused", reason: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <Button type="button" variant="secondary" loading={busy} disabled={busy} onClick={() => void open()}>
        Open the rendered video
      </Button>
      {result?.status === "ok" ? (
        <p className="text-sm">
          <a className="underline" href={result.url} target="_blank" rel="noopener noreferrer">Open the video in a new tab</a>. The link lasts 15 minutes.
        </p>
      ) : null}
      {result !== null && result.status !== "ok" ? <p role="status" className="text-sm text-muted">{result.reason}</p> : null}
    </div>
  );
}

/** A reviewer's decision on one rendered variation. An approval the rights gate blocks says why; a rejection needs its reason. */
function ReviewVariation({
  sessionId,
  runId,
  variantKey,
  state,
  onChanged,
}: {
  sessionId: string;
  runId: string;
  variantKey: string;
  state: RepurposeReviewState;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rejectReady = reason.trim().length >= 10;
  async function decide(decision: "approved" | "rejected") {
    setBusy(decision);
    setProblem(null);
    try {
      await reviewContentFactoryRepurposeVariant({ data: { sessionId, runId, variantKey, decision, reason } });
      toast.success(decision === "approved" ? "The variation is approved." : "The variation is rejected.");
      setReason("");
      onChanged();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  const current = state.status === "not_decided" ? "Not decided" : state.status === "approved" ? "Approved" : "Rejected";
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <p className="text-sm">
        <span className="font-semibold">Review:</span> {current}
        {state.status !== "not_decided" && state.reason ? ` · ${state.reason}` : ""}
      </p>
      <Input label="Reason or note" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" loading={busy === "approved"} disabled={busy !== null} onClick={() => void decide("approved")}>
          Approve variation
        </Button>
        <Button type="button" variant="quiet" loading={busy === "rejected"} disabled={busy !== null || !rejectReady} onClick={() => void decide("rejected")}>
          Reject variation
        </Button>
      </div>
      {!rejectReady ? <p className="text-xs text-muted">A rejection needs a reason of at least 10 characters.</p> : null}
      {problem !== null ? <p role="alert" className="text-sm text-danger">{problem}</p> : null}
    </div>
  );
}

/** Asks the renderer what it reports for an interrupted cut. It settles nothing and retries nothing: the cut stays in rendering. */
function CheckRenderer({ sessionId, runId, variantKey }: { sessionId: string; runId: string; variantKey: string }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  async function check() {
    setBusy(true);
    try {
      const outcome = await checkContentFactoryRepurposeRender({ data: { sessionId, runId, variantKey } });
      setReport(outcome.reason);
    } catch (error) {
      setReport(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <Button type="button" variant="quiet" loading={busy} disabled={busy} onClick={() => void check()}>
        Check with the renderer
      </Button>
      {report !== null ? <p role="status" className="text-sm text-muted">{report}</p> : null}
    </div>
  );
}

type FacebookPages = { pages: { id: string; name: string }[]; connectedPageId: string | null; connectedReason: string | null };

/** The outcome of an organic publish, in words. Only a published post names a post, and an uncertain one says what to check before a retry. */
function organicMessage(outcome: OrganicPublishOutcome): string {
  switch (outcome.status) {
    case "published":
      return "Published to the Facebook Page as an organic post. Its measurements count only when Meta reports them.";
    case "already_published":
      return "This variation was already published to this Page. Nothing was posted again.";
    case "in_progress":
    case "blocked":
    case "refused":
      return outcome.reason;
    case "uncertain":
      return `${outcome.reason} Check the Page in Facebook before you post again.`;
  }
}

/**
 * Publishes this rendered variation to one Facebook Page as an organic video post. It is a separate, explicit action: approval, upload and
 * the paused ad never publish. The Page is the person's choice, and the server requires it to be the Page this workspace connected.
 */
function OrganicPost({ sessionId, runId, variantKey }: { sessionId: string; runId: string; variantKey: string }) {
  const [pages, setPages] = useState<FacebookPages | null>(null);
  const [pageId, setPageId] = useState("");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [offerRetry, setOfferRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    try {
      setPages(await listContentFactoryRepurposeFacebookPages({ data: { sessionId } }));
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function measure() {
    setBusy(true);
    try {
      const result = await measureContentFactoryRepurposeRun({ data: { sessionId, runId } });
      const reasons = result.reasons.slice(0, 2).join(" ");
      setNote(`Read this run from Facebook: ${result.organicRows} new observation(s), ${result.duplicates} already stored, ${result.notReported} not reported.${reasons ? ` ${reasons}` : ""}`);
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    try {
      const outcome = await publishContentFactoryRepurposeToFacebook({ data: { sessionId, runId, variantKey, pageId, title, caption, confirmRetry } });
      setOfferRetry(outcome.status === "uncertain");
      setConfirmRetry(false);
      setNote(organicMessage(outcome));
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const ready = pageId !== "" && (!offerRetry || confirmRetry);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted">
        Publish this video to a Facebook Page as an organic post. Approval, upload and the paused ad never publish it: only this action does.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" loading={busy} disabled={busy} onClick={() => void load()}>
          Load Facebook Pages
        </Button>
        <Button type="button" variant="ghost" loading={busy} disabled={busy} onClick={() => void measure()}>
          Read this run&apos;s Facebook metrics
        </Button>
      </div>
      {pages?.connectedReason ? <p role="status" className="text-sm text-muted">{pages.connectedReason}</p> : null}
      {pages && pages.pages.length === 0 ? <p role="status" className="text-sm text-muted">No Facebook Page is saved for this brand. Save one on Connected accounts first.</p> : null}
      {pages && pages.pages.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Facebook Page
            <select className="block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm" value={pageId} onChange={(event) => setPageId(event.target.value)}>
              <option value="">Choose a Page</option>
              {pages.pages.map((page) => (
                <option key={page.id} value={page.id}>{page.name}{page.id === pages.connectedPageId ? " (connected)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Title
            <Input value={title} maxLength={255} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            Caption
            <textarea className="block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm" rows={3} maxLength={2200} value={caption} onChange={(event) => setCaption(event.target.value)} />
          </label>
          {offerRetry ? (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={confirmRetry} onChange={(event) => setConfirmRetry(event.target.checked)} />
              I checked this Page in Facebook, and I want to post this video again.
            </label>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="button" loading={busy} disabled={busy || !ready} onClick={() => void publish()}>
              Publish to this Facebook Page
            </Button>
          </div>
        </div>
      ) : null}
      {note !== null ? <p role="status" className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}
