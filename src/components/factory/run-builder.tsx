import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, DisabledReason, Field, Input, SelectInput } from "@/components/ui";
import { FormDiscardBar } from "@/components/forms/unsaved-bar";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { AUTOMATION_MODES, DECISION_ENGINE_CHOICES, ENGINE_VIDEO_PROVIDER_ID, FORMATS, INTENTS, MASTER_COST_FLOOR_SENTENCE, MASTER_COST_FLOOR_TEXT, type AutomationMode, type DecisionEngineChoice, type Format, type Intent, type RunSettings } from "@/lib/meridian/factory/run-settings";
import {
  AUTOMATION_DESCRIPTIONS,
  ENGINE_LABELS,
  FORMAT_LABELS,
  INTENT_DESCRIPTIONS,
  checkedDefaults,
  checkedSettings,
  costPerMasterFromText,
  countriesFromText,
  draftFromDefaults,
  draftProblems,
  paidCountryNote,
  videoProviderOptions,
  type BuilderDraft,
} from "@/lib/meridian/factory/run-builder-model";

export type RunChannel = { id: string; name: string; connected: boolean };

const AUTOMATION_LABELS: Record<AutomationMode, string> = { manual: "Manual", semi: "Semi", full: "Full" };
const INTENT_LABELS: Record<Intent, string> = { organic: "Organic posts", ad: "Paid ads (paused)", both: "Both" };

/**
 * The run builder (NORTH_STAR section 4 and 8, item 11). It exposes every run setting, starts from the brand's defaults, and says in
 * plain words why a run cannot start. The server checks the same settings again when the run is queued.
 */
