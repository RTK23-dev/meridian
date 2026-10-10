import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Button, ErrorState, Field, Panel, SelectInput, TextInput,
} from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
import { submitOnShortcut } from "@/components/forms/shortcut";
import { providerFieldsSchema, type ProviderFieldsInput } from "@/components/forms/client-schemas";
import { plainError } from "@/lib/copy";
import { qk } from "@/lib/query/keys";
import { useProviderSettingsQuery, useScopedMutation } from "@/lib/query/hooks";
import {
  saveProviderConfig,
  removeProviderConfig,
  testProviderConnection,
} from "@/lib/meridian/settings/server-actions";
import type { ProviderCategory, ProviderConfigSummary } from "@/lib/meridian/settings/provider-config";
import { DecisionEngineSelector } from "@/components/decision-engine-selector";

interface ProviderSettingsPanelProps {
  organizationId: string;
  canAdmin: boolean;
}

type Readiness = NonNullable<ProviderConfigSummary["credentialState"]>;

// Each state gets its own badge. "Unusable" is never shown as configured, and "not configured" never shows a source.
const READINESS_BADGE: Record<Readiness, { label: string; className: string }> = {
  usable: { label: "CONFIGURED", className: "bg-success/20 text-success border border-success/30" },
  unusable: { label: "UNUSABLE", className: "bg-danger/10 text-danger border border-danger/30" },
  not_configured: { label: "NOT CONFIGURED", className: "bg-muted/20 text-muted border border-line" },
};

function readinessOf(summary: ProviderConfigSummary): Readiness {
  return summary.credentialState ?? (summary.configured ? "usable" : "not_configured");
}

function sourceLabelOf(summary: ProviderConfigSummary): string {
  // The three credential categories share one vocabulary, taken from the resolver's state. A deployment key is named as a
  // shared default, because it is used only when its category's shared default is opted in.
  if (summary.credentialState) {
    if (summary.credentialState === "usable") {
      return summary.source === "workspace" ? "Workspace key" : "Deployment shared default";
    }
    if (summary.credentialState === "unusable") return "Workspace key (unusable)";
    return "None";
  }
  const labels: Record<ProviderConfigSummary["source"], string> = {
    workspace: "Workspace",
    deployment: "Deployment",
    default: "Built-in default",
    not_configured: "None",
  };
  return labels[summary.source];
}

/** The stored value of each panel field, with the defaults the panel has always shown when nothing is stored. */
function storedFieldsOf(summaries: Record<ProviderCategory, ProviderConfigSummary> | null): ProviderFieldsInput {
  return {
    apiKey: "",
    costPreference: String(summaries?.production?.settings.costPreference || "BALANCED") as ProviderFieldsInput["costPreference"],
    gatewayUrl: String(summaries?.cyclone?.settings.gatewayUrl || "http://127.0.0.1:4000"),
    maxPages: String(summaries?.sources?.settings.maxPagesPerRun || "50"),
  };
}

/** The fields each category's Save checks and sends. The API key box is shared, as it always was. */
const FIELDS_SAVED_BY: Record<ProviderCategory, Array<keyof ProviderFieldsInput>> = {
  jev: ["apiKey"],
  production: ["apiKey", "costPreference"],
  cyclone: ["gatewayUrl"],
  sources: ["maxPages"],
  perception: ["apiKey"],
  storage: [],
};

