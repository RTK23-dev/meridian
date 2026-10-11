/**
 * Pure model for the integrations page. It turns the stored system status and provider summaries into one card per
 * provider. Each card names its state, the server's own detail, and the step that is missing. A missing step is an
 * environment variable name or an OAuth step. A key value never appears here, and neither does a key fingerprint.
 */
import type { getSystemStatus } from "@/lib/meridian/system";
import type { ProviderCategory, ProviderConfigSummary } from "@/lib/meridian/settings/provider-config";

export type SystemStatus = Awaited<ReturnType<typeof getSystemStatus>>;
export type ProviderSummaries = Record<ProviderCategory, ProviderConfigSummary>;

export type IntegrationGroup = "ads" | "research" | "generation" | "infrastructure";

export const INTEGRATION_GROUPS: ReadonlyArray<{ id: IntegrationGroup; label: string; hint: string }> = [
  { id: "ads", label: "Ads", hint: "Accounts that report or publish ads." },
  { id: "research", label: "Research", hint: "Sources and indexes that read evidence." },
  { id: "generation", label: "Generation", hint: "Models and runtimes that decide and make media." },
  { id: "infrastructure", label: "Infrastructure", hint: "Storage, delivery, and background processes." },
];

export type IntegrationId =
  | "meta" | "tiktok" | "google" | "ad_library"
  | "google_ai_studio" | "embeddings"
  | "hypit"
  | "s3" | "email";

/** account: connected through OAuth or a stored token. key: a workspace key can be saved. deployment: set on the server only. */
export type CardKind = "account" | "key" | "deployment";

export type CardModel = {
  id: IntegrationId;
  label: string;
  group: IntegrationGroup;
  kind: CardKind;
  /** The value passed to StatusBadge. It is one of the server's phases or a status from the status map. */
  status: string;
  summary: string;
  /** The missing environment variable or OAuth step, or null when nothing is missing. */
  missing: string | null;
  /** Short extra facts such as the key source or the account name. */
  facts: string[];
  /** True when a workspace key is saved for this provider, so the workspace can remove it. */
  workspaceKey?: boolean;
};

/** Provider settings are a separate read. While they load, or when they fail, the cards that need them say so. */
export type SummaryState = { state: "ready"; value: ProviderSummaries } | { state: "loading" } | { state: "error" };

const ACCOUNT_LABEL: Record<"meta" | "tiktok" | "google" | "ad_library", string> = {
  meta: "Meta",
  tiktok: "TikTok",
  google: "Google Ads",
  ad_library: "Meta Ad Library",
};

const ACCOUNT_GROUP: Record<keyof typeof ACCOUNT_LABEL, IntegrationGroup> = {
  meta: "ads",
  tiktok: "ads",
  google: "ads",
  ad_library: "research",
};

const OAUTH_PROVIDERS = new Set<keyof typeof ACCOUNT_LABEL>(["meta", "tiktok", "google"]);

const ACCOUNT_MISSING: Record<keyof typeof ACCOUNT_LABEL, string> = {
  meta: "Connect with Meta OAuth, or set META_ACCESS_TOKEN on the server. META_AD_ACCOUNT_ID is needed to publish.",
  tiktok: "Connect with TikTok OAuth, or set TIKTOK_ACCESS_TOKEN and TIKTOK_ADVERTISER_ID on the server.",
  google: "Connect with Google OAuth, or set GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_ACCESS_TOKEN on the server.",
  ad_library: "Set META_AD_LIBRARY_TOKEN on the server. No ads are collected until a request succeeds.",
};

