import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, ErrorState, Input, Popover, PopoverContent, PopoverTrigger, SelectInput } from "@/components/ui";
import { ProviderSettingsPanel } from "@/components/provider-settings-panel";
import { DriveConnectionPanel } from "@/components/settings/drive-connection";
import { qk } from "@/lib/query/keys";
import { useDecisionEnginesQuery, useProviderSettingsQuery, useScopedMutation } from "@/lib/query/hooks";
import {
  getOpenRouterDecisionModels,
  removeProviderConfig,
  saveDecisionEngine,
  saveOpenRouterDecisionModel,
  saveProviderConfig,
  testOpenRouterDecisionConnection,
} from "@/lib/meridian/settings/server-actions";
import { DECISION_FAMILIES, decisionFamilyOf, latestDecisionModel, type DecisionFamilyId } from "@/lib/meridian/decisions/decision-catalog";
import type { ProviderCategory, ProviderConfigSummary } from "@/lib/meridian/settings/provider-config";
import {
  connectionsView,
  FEATURE_GROUPS,
  PROVIDER_ENGINE,
  type EngineStatus,
  type FeatureLight,
  type FeatureRow,
  type ProviderRow,
  type ProviderStatus,
} from "./connections-model";

const LIGHT: Record<FeatureLight, { dot: string; word: string }> = {
  working: { dot: "bg-success", word: "Ready" },
  missing: { dot: "bg-danger", word: "Needs a key" },
  overlap: { dot: "bg-warning", word: "Overlap" },
  optional: { dot: "bg-fg-muted/50", word: "Optional" },
};

const PROVIDER_STATUS: Record<ProviderStatus, { dot: string; word: string }> = {
  ready: { dot: "bg-success", word: "Key saved" },
  shared: { dot: "bg-success", word: "Server key" },
  partial: { dot: "bg-warning", word: "Partly set" },
  unusable: { dot: "bg-danger", word: "Key not usable" },
  none: { dot: "bg-fg-muted/50", word: "No key" },
};

