import { Controller, type UseFormReturn } from "react-hook-form";
import { Button, Field, Input, Panel, SelectInput } from "@/components/ui";
import type { StudioGeneration } from "@/lib/meridian/schemas/studio-generation";
import { DAILY_GENERATION_LIMIT, GENERATION_CONCURRENCY } from "@/lib/meridian/security/budget";
import { imageProviderCards, videoProviderCards, type ProductionStatus } from "./provider-options.ts";
import { ProviderCardGroup } from "./provider-cards.tsx";
import { UsageMeter } from "./usage-meter.tsx";
import type { StudioBrief } from "./types.ts";

type GenerateStepProps = {
  brief: StudioBrief | null;
  canEdit: boolean;
  form: UseFormReturn<StudioGeneration>;
  testImageAllowed: boolean;
  production: ProductionStatus;
  pending: boolean;
  retryNotice: string | null;
  onDismissRetry: () => void;
  onGenerate: (values: StudioGeneration) => void;
};

/**
 * Step 3. The generation form. Image and video are chosen from provider cards that show their connection state; a card that
 * is not connected is disabled with its reason. Fields and hints are the ones the form has always had.
 */
export function GenerateStep({ brief, canEdit, form, testImageAllowed, production, pending, retryNotice, onDismissRetry, onGenerate }: GenerateStepProps) {
  const imageCards = imageProviderCards({ testImageAllowed, production });
  const videoCards = videoProviderCards({ production });
  const errors = form.formState.errors;
  const dirty = form.formState.isDirty;

  return (
    <Panel>
      <h2 className="font-display text-2xl">Generate from the approved brief</h2>
      {brief ? (
        <p className="mt-2 text-sm text-fg-muted">Current brief: {brief.title}. A brief that is not ready cannot be used for generation.</p>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">Write or accept a brief before generating.</p>
      )}

      {retryNotice ? (
        <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent bg-accent-soft p-3 text-sm">
          <span>{retryNotice}</span>
          <Button type="button" variant="quiet" size="sm" onClick={onDismissRetry}>Dismiss</Button>
        </div>
      ) : null}

      <div className="mt-4 space-y-3 rounded-md border border-border p-3">
        <p className="text-sm font-semibold">Generation limits</p>
        <UsageMeter label="Runs in the last day" used={null} limit={DAILY_GENERATION_LIMIT} unit="runs" />
        <UsageMeter label="Runs in progress" used={null} limit={GENERATION_CONCURRENCY} unit="runs at once" />
      </div>

      {canEdit && brief ? (
        <form
          className="mt-4 space-y-6"
          onSubmit={form.handleSubmit(onGenerate)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="What to create" hint="Deliverable format strategy for this creative plan.">
              <SelectInput {...form.register("creationScope")}>
                <option value="auto_choose">Auto (JEV evidence recommendation)</option>
                <option value="video_only">Video only (Reel / Short / UGC)</option>
                <option value="image_only">Static image only</option>
                <option value="carousel_only">Multi-slide carousel</option>
                <option value="mixed_campaign">Mixed campaign (video + static)</option>
                <option value="research_only">Research-only (no deliverables)</option>
              </SelectInput>
            </Field>
            <Field label="Automation level" hint="Governs human approval gates and billable execution.">
              <SelectInput {...form.register("autonomy")}>
                <option value="manual">Manual (Plan & recommend only; require approval)</option>
                <option value="semi_automatic">Semi-automatic (Review plan and quote before executing)</option>
                <option value="fully_automatic">Fully automatic (Execute within spend cap)</option>
              </SelectInput>
            </Field>
            <Field label="Spend cap (USD)" hint="Authoritative hard budget cap. Generation halts if exceeded.">
              <Input type="number" step="0.5" min="0" max="500" {...form.register("maxSpendUsd", { valueAsNumber: true })} />
            </Field>
            <Field label="Starting material" hint="Source lineage used to anchor the creative.">
              <SelectInput {...form.register("source")}>
                <option value="new_brief">New approved brief</option>
                <option value="winning_reference">Winning organic / competitor reference</option>
                <option value="existing_meridian_creative">Existing Meridian creative</option>
                <option value="brand_assets">Brand asset library</option>
                <option value="creator_footage">Creator / UGC footage</option>
              </SelectInput>
            </Field>
            <Field label="Aspect ratio" hint="Format canvas geometry.">
              <SelectInput {...form.register("aspectRatio")}>
                <option value="9:16">9:16 Vertical (Reels / TikTok / Shorts)</option>
                <option value="16:9">16:9 Landscape (YouTube / Desktop)</option>
                <option value="1:1">1:1 Square (Feed)</option>
                <option value="4:5">4:5 Portrait (Instagram Feed)</option>
              </SelectInput>
            </Field>
          </div>

          <Controller
            control={form.control}
            name="imageProvider"
            render={({ field }) => (
              <ProviderCardGroup
                legend="Image"
                name={field.name}
                cards={imageCards}
                value={field.value ?? "none"}
                error={errors.imageProvider?.message}
                onChange={field.onChange}
              />
            )}
          />

          <Controller
            control={form.control}
            name="videoProvider"
            render={({ field }) => (
              <ProviderCardGroup
                legend="Video engine"
                name={field.name}
                cards={videoCards}
                value={field.value ?? ""}
                error={errors.videoProvider?.message}
                onChange={field.onChange}
              />
            )}
          />

          <div className="space-y-3">
            {dirty ? (
              <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm">
                <span>Unsaved changes</span>
                <Button type="button" variant="quiet" onClick={() => form.reset()}>Discard</Button>
              </div>
            ) : null}
            <Button type="submit" disabled={pending || form.formState.isSubmitting || brief.status !== "ready"}>
              {form.formState.isSubmitting ? "Generating…" : "Generate variants"}
            </Button>
            <p className="text-sm text-fg-muted">Estimated cost appears only when a provider returns one. Daily or concurrency limits can block a run.</p>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}