/** Phases for an account row. The server phase is used as the badge status, so the badge says exactly what it reports. */
export function accountCard(
  provider: keyof typeof ACCOUNT_LABEL,
  connection: { phase: string; detail: string; accountName: string; accountId: string; lastSuccessAt?: string | null } | undefined,
): CardModel {
  const phase = connection?.phase ?? "NOT_CONFIGURED";
  const detail = connection?.detail ?? "No connection state was reported for this provider.";
  let missing: string | null = null;
  if (phase === "NOT_CONFIGURED") {
    // Credentials that are present, with no successful request yet, are a different step from missing credentials.
    missing = detail.startsWith("Credentials are present")
      ? "Test the connection to record a successful request. Until then this is not connected."
      : ACCOUNT_MISSING[provider];
  } else if (phase === "DISCONNECTED") {
    missing = OAUTH_PROVIDERS.has(provider) ? "Connect again with OAuth to send requests." : "Test the connection to send requests again.";
  } else if (phase === "FAILED") {
    missing = "The last request failed. Test the connection, then reconnect if it still fails.";
  } else if (phase === "DEGRADED") {
    missing = "The last successful request is stale. Test the connection to refresh it.";
  }
  const facts: string[] = [];
  if (connection && (connection.accountName || connection.accountId)) {
    facts.push(`Account ${connection.accountName || "unnamed"}${connection.accountId ? ` · ${connection.accountId}` : ""}`);
  }
  facts.push(lastSuccessFact(connection?.lastSuccessAt ?? null));
  return {
    id: provider,
    label: ACCOUNT_LABEL[provider],
    group: ACCOUNT_GROUP[provider],
    kind: "account",
    status: phase,
    summary: detail,
    missing,
    facts,
  };
}

/** The stored time of the last successful request, or a plain statement that none is recorded. Never a guessed time. */
export function lastSuccessFact(lastSuccessAt: string | null): string {
  if (!lastSuccessAt) return "No successful request is recorded yet.";
  const time = Date.parse(lastSuccessAt);
  return Number.isNaN(time) ? "Last successful request: time not readable." : `Last successful request: ${new Date(time).toLocaleString()}.`;
}

/** One card per provider, grouped by where it sits in the product. A status that the server does not report is shown as such. */
export function integrationCards(input: { status: SystemStatus; summaries: SummaryState }): CardModel[] {
  const { status, summaries } = input;
  const connection = (provider: keyof typeof ACCOUNT_LABEL) => status.connections.find((row) => row.provider === provider);
  const ready = summaries.state === "ready" ? summaries.value : null;
  return [
    accountCard("meta", connection("meta")),
    accountCard("tiktok", connection("tiktok")),
    accountCard("google", connection("google")),
    accountCard("ad_library", connection("ad_library")),
    ready ? perceptionCard(ready.perception) : unavailableCard("google_ai_studio", "Google AI Studio", "research", "key", summaries.state),
    embeddingsCard(status),
    ready ? hypitCard(ready.production) : unavailableCard("hypit", "Hypit video", "generation", "deployment", summaries.state),
    s3Card(status),
    emailCard(status),
  ];
}

/** Shown in place of a card whose settings have not arrived. It never claims a status it has not read. */
function unavailableCard(id: IntegrationId, label: string, group: IntegrationGroup, kind: CardKind, state: SummaryState["state"]): CardModel {
  const loading = state === "loading";
  return {
    id, label, group, kind,
    status: loading ? "LOADING" : "NOT_REPORTED",
    summary: loading ? "Loading provider settings." : "Provider settings could not be loaded. Reload the page to read this status.",
    missing: null,
    facts: [],
  };
}

function perceptionCard(summary: ProviderConfigSummary): CardModel {
  const state = summary.credentialState ?? (summary.configured ? "usable" : "not_configured");
  const source = summary.source === "workspace" ? "Key source: workspace" : summary.source === "deployment" ? "Key source: deployment" : "Key source: none";
  const workspaceKey = summary.source === "workspace";
  if (state === "usable") {
    return {
      id: "google_ai_studio", label: "Google AI Studio", group: "research", kind: "key",
      status: "AVAILABLE",
      summary: "A usable key is present. Test connection checks the key only. The Gemini API is not called.",
      missing: null,
      facts: [source],
      workspaceKey,
    };
  }
  if (state === "unusable") {
    return {
      id: "google_ai_studio", label: "Google AI Studio", group: "research", kind: "key",
      status: "FAILED",
      summary: summary.credentialReason ?? "The saved key cannot be used.",
      missing: "Replace the workspace key in Settings, then test the connection.",
      facts: [source],
      workspaceKey,
    };
  }
  return {
    id: "google_ai_studio", label: "Google AI Studio", group: "research", kind: "key",
    status: "NOT_CONFIGURED",
    summary: summary.credentialReason ?? "No Gemini key is available for this workspace.",
    missing: "Add a workspace key in Settings, or set MERIDIAN_GEMINI_API_KEY on the server. GEMINI_API_KEY also works.",
    facts: [source],
    workspaceKey,
  };
}