function Dot({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 rounded-full ${className}`} />;
}

/** The small info button. Details are there when a person wants them, never in the row itself. */
function InfoButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`About ${label}`} className="inline-flex size-7 items-center justify-center rounded-full text-fg-muted hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <Info aria-hidden="true" className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-sm">{children}</PopoverContent>
    </Popover>
  );
}

/**
 * Connections: the main key, then every place Meridian needs a provider with a light, then the providers. Keys are saved once and never
 * shown again. Every state is the server's own (the credential resolver); nothing here is assumed to work.
 */
export function ConnectionsTab({ organizationId, canAdmin }: { organizationId: string; canAdmin: boolean }) {
  const providers = useProviderSettingsQuery(organizationId);
  const engines = useDecisionEnginesQuery(organizationId);
  const summaries = (providers.data as Partial<Record<ProviderCategory, ProviderConfigSummary>> | undefined) ?? null;
  const engineStatus = (engines.data as EngineStatus | undefined) ?? null;

  if (providers.isError && !summaries) {
    return <ErrorState message="Connections could not be loaded." onRetry={() => void providers.refetch()} />;
  }
  if (!summaries) return <p className="text-sm text-fg-muted">Loading connections...</p>;

  const view = connectionsView({ summaries, engines: engineStatus });
  const openRouter = view.providers.find((provider) => provider.id === "openrouter")!;
  const main = view.providers.filter((provider) => !provider.more && provider.id !== "openrouter");
  const more = view.providers.filter((provider) => provider.more);
  const counts = { working: 0, missing: 0, overlap: 0, optional: 0 } as Record<FeatureLight, number>;
  for (const feature of view.features) counts[feature.light] += 1;

  return (
    <div className="space-y-8">
      <section aria-labelledby="main-key-title" className="panel space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="main-key-title" className="text-section font-semibold text-fg-primary">OpenRouter</h2>
          <Badge variant="info">Main key</Badge>
          <InfoButton label="OpenRouter">
            <p>{openRouter.powers}</p>
            <p>One OpenRouter key reaches Claude, GPT, Gemini, DeepSeek and the image, video and voice models, billed on one OpenRouter account.</p>
            <p className="text-fg-muted">Still needs other keys: {view.openRouterUnlocks.missing.join(", ")}.</p>
            <p><a className="font-semibold underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Get an OpenRouter key</a></p>
          </InfoButton>
        </div>
        <p className="text-sm text-fg-muted">Unlocks {view.openRouterUnlocks.count} of {view.openRouterUnlocks.of} features: writing, decisions, image understanding, and the video engine's planning, images, clips and voice.</p>
        <ProviderKeyRow provider={openRouter} organizationId={organizationId} canAdmin={canAdmin} prominent />
      </section>

      <section aria-labelledby="features-title" className="space-y-4">
        <div className="space-y-1">
          <h2 id="features-title" className="text-section font-semibold text-fg-primary">Where Meridian uses AI</h2>
          <p className="text-sm text-fg-muted" aria-live="polite">
            {counts.working} ready, {counts.missing} need a key, {counts.overlap} overlap, {counts.optional} optional. A key is checked against its provider the first time it is used.
          </p>
        </div>
        {FEATURE_GROUPS.map((group) => {
          const rows = view.features.filter((feature) => feature.group === group.id);
          return (
            <div key={group.id} className="space-y-1">
              <h3 className="eyebrow">{group.label}</h3>
              <ul className="divide-y divide-hairline rounded-sharp border border-hairline bg-raised">
                {rows.map((feature) => <FeatureItem key={feature.id} feature={feature} engineStatus={engineStatus} organizationId={organizationId} canAdmin={canAdmin} providers={view.providers} />)}
              </ul>
            </div>
          );
        })}
      </section>

      <section aria-labelledby="providers-title" className="space-y-3">
        <h2 id="providers-title" className="text-section font-semibold text-fg-primary">Providers</h2>
        <ul className="divide-y divide-hairline rounded-sharp border border-hairline bg-raised">
          {main.map((provider) => <li key={provider.id} className="p-3"><ProviderKeyRow provider={provider} organizationId={organizationId} canAdmin={canAdmin} /></li>)}
        </ul>
        <Collapsible>
          <CollapsibleTrigger asChild><Button variant="quiet" size="md">More providers ({more.length})</Button></CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 divide-y divide-hairline rounded-sharp border border-hairline bg-raised">
              {more.map((provider) => <li key={provider.id} className="p-3"><ProviderKeyRow provider={provider} organizationId={organizationId} canAdmin={canAdmin} /></li>)}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <Collapsible>
        <CollapsibleTrigger asChild><Button variant="quiet" size="md">Advanced settings</Button></CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-6">
          <p className="text-sm text-fg-muted">Engine and provider details, connection tests, crawl limits and Google Drive. Most workspaces never need these.</p>
          <ProviderSettingsPanel organizationId={organizationId} canAdmin={canAdmin} />
          <DriveConnectionPanel organizationId={organizationId} canAdmin={canAdmin} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function FeatureItem({ feature, engineStatus, organizationId, canAdmin, providers }: { feature: FeatureRow; engineStatus: EngineStatus | null; organizationId: string; canAdmin: boolean; providers: ProviderRow[] }) {
  const light = LIGHT[feature.light];
  const choose = useScopedMutation({
    mutationKey: ["mutation", "connections.engine", organizationId],
    mutationFn: (engineId: string) => saveDecisionEngine({ data: { organizationId, engineId } }),
    invalidate: () => [qk.decisionEngines(organizationId), qk.providerSettings(organizationId)],
    success: (_engineId, result) => (result.ok ? "Decision engine saved." : ""),
  });
  // Decisions through OpenRouter: the family's newest verified model is saved, its connection is checked (one small call on the workspace's
  // key, made only because an admin chose it), and only a passed check switches the engine. A refusal at any step stops there and says why.
  const useOpenRouter = useScopedMutation({
    mutationKey: ["mutation", "connections.engine.openrouter", organizationId],
    mutationFn: async (family: DecisionFamilyId): Promise<{ ok: true; model: string } | { ok: false; reason: string }> => {
      const label = DECISION_FAMILIES.find((item) => item.id === family)?.label ?? family;
      const listing = await getOpenRouterDecisionModels({ data: { organizationId } });
      if (!listing.ok) return { ok: false, reason: `${listing.reason} The engine is unchanged.` };
      const latest = latestDecisionModel(listing.eligible, family);
      if (!latest) return { ok: false, reason: `OpenRouter lists no ${label} model Meridian has verified right now. The engine is unchanged.` };
      if (engineStatus?.openrouterModel?.model !== latest.id) {
        const saved = await saveOpenRouterDecisionModel({ data: { organizationId, model: latest.id } });
        if (!saved.ok) return { ok: false, reason: saved.reason };
      }
      const check = await testOpenRouterDecisionConnection({ data: { organizationId } });
      if (!check.ok) return { ok: false, reason: check.message };
      const engine = await saveDecisionEngine({ data: { organizationId, engineId: "openrouter-decisions" } });
      return engine.ok ? { ok: true, model: latest.id } : { ok: false, reason: engine.reason ?? "The engine could not be saved." };
    },
    invalidate: () => [qk.decisionEngines(organizationId), qk.providerSettings(organizationId), qk.openRouterDecisionModels(organizationId)],
    success: (_family, result) => (result.ok ? `Decisions now use ${result.model} through OpenRouter.` : ""),
  });
  // A check after a refusal (for example once the decision cap is set on the Billing page), for the OpenRouter engine already chosen.
  const recheck = useScopedMutation({
    mutationKey: ["mutation", "connections.engine.recheck", organizationId],
    mutationFn: async (): Promise<{ ok: boolean; reason?: string }> => {
      const check = await testOpenRouterDecisionConnection({ data: { organizationId } });
      return check.ok ? { ok: true } : { ok: false, reason: check.message };
    },
    invalidate: () => [qk.decisionEngines(organizationId), qk.providerSettings(organizationId)],
    success: (_vars, result) => (result.ok ? "The OpenRouter decision connection passed its check." : ""),
  });
  const latestAnswer = [useOpenRouter, recheck, choose].filter((mutation) => mutation.data).sort((a, b) => b.submittedAt - a.submittedAt)[0]?.data as { ok: boolean; reason?: string } | undefined;
  const refusal = latestAnswer && !latestAnswer.ok ? (latestAnswer.reason ?? null) : null;
  const usableLabel = (id: string) => providers.find((provider) => provider.id === id);
  const openRouterReady = ["ready", "shared"].includes(usableLabel("openrouter")?.status ?? "none");
  const busy = choose.isPending || useOpenRouter.isPending || recheck.isPending;
  const activeEngine = engineStatus?.active.engineId ?? "";
  const storedFamily = engineStatus?.openrouterModel?.model ? decisionFamilyOf(engineStatus.openrouterModel.model) : null;
  const value = activeEngine === "openrouter-decisions" ? `openrouter:${storedFamily ?? "other"}` : activeEngine;
  const onChoose = (next: string) => {
    if (next.startsWith("openrouter:")) {
      const family = next.slice("openrouter:".length);
      if (family === "openai" || family === "typesafe") void useOpenRouter.mutateAsync(family).catch(() => undefined);
      return;
    }
    void choose.mutateAsync(next).catch(() => undefined);
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <Dot className={light.dot} />
      <span className="min-w-0 flex-1 text-sm font-medium text-fg-primary">
        {feature.label}
        <span className="sr-only">: {light.word}</span>
        {/* The engine picker shows no status line, so a decisions row that cannot answer says so in words, not only by its dot. */}
        {feature.choice === "decision_engine" && feature.light === "missing" ? (
          <span className="block text-sm font-normal text-fg-muted">{busy ? "Checking the connection..." : "Cannot answer decisions yet"}</span>
        ) : null}
      </span>
      {feature.choice === "decision_engine" && engineStatus ? (
        <label className="order-last flex basis-full items-center gap-2 text-sm text-fg-muted sm:order-none sm:basis-auto">
          <span className="sr-only">Decision engine</span>
          <SelectInput value={value} disabled={!canAdmin || busy} onChange={(event) => onChoose(event.target.value)} className="h-9 w-full sm:w-auto sm:min-w-56">
            {DECISION_FAMILIES.map((family) => (
              <option key={family.id} value={`openrouter:${family.id}`}>
                {family.label} via OpenRouter{openRouterReady ? "" : " (no key)"}
              </option>
            ))}
            {value === "openrouter:other" ? <option value="openrouter:other">OpenRouter: {engineStatus.openrouterModel?.model}</option> : null}
            {feature.candidates
              .filter((id) => id !== "openrouter")
              .map((id) => {
                const provider = usableLabel(id);
                const ready = provider ? provider.status === "ready" || provider.status === "shared" : false;
                return <option key={id} value={PROVIDER_ENGINE[id]}>{provider?.label ?? id} (own key){ready ? "" : ", no key"}</option>;
              })}
          </SelectInput>
        </label>
      ) : (
        <span className="text-sm text-fg-muted">{feature.line}</span>
      )}
      {canAdmin && feature.choice === "decision_engine" && feature.light === "missing" && activeEngine === "openrouter-decisions" ? (
        <Button type="button" size="sm" variant="secondary" className="order-last basis-full sm:order-none sm:basis-auto" disabled={busy} onClick={() => void recheck.mutateAsync(undefined).catch(() => undefined)}>
          {recheck.isPending ? "Checking..." : "Check again"}
        </Button>
      ) : null}
      <InfoButton label={feature.label}>
        <p>{feature.about}</p>
        <p className="text-fg-muted">{light.word}{feature.light === "overlap" ? `: ${feature.line}. Only the one shown first is used for this.` : feature.light === "missing" ? `: ${feature.line}.` : "."}</p>
      </InfoButton>
      {refusal ? (
        <p role="alert" className="basis-full text-sm text-danger">
          Not switched: {refusal}
          {/Billing page/.test(refusal) ? <> <Link to="/billing" className="font-semibold underline underline-offset-2">Open Billing</Link></> : null}
        </p>
      ) : null}
    </li>
  );
}

/** One provider: its state, its masked key, and a field to set or replace it. The key is sent once and the field is cleared. */
function ProviderKeyRow({ provider, organizationId, canAdmin, prominent }: { provider: ProviderRow; organizationId: string; canAdmin: boolean; prominent?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const status = PROVIDER_STATUS[provider.status];
  const invalidate = () => [qk.providerSettings(organizationId), qk.decisionEngines(organizationId), qk.integrations(organizationId), qk.generationModels(organizationId)];
  const save = useScopedMutation({
    mutationKey: ["mutation", "connections.key.save", organizationId, provider.id],
    // Google's one key serves two vault entries (perception and production); it is saved to both.
    mutationFn: async (apiKey: string) => {
      for (const category of provider.categories) await saveProviderConfig({ data: { organizationId, category, credentials: { apiKey } } });
    },
    invalidate,
    success: `${provider.label} key saved. Only its last four characters are shown from now on.`,
    onSuccess: () => {
      setDraft("");
      setEditing(false);
    },
  });
  const remove = useScopedMutation({
    mutationKey: ["mutation", "connections.key.remove", organizationId, provider.id],
    mutationFn: async () => {
      for (const category of provider.categories) await removeProviderConfig({ data: { organizationId, category } });
    },
    invalidate,
    success: `${provider.label} key removed.`,
  });
  const busy = save.isPending || remove.isPending;
  const showField = canAdmin && !provider.serverOnly && (editing || (prominent && provider.status === "none"));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {!prominent ? <span className="min-w-28 text-sm font-semibold text-fg-primary">{provider.label}</span> : null}
        <span className="flex items-center gap-2 text-sm text-fg-muted"><Dot className={status.dot} />{status.word}</span>
        {provider.fingerprint ? <span className="font-mono text-xs text-fg-muted">{provider.fingerprint}</span> : null}
        {provider.unused ? <Badge variant="neutral">Not used</Badge> : null}
        <span className="ml-auto flex items-center gap-1">
          {canAdmin && !provider.serverOnly && !showField ? (
            <Button type="button" variant="quiet" size="sm" onClick={() => setEditing(true)} disabled={busy}>{provider.status === "none" ? "Add key" : "Replace"}</Button>
          ) : null}
          {canAdmin && provider.removable ? (
            <Button type="button" variant="quiet" size="sm" onClick={() => void remove.mutateAsync(undefined).catch(() => undefined)} disabled={busy}>Remove</Button>
          ) : null}
          {!prominent ? (
            <InfoButton label={provider.label}>
              <p>{provider.powers}</p>
              {provider.usedFor.length > 0 ? <p className="text-fg-muted">Used now for: {provider.usedFor.join(", ")}.</p> : null}
              {provider.unused ? <p className="text-fg-muted">Not used now: another connected provider already serves what this one could.</p> : null}
              {provider.reason ? <p className="text-fg-muted">{provider.reason}</p> : null}
              {provider.status === "shared" ? <p className="text-fg-muted">The server's own key is shared with this workspace. A key saved here replaces it for this workspace.</p> : null}
              {provider.keyUrl ? <p><a className="font-semibold underline" href={provider.keyUrl} target="_blank" rel="noreferrer">Get a {provider.label} key</a></p> : null}
            </InfoButton>
          ) : null}
        </span>
      </div>
      {provider.reason && prominent ? <p className="text-sm text-fg-muted">{provider.reason}</p> : null}
      {showField ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const key = draft.trim();
            if (key) void save.mutateAsync(key).catch(() => undefined);
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${provider.label} key`}
            placeholder={`${provider.label} key`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={busy || draft.trim().length === 0}>{save.isPending ? "Saving..." : "Save"}</Button>
          {editing ? <Button type="button" variant="quiet" size="sm" onClick={() => { setEditing(false); setDraft(""); }}>Cancel</Button> : null}
        </form>
      ) : null}
    </div>
  );
}
