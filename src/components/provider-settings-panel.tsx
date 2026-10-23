import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type FieldPath } from "react-hook-form";
import { Button, ErrorState, Field, Card, SelectInput, Input } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { UnsavedChangesBar } from "@/components/forms/unsaved-bar";
import { UnsavedChangesGuard } from "@/components/forms/unsaved-guard";
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
    jevKey: "",
    productionKey: "",
    perceptionKey: "",
    costPreference: String(summaries?.production?.settings.costPreference || "BALANCED") as ProviderFieldsInput["costPreference"],
    gatewayUrl: String(summaries?.cyclone?.settings.gatewayUrl || "http://127.0.0.1:4000"),
    maxPages: String(summaries?.sources?.settings.maxPagesPerRun || "50"),
  };
}

/** The categories that take an API key in this panel. Each one has its own key field. */
type KeyCategory = "jev" | "production" | "perception";
const KEY_FIELD: Record<KeyCategory, "jevKey" | "productionKey" | "perceptionKey"> = {
  jev: "jevKey",
  production: "productionKey",
  perception: "perceptionKey",
};
function isKeyCategory(category: ProviderCategory): category is KeyCategory {
  return category === "jev" || category === "production" || category === "perception";
}

/** The fields each category's Save checks and sends. A key field belongs to its own category only. */
const FIELDS_SAVED_BY: Partial<Record<ProviderCategory, Array<FieldPath<ProviderFieldsInput>>>> = {
  jev: ["jevKey"],
  production: ["productionKey", "costPreference"],
  cyclone: ["gatewayUrl"],
  sources: ["maxPages"],
  perception: ["perceptionKey"],
  storage: [],
};

export function ProviderSettingsPanel({ organizationId, canAdmin }: ProviderSettingsPanelProps) {
  const settings = useProviderSettingsQuery(organizationId);
  const summaries = settings.data ? (settings.data as Record<ProviderCategory, ProviderConfigSummary>) : null;
  const loading = settings.isPending;
  const [activeTab, setActiveTab] = useState<ProviderCategory>("jev");
  const [testResult, setTestResult] = useState<{ status: string; message: string; latencyMs?: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // One form for the panel's fields. Each key has its own field, so a key typed for one category is never shown in, or
  // saved with, another. Each field shows the stored value until it is edited, and an edit is kept when the person
  // switches category. Only a saved field takes the new stored value.
  const providerForm = useForm<ProviderFieldsInput>({
    resolver: zodResolver(providerFieldsSchema),
    defaultValues: storedFieldsOf(summaries),
    mode: "onBlur",
  });
  const perceptionKeyDraft = providerForm.watch("perceptionKey");
  const providerDirty = providerForm.formState.isDirty;
  const fieldErrors = providerForm.formState.errors;
  // The discard bar looks at the active category's fields only, so another category's unsaved key is not counted here.
  const activeDirty = (FIELDS_SAVED_BY[activeTab] ?? []).some((name) => Boolean(providerForm.formState.dirtyFields[name]));
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
      // The saved values become the stored values. Only the saved category's key box is cleared, as a key is never shown
      // again. Another category's draft is left as it is.
      if (isKeyCategory(input.category)) providerForm.resetField(KEY_FIELD[input.category], { defaultValue: "" });
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
    const valid = await providerForm.trigger(FIELDS_SAVED_BY[category] ?? []);
    if (!valid) return;
    const values = providerForm.getValues();
    // Only this category's own key field is sent, and only a category that takes a key sends one. A key typed for another
    // category is never sent with this save.
    const credentials: Record<string, string> = {};
    const ownKey = isKeyCategory(category) ? values[KEY_FIELD[category]].trim() : "";
    if (ownKey) {
      credentials.apiKey = ownKey;
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

  // Discard clears only the active category's unsaved edits, so it cannot clear another category's draft.
  function discardActiveCategory() {
    const stored = storedFieldsOf(summaries);
    for (const name of FIELDS_SAVED_BY[activeTab] ?? []) providerForm.resetField(name, { defaultValue: stored[name] });
    setDiscardRequested(false);
  }

  if (settings.isError && !summaries) {
    return <ErrorState message="Provider settings could not be loaded." onRetry={() => void settings.refetch()} />;
  }
  if (loading && !summaries) {
    return <p className="text-muted text-sm">Loading AI and Provider configuration...</p>;
  }

  const activeSummary = summaries ? summaries[activeTab] : null;

  return (
    <Card className="space-y-6">
      <UnsavedChangesGuard dirty={providerDirty} />
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="eyebrow">Architecture & Intelligence</p>
          <h2 className="text-2xl">AI, Research & Provider Configuration</h2>
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
                  setDiscardRequested(false);
                }}
                className={`max-sm:min-h-11 pointer-coarse:min-h-11 rounded px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === tab
                    ? "bg-paper text-fg shadow-sm"
                    : "text-muted hover:text-fg hover:bg-panel"
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
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
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
                {testing ? "Checking..." : "Check key"}
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
                testResult.status === "READY" || testResult.status === "CONFIGURED"
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
              <p className="eyebrow">TypeSafe JEV transport</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <p className="sm:col-span-2 text-xs text-muted">
                TypeSafe is the decision transport. Its key is saved per workspace, and a deployment key is used only when
                JEV_SHARED_DEFAULT=deployment is set. A decision never calls a second provider.
              </p>
              <p className="sm:col-span-2 text-xs text-muted">The TypeSafe key is entered in the Setup section above. It is saved there, and this panel keeps the transport settings only.</p>
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

              <p className="sm:col-span-2 text-xs text-muted">The Gemini production key is entered in the Setup section above. This panel keeps the production settings only.</p>
            </div>
          ) : null}

          {activeTab === "production" ? (
            <p className="text-xs text-muted">
              Production calls use the key saved for this workspace in the Setup section. A deployment key is used only when
              PRODUCTION_SHARED_DEFAULT=deployment is set.
            </p>
          ) : null}

          {activeTab === "cyclone" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cyclone Gateway URL" error={fieldErrors.gatewayUrl?.message}>
                <Input
                  {...providerForm.register("gatewayUrl")}
                  placeholder="http://127.0.0.1:4000"
                  disabled={!canAdmin}
                />
              </Field>

              <div className="sm:col-span-2 border-t border-line pt-3 text-xs text-muted">
                <strong>Read-only observation</strong>: Cyclone observations are read-only. Meridian
                never automates likes, follows, comments, DMs, or competitor interactions.
              </div>
            </div>
          ) : null}

          {activeTab === "sources" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max Crawl Pages Per Run" error={fieldErrors.maxPages?.message}>
                <Input
                  {...providerForm.register("maxPages")}
                  type="number"
                  disabled={!canAdmin}
                />
              </Field>
            </div>
          ) : null}

          {activeTab === "perception" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <p className="sm:col-span-2 text-xs text-muted">The Gemini perception key is entered in the Setup section above. This panel keeps the perception settings only.</p>
              <p className="sm:col-span-2 text-xs text-muted">
                Used for still-image and video-frame perception. Its key is saved in the Setup section above.
              </p>
            </div>
          ) : null}

          <UnsavedChangesBar
            dirty={activeDirty}
            subject="provider settings"
            confirming={discardRequested}
            onConfirmingChange={setDiscardRequested}
            onDiscard={discardActiveCategory}
          />
          {canAdmin && activeTab !== "storage" ? (
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                disabled={saving || (activeTab === "perception" && !perceptionKeyDraft.trim())}
                onClick={() => handleSave(activeTab)}
              >
                {saving ? "Saving..." : `Save ${activeTab.toUpperCase()} Configuration`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