function embeddingsCard(status: SystemStatus): CardModel {
  const external = status.embeddings.status === "CONFIGURED";
  return {
    id: "embeddings", label: "Embeddings", group: "research", kind: "deployment",
    status: external ? "AVAILABLE" : "NOT_CONFIGURED",
    summary: status.embeddings.detail,
    missing: external ? null : "Set EXTERNAL_SEMANTIC_URL and EXTERNAL_SEMANTIC_KEY on the server to use the external embeddings API. The local model needs no key.",
    facts: [status.localSemantic.status === "AVAILABLE" ? `Local model ${status.localSemantic.model} is available in process.` : "Local model is not available."],
  };
}

function hypitCard(summary: ProviderConfigSummary): CardModel {
  const configured = Boolean(summary.settings.hypitConfigured);
  return {
    id: "hypit", label: "Hypit video", group: "generation", kind: "deployment",
    status: configured ? "AVAILABLE" : "NOT_CONFIGURED",
    summary: configured
      ? "HYPIT_BASE_URL is set. A clip is stored only after Hypit returns verified MP4 bytes."
      : "No Hypit runtime is configured. No video was requested.",
    missing: configured ? null : "Set HYPIT_BASE_URL and HYPIT_API_TOKEN on the server. Hypit runs as a separate process.",
    facts: [],
  };
}

function s3Card(status: SystemStatus): CardModel {
  const external = status.objectStorage.external === "CONFIGURED";
  return {
    id: "s3", label: "S3 object storage", group: "infrastructure", kind: "deployment",
    status: external ? "AVAILABLE" : "NOT_CONFIGURED",
    summary: status.objectStorage.detail,
    missing: external ? null : "Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY on the server.",
    facts: [`Active store: ${status.objectStorage.active === "s3" ? "S3" : "local filesystem"}`],
  };
}

/** Email delivery is read from the server's state only. The state says whether EMAIL_API_URL and EMAIL_API_KEY are set. */
function emailCard(status: SystemStatus): CardModel {
  const configured = status.email.status === "CONFIGURED";
  return {
    id: "email", label: "Email", group: "infrastructure", kind: "deployment",
    status: configured ? "AVAILABLE" : "NOT_CONFIGURED",
    summary: status.email.detail,
    missing: configured ? null : "Set EMAIL_API_URL and EMAIL_API_KEY on the server. Without them, no invitation email is sent.",
    facts: [],
  };
}

/** Worker, scheduler, and database rows. Each is read from its stored heartbeat, not from a live check. */
export function processRows(status: SystemStatus): Array<{ id: string; label: string; status: string; summary: string }> {
  return [
    {
      id: "worker", label: "Worker", status: status.worker === "running" ? "RUNNING" : "STOPPED",
      summary: status.worker === "running" ? "A fresh heartbeat was recorded in the last 30 seconds." : "No fresh heartbeat. Queued jobs wait until the worker runs.",
    },
    {
      id: "scheduler", label: "Scheduler", status: status.scheduler === "running" ? "RUNNING" : "STOPPED",
      summary: status.scheduler === "running" ? "A fresh heartbeat was recorded in the last 30 seconds." : "No fresh heartbeat. Scheduled checks do not run.",
    },
    {
      id: "database", label: "Database", status: status.database === "up" ? "HEALTHY" : "FAILED",
      summary: status.database === "up" ? "The database answered the status check." : "The database did not answer the status check.",
    },
  ];
}

/** The publishing line is a server fact, shown as text. */
export function publishingLine(status: SystemStatus): string {
  return `${status.publishing.status === "NOT_CONNECTED" ? "Not connected" : status.publishing.status}. ${status.publishing.detail}`;
}
