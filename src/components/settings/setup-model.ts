/**
 * Pure model for the Setup view. It turns the provider summaries and the decision-engine status into one row per provider.
 * Each row names its state (usable, deployment shared default, unusable, not configured), the reason in plain words, a masked
 * fingerprint when a key is saved, and how the row is saved. The model never receives a key: the summaries carry states,
 * reasons and fingerprints only.
 */
import type { ProviderCategory, ProviderConfigSummary } from "@/lib/meridian/settings/provider-config";
import { SHARED_DEFAULT_ENV, SOURCE_CREDENTIAL_CATEGORIES, type CredentialCategory } from "../../lib/meridian/credentials/contract.ts";

export type SetupStatus = "usable" | "deployment_shared_default" | "unusable" | "not_configured";

export type SetupGroup = "decisions" | "media" | "sources" | "other_sources" | "storage";

export const SETUP_GROUPS: ReadonlyArray<{ id: SetupGroup; label: string; hint: string }> = [
  { id: "decisions", label: "Decisions", hint: "One engine answers each decision. Its key is saved here." },
  { id: "media", label: "Perception and production", hint: "Gemini reads images and video frames and makes Omni media. Hypit runs as a separate process." },
  { id: "sources", label: "Research sources", hint: "Meta Ad Library reads the public ad library." },
  { id: "other_sources", label: "Other source connectors", hint: "Each connector keeps its own key. Public page sources need none." },
  { id: "storage", label: "Storage", hint: "Google Drive is configured on the server and shared by the deployment." },
];

/**
 * How a row is saved. A form saves through saveProviderConfig, which is the admin-only server path. A deployment row is set
 * in the server's environment, so the panel names the variables. The engine row is saved by the decision engine card.
 */
export type SetupSave =
  | { kind: "form"; category: CredentialCategory }
  | { kind: "deployment"; variables: string[] }
  | { kind: "engine" };

export type SetupRow = {
  /** A provider category, or "decision_engine" or "google_drive". */
  id: string;
  label: string;
  group: SetupGroup;
  status: SetupStatus;
  /** The reason, in plain words. It names the variable or the step that is missing. It never contains a key. */
  reason: string;
  /** The masked fingerprint of the key in use, or null. */
  fingerprint: string | null;
  /** A second line for the row, or null. */
  note: string | null;
  save: SetupSave;
  /** True when a saved workspace key is in the entry, so an admin can remove it. */
  removable: boolean;
};

/** The decision-engine status the model reads. The health of the active engine is the one that matters for the row. */
export type SetupEngines = {
  active: { engineId: string; source: "workspace" | "deployment" | "default"; invalidDeploymentValue?: string };
  engines: ReadonlyArray<{ id: string; label: string; health: { status: string; message?: string } }>;
};

export type SetupInput = {
  summaries: Record<ProviderCategory, ProviderConfigSummary>;
  engines: SetupEngines;
};

const KEYED_LABEL: Record<CredentialCategory, string> = {
  jev: "TypeSafe JEV",
  openai: "OpenAI Decisions",
  perception: "Gemini perception",
  production: "Gemini production",
  hypit: "Hypit video",
  meta_ad_library: "Meta Ad Library",
  meta_graph: "Meta Graph",
  instagram: "Instagram",
  youtube: "YouTube",
  search: "Search API",
  twitter: "X (Twitter)",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  tiktok: "TikTok",
  licensed: "Licensed ad data",
};