export function RunBuilder({
  defaults,
  channels,
  channelsState,
  canEdit,
  canAdmin,
  busy,
  savingDefaults,
  onStart,
  onSaveDefaults,
  onDirtyChange,
  pages,
}: {
  defaults: RunSettings;
  channels: RunChannel[];
  /** The brand's theme pages that are not archived. The run uses the one a person picks, or none. */
  pages: ReadonlyArray<{ id: string; name: string; status: string }>;
  channelsState: "loading" | "ready" | "error";
  canEdit: boolean;
  /** Admins and owners save the brand's run defaults. Other roles see the draft and cannot save it. */
  canAdmin: boolean;
  busy: boolean;
  savingDefaults: boolean;
  onStart: (input: { niche: string; settings: RunSettings }) => void;
  onSaveDefaults: (settings: RunSettings) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [initial] = useState(() => draftFromDefaults(defaults));
  const [draft, setDraft] = useState<BuilderDraft>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const problems = useMemo(() => draftProblems(draft), [draft]);
  const reason = busy ? "Queueing the run." : !canEdit ? "Viewers cannot start runs. Ask a member to start one." : problems[0] ?? "";
  const countryNote = paidCountryNote(draft.intent, draft.countries);
  const countriesCheck = countriesFromText(draft.countries);
  const costCheck = costPerMasterFromText(draft.costPerMasterDollars);
  const needsCost = draft.formats.includes("video");
  const defaultsCheck = checkedDefaults(draft);
  const defaultsReason = savingDefaults
    ? "Saving the brand's defaults."
    : !canAdmin
      ? "Only an admin or owner saves the brand's run defaults."
      : defaultsCheck.ok
        ? ""
        : defaultsCheck.problems[0] ?? "";
  const update = <K extends keyof BuilderDraft>(key: K, value: BuilderDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const toggle = <T extends string>(list: T[], value: T, on: boolean): T[] => (on ? [...new Set([...list, value])] : list.filter((item) => item !== value));

  // The platforms the run may name: every channel the workspace lists, plus any the draft already names that the list does not show.
  const platformChoices = useMemo(() => {
    const listed = new Map(channels.map((channel) => [channel.id, channel]));
    for (const id of draft.platforms) if (!listed.has(id)) listed.set(id, { id, name: id, connected: false });
    return [...listed.values()];
  }, [channels, draft.platforms]);

  const submit = () => {
    const checked = checkedSettings(draft);
    if (!checked.ok) return;
    onStart({ niche: draft.niche.trim(), settings: checked.settings });
  };

  const saveDefaults = () => {
    if (!defaultsCheck.ok) return;
    onSaveDefaults(defaultsCheck.settings);
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => submitOnShortcut(event)}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Niche" required>
          <Input value={draft.niche} onChange={(event) => update("niche", event.target.value)} maxLength={80} required placeholder="skincare" disabled={!canEdit} />
        </Field>
        <Field label="Automation">
          <SelectInput value={draft.automation} onChange={(event) => update("automation", event.target.value as AutomationMode)} disabled={!canEdit}>
            {AUTOMATION_MODES.map((mode) => <option key={mode} value={mode}>{AUTOMATION_LABELS[mode]}</option>)}
          </SelectInput>
          <p className="text-sm text-muted">{AUTOMATION_DESCRIPTIONS[draft.automation]}</p>
        </Field>
        <Field label="Intent">
          <SelectInput value={draft.intent} onChange={(event) => update("intent", event.target.value as Intent)} disabled={!canEdit}>
            {INTENTS.map((intent) => <option key={intent} value={intent}>{INTENT_LABELS[intent]}</option>)}
          </SelectInput>
          <p className="text-sm text-muted">{INTENT_DESCRIPTIONS[draft.intent]}</p>
        </Field>
        <Field label="Decision engine">
          <SelectInput value={draft.decisionEngine} onChange={(event) => update("decisionEngine", event.target.value as DecisionEngineChoice)} disabled={!canEdit}>
            {DECISION_ENGINE_CHOICES.map((engine) => <option key={engine} value={engine}>{ENGINE_LABELS[engine]}</option>)}
          </SelectInput>
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Formats</legend>
        <div className="flex flex-wrap gap-4">
          {FORMATS.map((format: Format) => (
            <Checkbox
              key={format}
              label={FORMAT_LABELS[format]}
              checked={draft.formats.includes(format)}
              onCheckedChange={(on) => update("formats", toggle(draft.formats, format, on === true))}
              disabled={!canEdit}
            />
          ))}
        </div>
        {draft.formats.includes("video") || draft.formats.includes("carousel") ? (
          <p className="text-sm text-muted">
            Video and carousel are made through the provider you choose below. A video that is still rendering keeps the run running and waiting, and the run says why. A provider that is not ready stops the run before any spend.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Platforms</legend>
        {channelsState === "loading" ? <p className="text-sm text-muted">Checking which channels are connected.</p> : null}
        {channelsState === "error" ? <p className="text-sm text-muted">The channel list could not be loaded, so no platform can be chosen here.</p> : null}
        {channelsState === "ready" && platformChoices.length === 0 ? <p className="text-sm text-muted">No channels are listed for this brand. A run with no platform lists every organic platform.</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {platformChoices.map((channel) => (
            <Checkbox
              key={channel.id}
              label={`${channel.name} · ${channel.connected ? "Connected" : "Not connected"}`}
              checked={draft.platforms.includes(channel.id)}
              onCheckedChange={(on) => update("platforms", toggle(draft.platforms, channel.id, on === true))}
              disabled={!canEdit}
            />
          ))}
        </div>
        <p className="text-sm text-muted">A platform that is not connected stays in the run and is reported as not connected. It is never sent.</p>
      </fieldset>

      {draft.formats.length > 0 ? (
        <fieldset className="grid gap-4 md:grid-cols-3">
          <legend className="text-sm font-semibold">Provider per format</legend>
          {draft.formats.map((format) =>
            format === "video" ? (
              <Field key={format} label={`${FORMAT_LABELS[format]} provider`}>
                <SelectInput
                  value={(draft.providers.video ?? "").trim() || "auto"}
                  disabled={!canEdit}
                  onChange={(event) => update("providers", { ...draft.providers, video: event.target.value })}
                >
                  {videoProviderOptions(draft.providers.video).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </SelectInput>
                {draft.providers.video === ENGINE_VIDEO_PROVIDER_ID ? (
                  <p className="text-sm text-muted">The Meridian video engine makes the video from the plan. A run that names it stops with the engine's reason when it cannot run, such as no connected key, no cost per master, or a field the plan does not carry.</p>
                ) : null}
              </Field>
            ) : (
              <Field key={format} label={`${FORMAT_LABELS[format]} provider`}>
                <Input
                  value={draft.providers[format] ?? ""}
                  placeholder="auto"
                  disabled={!canEdit}
                  onChange={(event) => update("providers", { ...draft.providers, [format]: event.target.value })}
                />
              </Field>
            ),
          )}
          <p className="text-sm text-muted md:col-span-3">Choose auto to let the capability matrix choose, or name a provider. A named provider that is not ready stops the run with its reason.</p>
        </fieldset>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Paid targeting</legend>
        <Field
          label="Targeting countries"
          hint="Two-letter country codes separated by commas, such as US, GB or DE. A paid ad is targeted to these countries."
          error={countriesCheck.ok ? undefined : countriesCheck.error}
        >
          <Input value={draft.countries} onChange={(event) => update("countries", event.target.value)} placeholder="US, GB" disabled={!canEdit} />
        </Field>
        {countryNote ? <p className="text-sm text-muted">{countryNote}</p> : null}
        <Field label="Facebook Page id" hint="The numeric id of the Page a paid ad is created for. Leave it blank for an organic run.">
          <Input value={draft.facebookPageId} onChange={(event) => update("facebookPageId", event.target.value)} placeholder="1234567890" disabled={!canEdit} inputMode="numeric" />
        </Field>
        <Field label="Destination link" hint="The https page a paid ad sends people to.">
          <Input value={draft.destinationLink} onChange={(event) => update("destinationLink", event.target.value)} placeholder="https://example.com/offer" disabled={!canEdit} />
        </Field>
      </fieldset>

      <Field label="Theme page" hint="The page's kits, schedule and Instagram trial default apply to this run. No page keeps the run's own settings.">
        <SelectInput value={draft.pageId} onChange={(event) => update("pageId", event.target.value)} disabled={!canEdit}>
          <option value="">No page</option>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>{page.name} ({page.status})</option>
          ))}
        </SelectInput>
      </Field>

      <Field
        label="Cost per master (USD)"
        required={needsCost}
        hint={`${MASTER_COST_FLOOR_SENTENCE} The exact minimum for each video is checked before it is made.`}
        error={costCheck.ok ? undefined : costCheck.error}
      >
        <Input
          value={draft.costPerMasterDollars}
          onChange={(event) => update("costPerMasterDollars", event.target.value)}
          type="number"
          min={MASTER_COST_FLOOR_TEXT}
          step="0.01"
          disabled={!canEdit}
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Daily spend cap (USD)">
          <Input value={draft.dailyDollars} onChange={(event) => update("dailyDollars", event.target.value)} type="number" min="0" step="0.01" placeholder="0" disabled={!canEdit} />
        </Field>
        <Field label="Total spend cap (USD)">
          <Input value={draft.totalDollars} onChange={(event) => update("totalDollars", event.target.value)} type="number" min="0" step="0.01" placeholder="0" disabled={!canEdit} />
        </Field>
        <Field label="Max variants per run">
          <Input value={draft.maxVariants} onChange={(event) => update("maxVariants", event.target.value)} type="number" min="1" max="40" step="1" disabled={!canEdit} />
        </Field>
      </div>

      <FormDiscardBar dirty={dirty} subject="run settings" onDiscard={() => setDraft(initial)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={Boolean(reason)} loading={busy} aria-describedby={reason ? "factory-run-builder-reason" : undefined}>
          Start run
        </Button>
        {reason ? <DisabledReason id="factory-run-builder-reason">{reason}</DisabledReason> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={saveDefaults} disabled={Boolean(defaultsReason)} loading={savingDefaults} aria-describedby={defaultsReason ? "factory-run-defaults-reason" : undefined}>
          Save as brand defaults
        </Button>
        {defaultsReason ? <DisabledReason id="factory-run-defaults-reason">{defaultsReason}</DisabledReason> : null}
      </div>
    </form>
  );
}