export function ProviderSettingsPanel({ organizationId, canAdmin }: ProviderSettingsPanelProps) {
  const settings = useProviderSettingsQuery(organizationId);
  const summaries = settings.data ? (settings.data as Record<ProviderCategory, ProviderConfigSummary>) : null;
  const loading = settings.isPending;
  const [activeTab, setActiveTab] = useState<ProviderCategory>("jev");
  const [testResult, setTestResult] = useState<{ status: string; message: string; latencyMs?: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // One form for the panel's fields. Each field shows the stored value until it is edited, and an edit is kept when the
  // person switches category, as it always was. Only a saved field takes the new stored value.
  const providerForm = useForm<ProviderFieldsInput>({
    resolver: zodResolver(providerFieldsSchema),
    defaultValues: storedFieldsOf(summaries),
    mode: "onBlur",
  });
  const apiKeyDraft = providerForm.watch("apiKey");
  const providerDirty = providerForm.formState.isDirty;
  const fieldErrors = providerForm.formState.errors;
  const [discardRequested, setDiscardRequested] = useState(false);
  useEffect(() => {
    const stored = storedFieldsOf(summaries);
    for (const key of ["costPreference", "gatewayUrl", "maxPages"] as const) {
      if (!providerForm.getFieldState(key).isDirty) providerForm.resetField(key, { defaultValue: stored[key] });
    }
  }, [summaries, providerForm]);

  // Saving or removing a credential changes the decision-engine card and the integration status, so those refresh too.
  const saveConfig = useScopedMutation({
    mutationKey: ["mutation", "provider.save", organizationId],
    mutationFn: (input: { category: ProviderCategory; credentials?: Record<string, string>; settings: Record<string, unknown> }) =>
      saveProviderConfig({ data: { organizationId, category: input.category, credentials: input.credentials, settings: input.settings } }),
    invalidate: () => [qk.providerSettings(organizationId), qk.decisionEngines(organizationId), qk.integrations(organizationId)],
    onSuccess: (_data, input) => {
      setMessage(`${input.category.toUpperCase()} configuration saved.`);
      // The saved values become the stored values. The key box is cleared, as a key is never shown again.
      providerForm.resetField("apiKey", { defaultValue: "" });
      if (input.settings?.costPreference !== undefined) providerForm.resetField("costPreference", { defaultValue: String(input.settings.costPreference) as ProviderFieldsInput["costPreference"] });
      if (input.settings?.gatewayUrl !== undefined) providerForm.resetField("gatewayUrl", { defaultValue: String(input.settings.gatewayUrl) });
      if (input.settings?.maxPages !== undefined) providerForm.resetField("maxPages", { defaultValue: String(input.settings.maxPages) });
    },
  });
  const removeConfig = useScopedMutation({
    mutationKey: ["mutation", "provider.remove", organizationId],
    mutationFn: (category: ProviderCategory) => removeProviderConfig({ data: { organizationId, category } }),
    invalidate: () => [qk.providerSettings(organizationId), qk.decisionEngines(organizationId), qk.integrations(organizationId)],
    onSuccess: (_data, category) => {
      setMessage(`Workspace ${category} credentials removed.`);
    },
  });
  // A connection test reads the provider and changes no stored state, so it invalidates nothing.
  const testConnection = useScopedMutation({
    mutationKey: ["mutation", "provider.test", organizationId],
    mutationFn: (category: ProviderCategory) => testProviderConnection({ data: { organizationId, category } }),
  });
  const testing = testConnection.isPending;
  const saving = saveConfig.isPending || removeConfig.isPending;
  const failure = [saveConfig.error, removeConfig.error].find(Boolean);
  const error = failure ? plainError(failure) : null;

  async function handleTest(category: ProviderCategory) {
    setTestResult(null);
    try {
      const res = await testConnection.mutateAsync(category);
      setTestResult(res);
    } catch (err) {
      setTestResult({
        status: "ERROR",
        message: err instanceof Error ? err.message : "Test failed.",
      });
    }
  }

  async function handleSave(category: ProviderCategory) {
    setMessage(null);
    // Only the fields this category saves are checked, so a bad draft for another category does not block this save.
    const valid = await providerForm.trigger(FIELDS_SAVED_BY[category]);
    if (!valid) return;
    const values = providerForm.getValues();
    const credentials: Record<string, string> = {};
    if (values.apiKey.trim()) {
      credentials.apiKey = values.apiKey.trim();
    }

    const settingsToSave: Record<string, unknown> = {};
    if (category === "production") {
      settingsToSave.costPreference = values.costPreference;
    } else if (category === "cyclone") {
      settingsToSave.gatewayUrl = values.gatewayUrl;
    } else if (category === "sources") {
      settingsToSave.maxPages = Number(values.maxPages);
    }

    await saveConfig
      .mutateAsync({ category, credentials: Object.keys(credentials).length > 0 ? credentials : undefined, settings: settingsToSave })
      .catch(() => undefined);
  }

  async function handleRemove(category: ProviderCategory) {
    setMessage(null);
    await removeConfig.mutateAsync(category).catch(() => undefined);
  }

  if (settings.isError && !summaries) {
    return <ErrorState message="Provider settings could not be loaded." onRetry={() => void settings.refetch()} />;
  }
  if (loading && !summaries) {
    return <p className="text-muted text-sm">Loading AI and Provider configuration...</p>;
  }

  const activeSummary = summaries ? summaries[activeTab] : null;

  return (
    <Panel className="space-y-6">
      <UnsavedChangesGuard dirty={providerDirty} />
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-brass">Architecture & Intelligence</p>
          <h2 className="font-display text-2xl">AI, Research & Provider Configuration</h2>
          <p className="text-muted text-sm mt-1">
            Configure JEV decision routers, perception models, crawl budgets, production engines, and Cyclone Scout.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["jev", "perception", "sources", "production", "storage", "cyclone"] as ProviderCategory[]).map((tab) => {
            const sum = summaries?.[tab];
            const isReady = sum?.credentialState ? sum.credentialState === "usable" : sum?.configured;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setActiveTab(tab);
                  setTestResult(null);
                  setMessage(null);
                }}
                className={`rounded px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition ${
                  activeTab === tab
                    ? "bg-paper text-foreground shadow-sm"
                    : "text-muted hover:text-foreground hover:bg-panel"
                }`}
              >
                {tab} {isReady ? "✓" : "○"}
              </button>
            );
          })}
        </div>
      </div>

      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {message ? <p className="text-sm text-success" role="status">{message}</p> : null}

      {activeSummary ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded border border-line bg-panel p-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-lg capitalize">{activeTab} Provider Status</h3>
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${READINESS_BADGE[readinessOf(activeSummary)].className}`}>
                  {READINESS_BADGE[readinessOf(activeSummary)].label}
                </span>
                <span className="text-xs text-muted">
                  Source: <strong>{sourceLabelOf(activeSummary)}</strong>
                </span>
              </div>
              {activeSummary.keyFingerprint ? (
                <p className="text-xs text-muted mt-1 font-mono">
                  Stored Key Fingerprint: <strong>{activeSummary.keyFingerprint}</strong>
                </p>
              ) : null}
              {activeSummary.credentialReason ? (
                <p className={`text-xs mt-1 ${readinessOf(activeSummary) === "unusable" ? "text-danger" : "text-muted"}`}>
                  {activeSummary.credentialReason}
                </p>
              ) : null}
              {activeSummary.category === "perception" && activeSummary.credentialState === "usable" && activeSummary.source === "deployment" ? (
                <p className="text-xs mt-1 text-muted">
                  The deployment&apos;s Gemini key is in use because PERCEPTION_SHARED_DEFAULT=gemini is set. This workspace has no key of its own.
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="quiet"
                disabled={testing}
                onClick={() => handleTest(activeTab)}
              >
                {testing ? "Testing..." : "Test Connection"}
              </Button>
              {activeSummary.source === "workspace" && canAdmin ? (
                <Button
                  type="button"
                  variant="quiet"
                  disabled={saving}
                  onClick={() => handleRemove(activeTab)}
                >
                  Remove Key
                </Button>
              ) : null}
            </div>
          </div>

          {testResult ? (
            <div
              className={`rounded p-3 text-sm border ${
                testResult.status === "READY"
                  ? "bg-success/10 border-success/30 text-success"
                  : "bg-danger/10 border-danger/30 text-danger"
              }`}
            >
              <strong>{testResult.status}</strong>: {testResult.message}{" "}
              {testResult.latencyMs !== undefined ? `(${testResult.latencyMs}ms)` : ""}
            </div>
          ) : null}

          {/* Tab Specific Content */}
          {activeTab === "jev" ? (
            <div className="space-y-6">
              <DecisionEngineSelector organizationId={organizationId} canAdmin={canAdmin} />
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">TypeSafe JEV transport</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="JEV Routing Mode">
                <TextInput value={String(activeSummary.settings.mode)} readOnly />
              </Field>

              <Field label="Preferred Provider">
                <TextInput value={String(activeSummary.settings.preferredProvider)} readOnly />
              </Field>

              <p className="sm:col-span-2 text-xs text-muted">
                The TypeSafe key is saved per workspace. A deployment TypeSafe key is used only when JEV_SHARED_DEFAULT=deployment
                is set, and it is shown as the deployment shared default.
              </p>
              <div className="sm:col-span-2 rounded border border-line bg-panel p-3 text-xs text-muted">
                <strong>OpenRouter is deployment-only.</strong>{" "}
                {summaries?.jev?.settings?.openrouterConfigured
                  ? `This deployment has an OPENROUTER_API_KEY (${summaries.jev.settings.openrouterFingerprint ?? "no fingerprint"}).`
                  : "This deployment has no OPENROUTER_API_KEY."}{" "}
                {summaries?.jev?.settings?.openrouterUsable
                  ? "It is in use, because JEV_SHARED_DEFAULT=deployment is set."
                  : "It is not used. It needs OPENROUTER_API_KEY on this deployment and JEV_SHARED_DEFAULT=deployment. It is never saved per workspace."}
              </div>

              {activeSummary.settings.mode === "compare" ? (
                <div className="sm:col-span-2 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  ⚠️ <strong>Compare Mode Active</strong>: Runs both TypeSafe and OpenRouter in parallel to evaluate
                  decision agreement. Incurs dual API provider fees.
                </div>
              ) : null}

              <p className="sm:col-span-2 text-xs text-muted">
                Routing is set on the deployment (MERIDIAN_JEV_PROVIDER_MODE, MERIDIAN_JEV_PREFERRED_PROVIDER). A routing choice saved in this workspace is not used, so it is not offered.
              </p>
              <div className="sm:col-span-2">
                <Field label="TypeSafe JEV API key (saved per workspace)" error={fieldErrors.apiKey?.message}>
                  <TextInput
                    type="password"
                    placeholder="Enter a TypeSafe JEV key to save or replace it..."
                    {...providerForm.register("apiKey")}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
            </div>
            </div>
          ) : null}

          {activeTab === "production" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cost Preference Strategy" error={fieldErrors.costPreference?.message}>
                <SelectInput
                  {...providerForm.register("costPreference")}
                  disabled={!canAdmin}
                >
                  <option value="BALANCED">Balanced (Standard quality and cost curve)</option>
                  <option value="ZERO_SPEND">Zero Spend / Manual Cloud Handoff</option>
                  <option value="LOWEST_COST">Lowest Cost First</option>
                  <option value="QUALITY_FIRST">Quality First (Gemini Omni / High-Res)</option>
                </SelectInput>
              </Field>

              <div className="sm:col-span-2">
                <Field label="Gemini production API key (Omni video, Veo, image)" error={fieldErrors.apiKey?.message}>
                  <TextInput
                    type="password"
                    placeholder="Enter a Gemini API key to save or replace it..."
                    {...providerForm.register("apiKey")}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
            </div>
          ) : null}

          {activeTab === "production" ? (
            <p className="text-xs text-muted">
              The key is saved per workspace and used only for this workspace&apos;s production calls. A deployment key is
              used only when PRODUCTION_SHARED_DEFAULT=deployment is set. Saving the settings without a new key keeps the
              stored key.
            </p>
          ) : null}

          {activeTab === "cyclone" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cyclone Gateway URL" error={fieldErrors.gatewayUrl?.message}>
                <TextInput
                  {...providerForm.register("gatewayUrl")}
                  placeholder="http://127.0.0.1:4000"
                  disabled={!canAdmin}
                />
              </Field>

              <div className="sm:col-span-2 rounded border border-line bg-panel p-3 text-xs text-muted">
                🔒 <strong>Read-Only Scout Enforcement</strong>: Cyclone observations are strictly read-only. Meridian
                never automates likes, follows, comments, DMs, or competitor interactions.
              </div>
            </div>
          ) : null}

          {activeTab === "sources" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max Crawl Pages Per Run" error={fieldErrors.maxPages?.message}>
                <TextInput
                  {...providerForm.register("maxPages")}
                  type="number"
                  disabled={!canAdmin}
                />
              </Field>
            </div>
          ) : null}

          {activeTab === "perception" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Gemini API Key (perception)" error={fieldErrors.apiKey?.message}>
                  <TextInput
                    type="password"
                    placeholder="Enter a Gemini API key..."
                    {...providerForm.register("apiKey")}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
              <p className="sm:col-span-2 text-xs text-muted">
                Used for still-image and video-frame perception. Saving replaces the stored key. The key is never shown again; only its last four characters are.
              </p>
            </div>
          ) : null}

          <UnsavedChangesBar
            dirty={providerDirty}
            subject="provider settings"
            confirming={discardRequested}
            onConfirmingChange={setDiscardRequested}
            onDiscard={() => { providerForm.reset(storedFieldsOf(summaries)); setDiscardRequested(false); }}
          />
          {canAdmin && activeTab !== "storage" ? (
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                disabled={saving || (activeTab === "perception" && !apiKeyDraft.trim())}
                onClick={() => handleSave(activeTab)}
              >
                {saving ? "Saving..." : `Save ${activeTab.toUpperCase()} Configuration`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
