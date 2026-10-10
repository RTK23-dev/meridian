import { useState, useEffect } from "react";
import { Button, Field, Notice, Panel, SelectInput, TextInput } from "@/components/ui";
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
  const [modeInput, setModeInput] = useState("auto");
  const [preferredProviderInput, setPreferredProviderInput] = useState("typesafe_direct");
  const [costPreferenceInput, setCostPreferenceInput] = useState("BALANCED");
  const [gatewayUrlInput, setGatewayUrlInput] = useState("http://127.0.0.1:4000");
  const [maxPagesInput, setMaxPagesInput] = useState("50");

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const data = await getProviderSettings({ data: { organizationId } });
      setSummaries(data);
      if (data.jev) {
        setModeInput(String(data.jev.settings.mode || "auto"));
        setPreferredProviderInput(String(data.jev.settings.preferredProvider || "typesafe_direct"));
      }
      if (data.production) {
        setCostPreferenceInput(String(data.production.settings.costPreference || "BALANCED"));
      }
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
      if (category === "jev") {
        settings.mode = modeInput;
        settings.preferredProvider = preferredProviderInput;
      } else if (category === "production") {
        settings.costPreference = costPreferenceInput;
      } else if (category === "cyclone") {
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
                <span
                  className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    activeSummary.configured
                      ? "bg-success/20 text-success border border-success/30"
                      : "bg-muted/20 text-muted border border-line"
                  }`}
                >
                  {activeSummary.configured ? "CONFIGURED" : "NOT CONFIGURED"}
                </span>
                <span className="text-xs text-muted">
                  Source: <strong className="uppercase">{activeSummary.source}</strong>
                </span>
              </div>
              {activeSummary.keyFingerprint ? (
                <p className="text-xs text-muted mt-1 font-mono">
                  Stored Key Fingerprint: <strong>{activeSummary.keyFingerprint}</strong>
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
                <SelectInput
                  value={modeInput}
                  onChange={(e) => setModeInput(e.target.value)}
                  disabled={!canAdmin}
                >
                  <option value="auto">Auto (Prefer configured provider with fallback)</option>
                  <option value="typesafe_direct">TypeSafe Direct (System One endpoint only)</option>
                  <option value="openrouter">OpenRouter Decisions API (Strict)</option>
                  <option value="compare">Compare Mode (Run both providers & audit agreement)</option>
                </SelectInput>
              </Field>

              <Field label="Preferred Provider">
                <SelectInput
                  value={preferredProviderInput}
                  onChange={(e) => setPreferredProviderInput(e.target.value)}
                  disabled={!canAdmin}
                >
                  <option value="typesafe_direct">TypeSafe Direct</option>
                  <option value="openrouter">OpenRouter Decisions</option>
                </SelectInput>
              </Field>

              {modeInput === "compare" ? (
                <div className="sm:col-span-2 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  ⚠️ <strong>Compare Mode Active</strong>: Runs both TypeSafe and OpenRouter in parallel to evaluate
                  decision agreement. Incurs dual API provider fees.
                </div>
              ) : null}

              <div className="sm:col-span-2">
                <Field label="Replace API Key (Encrypted in Vault)">
                  <TextInput
                    type="password"
                    placeholder="Enter new key to update..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    disabled={!canAdmin}
                  />
                </Field>
              </div>
            </div>
            </div>
          ) : null}

          {activeTab === "production" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cost Preference Strategy">
                <SelectInput
                  value={costPreferenceInput}
                  onChange={(e) => setCostPreferenceInput(e.target.value)}
                  disabled={!canAdmin}
                >
                  <option value="BALANCED">Balanced (Standard quality and cost curve)</option>
                  <option value="ZERO_SPEND">Zero Spend / Manual Cloud Handoff</option>
                  <option value="LOWEST_COST">Lowest Cost First</option>
                  <option value="QUALITY_FIRST">Quality First (Gemini Omni / High-Res)</option>
                </SelectInput>
              </Field>

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

          {canAdmin && activeTab !== "storage" ? (
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                disabled={saving}
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
