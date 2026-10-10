import { useState, useEffect } from "react";
import { Button, Field, Notice, Panel, TextInput } from "@/components/ui";
import {
  getProviderSettings,
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
  if (summary.category === "perception") {
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

export function ProviderSettingsPanel({ organizationId, canAdmin }: ProviderSettingsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [summaries, setSummaries] = useState<Record<ProviderCategory, ProviderConfigSummary> | null>(null);
  const [activeTab, setActiveTab] = useState<ProviderCategory>("jev");
  const [testResult, setTestResult] = useState<{ status: string; message: string; latencyMs?: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Form states for active category
  const [apiKeyInput, setApiKeyInput] = useState("");
  // Bumped on every reload, so the decision-engine card re-reads its status after a key is saved or removed.
  const [loadCount, setLoadCount] = useState(0);
  const [gatewayUrlInput, setGatewayUrlInput] = useState("http://127.0.0.1:4000");
  const [maxPagesInput, setMaxPagesInput] = useState("50");

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const data = await getProviderSettings({ data: { organizationId } });
      setSummaries(data);
      setLoadCount((count) => count + 1);
      if (data.cyclone) {
        setGatewayUrlInput(String(data.cyclone.settings.gatewayUrl || "http://127.0.0.1:4000"));
      }
      if (data.sources) {
        setMaxPagesInput(String(data.sources.settings.maxPagesPerRun || "50"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load provider settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  async function handleTest(category: ProviderCategory) {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testProviderConnection({ data: { organizationId, category } });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        status: "ERROR",
        message: err instanceof Error ? err.message : "Test failed.",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(category: ProviderCategory) {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const credentials: Record<string, string> = {};
      if (apiKeyInput.trim()) {
        credentials.apiKey = apiKeyInput.trim();
      }

      const settings: Record<string, unknown> = {};
      if (category === "cyclone") {
        settings.gatewayUrl = gatewayUrlInput;
      } else if (category === "sources") {
        settings.maxPages = Number(maxPagesInput);
      }

      await saveProviderConfig({
        data: {
          organizationId,
          category,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          settings,
        },
      });

      setMessage(`${category.toUpperCase()} configuration saved.`);
      setApiKeyInput("");
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(category: ProviderCategory) {
    setSaving(true);
    try {
      await removeProviderConfig({ data: { organizationId, category } });
      setMessage(`Workspace ${category} credentials removed.`);
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove credential.");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !summaries) {
    return <p className="text-muted text-sm">Loading AI and Provider configuration...</p>;
  }

  const activeSummary = summaries ? summaries[activeTab] : null;

  return (
    <Panel className="space-y-6">
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
            const isReady = sum?.configured;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setActiveTab(tab);
                  setTestResult(null);
                  setError(null);
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

      {error ? <Notice>{error}</Notice> : null}
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
              <DecisionEngineSelector key={loadCount} organizationId={organizationId} canAdmin={canAdmin} />
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">TypeSafe JEV transport</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="JEV Routing Mode">
                <TextInput value={String(activeSummary.settings.mode)} readOnly />
              </Field>

              <Field label="Preferred Provider">
                <TextInput value={String(activeSummary.settings.preferredProvider)} readOnly />
              </Field>

              {activeSummary.settings.mode === "compare" ? (
                <div className="sm:col-span-2 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  ⚠️ <strong>Compare Mode Active</strong>: Runs both TypeSafe and OpenRouter in parallel to evaluate
                  decision agreement. Incurs dual API provider fees.
                </div>
              ) : null}

              <div className="sm:col-span-2">
                <Field label="Replace TypeSafe API Key (Encrypted in Vault)">
                  <TextInput
                    type="password"
                    placeholder="Enter new key to update..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
              <p className="sm:col-span-2 text-xs text-muted">
                Routing is set on the deployment (MERIDIAN_JEV_PROVIDER_MODE, MERIDIAN_JEV_PREFERRED_PROVIDER). The OpenRouter key is set on the deployment (OPENROUTER_API_KEY) and is not stored in this workspace.
                Without a saved TypeSafe key, the deployment&apos;s TypeSafe key is used only when JEV_SHARED_DEFAULT=deployment is set.
              </p>
            </div>
            </div>
          ) : null}

          {activeTab === "production" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Replace Production Provider Key (Omni / Google AI Studio)">
                  <TextInput
                    type="password"
                    placeholder="Enter new production API key..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
              <p className="sm:col-span-2 text-xs text-muted">
                Models are set on the deployment (MERIDIAN_GEMINI_OMNI_MODEL, MERIDIAN_IMAGE_MODEL): {String(activeSummary.settings.omniModel)} and {String(activeSummary.settings.imageModel)}.
                Without a saved key, the deployment&apos;s Gemini key is used only when PRODUCTION_SHARED_DEFAULT=deployment is set.
                Hypit video runtime: {activeSummary.settings.hypitConfigured ? "HYPIT_BASE_URL is set." : "HYPIT_BASE_URL is not set."}
              </p>
            </div>
          ) : null}

          {activeTab === "cyclone" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cyclone Gateway URL">
                <TextInput
                  value={gatewayUrlInput}
                  onChange={(e) => setGatewayUrlInput(e.target.value)}
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
              <Field label="Max Crawl Pages Per Run">
                <TextInput
                  type="number"
                  value={maxPagesInput}
                  onChange={(e) => setMaxPagesInput(e.target.value)}
                  disabled={!canAdmin}
                />
              </Field>
            </div>
          ) : null}

          {activeTab === "perception" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Gemini API Key (perception)">
                  <TextInput
                    type="password"
                    placeholder="Enter a Gemini API key..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
              <p className="sm:col-span-2 text-xs text-muted">
                Used for still-image and video-frame perception. Saving replaces the stored key. The key is never shown again; only its last four characters are.
              </p>
            </div>
          ) : null}

          {canAdmin && activeTab !== "storage" ? (
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                disabled={saving || (activeTab === "perception" && !apiKeyInput.trim())}
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
