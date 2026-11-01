import { Link } from "@tanstack/react-router";
import { Button, DisabledReason } from "@/components/ui";
import type { CookbookCard } from "@/components/cookbooks/library-model";
import { PRESET_KEYS, PRESET_LABEL, presetSettingLines, type PresetKey } from "./pipeline-model";

/**
 * Presets. A preset only fills in values. "Fill draft" changes nothing saved. "Save preset" stores the preset for the brand.
 * No preset states a result, and no run reads these values yet.
 */
export function PresetBar({
  canEdit,
  busy,
  matchKey,
  onFill,
  onSave,
  brandId,
  cookbooks = [],
}: {
  canEdit: boolean;
  busy: string | null;
  matchKey: PresetKey | null;
  onFill: (key: PresetKey) => void;
  onSave: (key: PresetKey) => void;
  /** The brand, for the link to its cookbook library. */
  brandId?: string;
  /** The brand's other cookbooks (not the factory presets), listed read-only. */
  cookbooks?: readonly CookbookCard[];
}) {
  return (
    <section aria-labelledby="factory-presets" className="space-y-4">
      <div className="space-y-1">
        <h3 id="factory-presets" className="font-semibold text-fg">Presets</h3>
        <p className="max-w-3xl text-sm text-fg-muted">
          &quot;Fill draft&quot; only changes the editor. &quot;Save preset&quot; stores the preset for this brand and replaces the saved copy and any unsaved edits. Neither one changes a run.
        </p>
        {canEdit ? null : <DisabledReason id="factory-preset-reason">Only members can change presets.</DisabledReason>}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {PRESET_KEYS.map((key) => (
          <article
            key={key}
            aria-labelledby={`factory-preset-${key}`}
            className="flex flex-col gap-3 panel"
          >
            <h4 id={`factory-preset-${key}`} className="font-semibold text-fg">{PRESET_LABEL[key]}</h4>
            {matchKey === key ? (
              <p className="text-xs font-semibold text-fg-muted">The draft has this preset&apos;s values.</p>
            ) : null}
            <ul className="space-y-1 text-sm text-fg-muted">
              {presetSettingLines(key).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canEdit || busy !== null}
                aria-describedby={!canEdit ? "factory-preset-reason" : undefined}
                onClick={() => onFill(key)}
              >
                Fill draft
              </Button>
              <Button
                type="button"
                variant="quiet"
                size="sm"
                disabled={!canEdit || busy !== null}
                aria-describedby={!canEdit ? "factory-preset-reason" : undefined}
                onClick={() => onSave(key)}
              >
                {busy === `preset:${key}` ? "Saving preset" : "Save preset"}
              </Button>
            </div>
          </article>
        ))}
      </div>

      {cookbooks.length > 0 && brandId !== undefined ? (
        <section aria-labelledby="factory-cookbooks" className="space-y-3">
          <div className="space-y-1">
            <h4 id="factory-cookbooks" className="font-semibold text-fg">Other cookbooks in this brand</h4>
            <p className="max-w-3xl text-sm text-fg-muted">
              These are read-only here. Open the cookbook library to change one or make a copy.{" "}
              <Link to="/brands/$brandId/cookbooks" params={{ brandId }} className="underline underline-offset-4">Open the cookbook library</Link>
            </p>
          </div>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {cookbooks.map((card) => (
              <li key={`${card.source}:${card.cookbookId}`} className="flex flex-col gap-2 panel">
                <span className="font-semibold text-fg">{card.label}</span>
                <span className="text-sm text-fg-muted">{card.summary}</span>
                <span className="text-xs font-semibold text-fg-muted">{card.badge}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
