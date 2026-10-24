import { useState } from "react";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, errorText, toast } from "@/components/ui";
import { previewContentFactoryRepurpose, startContentFactoryRepurpose } from "@/lib/meridian/content-factory/actions";
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

  // A change to the choice makes any earlier preview or plan out of date, so both are cleared.
  function change(next: Choice) {
    setChoice(next);
    setPreview(null);
    setRun(null);
    setProblem(null);
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
                  Each variation is a child cut of this video&rsquo;s master cut. The master is not changed. A rendered variation is stored as its own video. Review and publishing of a
                  repurposed video are not connected in this release, so a rendered variation has no approve or publish action here yet.
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