const DRIVE_VARIABLES = ["GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];

const SPECIFIC_GROUP: Partial<Record<CredentialCategory, SetupGroup>> = {
  jev: "decisions",
  openai: "decisions",
  perception: "media",
  production: "media",
  hypit: "media",
  meta_ad_library: "sources",
};

/** Every source connector other than Meta Ad Library is listed under its own group, so it can be folded away. */
function groupOf(category: CredentialCategory): SetupGroup {
  return SPECIFIC_GROUP[category] ?? "other_sources";
}

/** One keyed provider's row. Its status is the resolver's state, with a deployment key named as the shared default. */
function keyedRow(category: CredentialCategory, summary: ProviderConfigSummary): SetupRow {
  const state = summary.credentialState ?? (summary.configured ? "usable" : "not_configured");
  const shared = SHARED_DEFAULT_ENV[category];
  const workspaceKey = state === "usable" && summary.source === "workspace";

  let status: SetupStatus;
  let reason: string;
  if (workspaceKey) {
    status = "usable";
    reason = "The workspace's own saved key is in use.";
  } else if (state === "usable") {
    status = "deployment_shared_default";
    reason = `The deployment's key is in use, because ${shared.variable}=${shared.accepts} is set. This workspace has no key of its own.`;
  } else if (state === "unusable") {
    status = "unusable";
    reason = summary.credentialReason ?? "The saved key cannot be used. Save it again.";
  } else {
    status = "not_configured";
    reason = summary.credentialReason ?? "No key is saved for this workspace.";
  }

  let note: string | null = null;
  // Hypit is a separate runtime. A key without its base URL is not a configured Hypit, so the row says so and keeps the key.
  if (category === "hypit" && !summary.settings.baseUrlConfigured) {
    status = "not_configured";
    reason = "HYPIT_BASE_URL is not set on the deployment, so Hypit is not configured. No Hypit video is requested.";
    note = state === "usable" ? "The saved key is kept. It is used once HYPIT_BASE_URL is set on the server." : null;
  }

  return {
    id: category,
    label: KEYED_LABEL[category],
    group: groupOf(category),
    status,
    reason,
    fingerprint: state === "usable" ? summary.keyFingerprint ?? null : null,
    note,
    save: { kind: "form", category },
    removable: state === "unusable" || workspaceKey,
  };
}

/** The decision-engine row. The choice is saved by the decision engine card, not by this row. */
function decisionEngineRow(engines: SetupEngines): SetupRow {
  const active = engines.engines.find((engine) => engine.id === engines.active.engineId);
  const health = active?.health ?? { status: "NOT_CONFIGURED", message: "The active engine was not reported." };
  const label = active?.label ?? engines.active.engineId;
  const status: SetupStatus = health.status === "READY" ? "usable" : health.status === "NOT_CONFIGURED" ? "not_configured" : "unusable";
  const chosen =
    engines.active.source === "workspace"
      ? "The engine was chosen for this workspace."
      : engines.active.source === "deployment"
        ? "The deployment sets it with DECISION_ENGINE."
        : "No engine is chosen, so the default is used.";
  const invalid = engines.active.invalidDeploymentValue;
  // A ready engine receives the decisions. Any other state says that it cannot answer yet, so the row never implies it does.
  const lead = status === "usable" ? `${label} receives this workspace's decisions.` : `${label} is the active engine, and it cannot answer decisions yet.`;
  return {
    id: "decision_engine",
    label: "Decision engine",
    group: "decisions",
    status,
    reason: `${lead} ${chosen} ${health.message ?? ""}`.trim(),
    fingerprint: null,
    note: invalid ? `DECISION_ENGINE is set to "${invalid}", which is not an engine. The default is in use.` : null,
    save: { kind: "engine" },
    removable: false,
  };
}

/** Google Drive is configured on the deployment. Its row has no key form, and it names the variables that set it. */
function driveRow(summary: ProviderConfigSummary): SetupRow {
  const detail = typeof summary.settings.driveDetail === "string" ? summary.settings.driveDetail : "Google Drive status was not reported.";
  return {
    id: "google_drive",
    label: "Google Drive",
    group: "storage",
    status: summary.configured ? "deployment_shared_default" : "not_configured",
    reason: summary.configured
      ? `${detail} The deployment shares these credentials with every workspace.`
      : `${detail} Until Google Drive is connected, files use the filesystem fallback.`,
    fingerprint: null,
    note: null,
    save: { kind: "deployment", variables: DRIVE_VARIABLES },
    removable: false,
  };
}

/** The rows in the order the Setup view lists them. Every keyed category appears exactly once. */
export function setupRows(input: SetupInput): SetupRow[] {
  const { summaries, engines } = input;
  const rows: SetupRow[] = [
    decisionEngineRow(engines),
    keyedRow("jev", summaries.jev),
    keyedRow("openai", summaries.openai),
    keyedRow("perception", summaries.perception),
    keyedRow("production", summaries.production),
    keyedRow("hypit", summaries.hypit),
    keyedRow("meta_ad_library", summaries.meta_ad_library),
    ...SOURCE_CREDENTIAL_CATEGORIES.filter((category) => category !== "meta_ad_library").map((category) =>
      keyedRow(category, summaries[category]),
    ),
    driveRow(summaries.storage),
  ];
  return rows;
}

/** The rows of one group, in their listed order. */
export function rowsIn(rows: SetupRow[], group: SetupGroup): SetupRow[] {
  return rows.filter((row) => row.group === group);
}

/** How many rows are in each state. The panel's headline is built from these counts. */
export function setupCounts(rows: SetupRow[]): Record<SetupStatus, number> & { total: number } {
  const counts = { usable: 0, deployment_shared_default: 0, unusable: 0, not_configured: 0, total: rows.length };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** The one-line headline above the rows. It states counts only, so it never claims a provider was reached. */
export function setupHeadline(rows: SetupRow[]): string {
  const counts = setupCounts(rows);
  const parts = [
    `${counts.usable} usable`,
    `${counts.deployment_shared_default} shared by the deployment`,
    `${counts.unusable} unusable`,
    `${counts.not_configured} not configured`,
  ];
  return `${parts.join(", ")}, of ${counts.total} rows. Nothing is checked against a live provider here.`;
}
