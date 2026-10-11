/**
 * Workspace Provider Configuration Service
 *
 * Provides typed, secure, organization-scoped credential and operational configuration for JEV, OpenAI Decisions, Perception,
 * Production, Hypit, each Sources connector, Storage, and Cyclone Scout.
 *
 * Rules:
 * - Every credential category is read through the one resolver, credentials/resolve.ts. The summary, Test Connection, the
 *   setup view and runtime readiness all show that resolver's state, so they cannot disagree with a call.
 * - A saved workspace key is used first. An unusable saved key is shown as unusable, and the deployment key is never shown
 *   in its place. The deployment key is shown only when its category's shared default is opted in.
 * - A keyed category saves its key in its own vault entry (CREDENTIAL_VAULT_TYPE) through one path. A save that supplies no
 *   key keeps the stored one, and a removal deletes only that entry.
 * - Server-only encryption at rest via the vault. Raw secrets never leave the server; only masked fingerprints do.
 * - Saves and removals run in one real transaction. A save that supplies no new key keeps the stored key.
 * - Enforces SSRF prevention via publicUrlIssue before testing any configurable endpoint.
 * - Audits all credential mutations without logging secret values.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { withTransaction } from "../learning/store.ts";
import { storeVaultCredential, retrieveVaultCredential, deleteVaultCredential, type VaultCredentialPayload } from "../vault/service.ts";
import { resolveJevConfig } from "../jev/config.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import { isCostMode, resolveCostMode } from "../production/cost-mode.ts";
import { CREDENTIAL_VAULT_TYPE, credentialStateOf, type CredentialCategory, type CredentialState } from "../credentials/contract.ts";
import { selectPerceptionProvider } from "../perception/run.ts";
import { publicUrlIssue } from "../sources/public-url.ts";
import { getGoogleDriveAuthStatus } from "../storage/google-auth.ts";
import { PAGE_LIMIT_MESSAGE, parsePageLimit } from "./page-limit.ts";

/**
 * Every provider category the settings summary and the save path know. The keyed categories are the resolver's categories:
 * each saves one key in its own vault entry. `sources`, `storage` and `cyclone` hold settings, not a resolver key.
 */
export type ProviderCategory = "sources" | "storage" | "cyclone" | CredentialCategory;

/** The categories that save a key in their own vault entry, read through the resolver. */
export const KEYED_PROVIDER_CATEGORIES = Object.keys(CREDENTIAL_VAULT_TYPE) as CredentialCategory[];

const SETTINGS_ONLY_CATEGORIES = ["sources", "storage", "cyclone"] as const;

export function isProviderCategory(value: unknown): value is ProviderCategory {
  if (typeof value !== "string") return false;
  return (SETTINGS_ONLY_CATEGORIES as readonly string[]).includes(value) || (KEYED_PROVIDER_CATEGORIES as readonly string[]).includes(value);
}

function isKeyedCategory(category: ProviderCategory): category is CredentialCategory {
  return (KEYED_PROVIDER_CATEGORIES as readonly string[]).includes(category);
}

/** The name a reviewer sees in a message. It contains no secret. */
const KEY_LABEL: Record<CredentialCategory, string> = {
  jev: "TypeSafe JEV",
  openai: "OpenAI",
  perception: "Gemini",
  production: "Gemini production",
  hypit: "Hypit",
  meta_ad_library: "Meta Ad Library",
  meta_graph: "Meta Graph",
  instagram: "Instagram",
  youtube: "YouTube",
  search: "search",
  twitter: "X (Twitter)",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  tiktok: "TikTok",
  licensed: "licensed data",
};

/** Readiness as the resolver reports it. "usable" means a call would use the credential shown. */
export type CredentialReadiness = CredentialState["state"];
/** @deprecated Use CredentialReadiness. Kept so existing imports keep compiling. */
export type PerceptionCredentialState = CredentialReadiness;

export type ProviderConfigSummary = {
  category: ProviderCategory;
  configured: boolean;
  /** Where the credential comes from. "not_configured" means no credential is available. */
  source: "workspace" | "deployment" | "default" | "not_configured";
  /** Set for every credential category. It is the resolver's state, and it is the only readiness the panel shows. */
  credentialState?: CredentialReadiness;
  /** Why the credential is not usable, in words that contain no secret. Set when credentialState is not "usable". */
  credentialReason?: string;
  keyFingerprint?: string;
  lastTestedStatus?: "READY" | "ERROR" | "NOT_CONFIGURED";
  lastTestedAt?: string;
  lastTestedMessage?: string;
  settings: Record<string, any>;
  capabilities: string[];
};

function fingerprint(secret?: string): string | undefined {
  if (!secret || secret.trim().length < 8) return undefined;
  const clean = secret.trim();
  return `...${clean.slice(-4)}`;
}

/** The vault entry type for a category: its resolver entry for a keyed category, its settings entry otherwise. */
function vaultTypeForCategory(category: ProviderCategory): string {
  return isKeyedCategory(category) ? CREDENTIAL_VAULT_TYPE[category] : `provider_config:${category}`;
}

/** The resolver's state for a credential category, and the reason it is not usable when it is not. */
async function credentialStateFor(sql: Sql, organizationId: string, category: CredentialCategory): Promise<CredentialState> {
  return credentialStateOf(await resolveCredential(sql, organizationId, category));
}

/**
 * Perception also depends on the provider selection: PERCEPTION_PROVIDER=none turns it off, whatever key is saved. Settings
 * and Test Connection both apply that first, as a perception run does.
 */
async function perceptionStateFor(sql: Sql, organizationId: string): Promise<CredentialState> {
  const selection = selectPerceptionProvider();
  if (!selection.provider) return { state: "not_configured", source: null, fingerprint: null, reason: selection.reason };
  return credentialStateFor(sql, organizationId, "perception");
}

/** How the summary names the source. An unusable workspace entry is still the workspace's own entry. */
function sourceOf(state: CredentialState): ProviderConfigSummary["source"] {
  if (state.state === "not_configured") return "not_configured";
  if (state.state === "unusable") return "workspace";
  return state.source === "workspace" ? "workspace" : "deployment";
}

/** Only a failure is recorded. READY is never inferred from a usable key, because nothing has been tested yet. */
function lastTestedStatusOf(state: CredentialState): "ERROR" | undefined {
  return state.state === "unusable" ? "ERROR" : undefined;
}

/** A credential category's summary fields, all taken from the resolver's state. */
function credentialFields(state: CredentialState) {
  return {
    configured: state.state === "usable",
    source: sourceOf(state),
    credentialState: state.state,
    credentialReason: state.state === "usable" ? undefined : state.reason ?? undefined,
    keyFingerprint: state.state === "usable" && state.fingerprint ? state.fingerprint : undefined,
    lastTestedStatus: lastTestedStatusOf(state),
    lastTestedMessage: state.state === "usable" ? undefined : state.reason ?? undefined,
  };
}

/** The summary of a keyed category with no settings of its own: its state and fingerprint, never its key. */
function keyedSummary(category: CredentialCategory, state: CredentialState, settings: Record<string, any> = {}): ProviderConfigSummary {
  return { category, ...credentialFields(state), settings, capabilities: [] };
}

/** The stored settings of a vault entry. An entry that cannot be decrypted contributes no settings, and no key. */
async function savedSettings(sql: Sql, organizationId: string, entryId: string | undefined): Promise<Record<string, any>> {
  if (!entryId) return {};
  try {
    return (await retrieveVaultCredential(sql, organizationId, entryId))?.customFields ?? {};
  } catch {
    return {};
  }
}

/** The keyed categories that have a summary of their own above. Every other keyed category gets the generic keyed summary. */
const SPECIFIC_KEYED: ReadonlySet<CredentialCategory> = new Set<CredentialCategory>(["jev", "perception", "production"]);

/**
 * Retrieves safe summarized configuration across all provider categories for an organization.
 * Never exposes raw secret bytes.
 */
export async function getWorkspaceProviderSettings(
  sql: Sql,
  organizationId: string
): Promise<Record<ProviderCategory, ProviderConfigSummary>> {
  const rows = await sql<{ id: string; credential_type: string; updated_at: string }>`
    select id, credential_type, updated_at
    from credential_vault
    where organization_id = ${organizationId}
      and credential_type like 'provider_config:%'
  `;
  const vaultMap = new Map<string, { id: string }>();
  for (const r of rows) vaultMap.set(r.credential_type, { id: r.id });

  // 1. JEV: the TypeSafe key is the workspace's own, through the resolver. It is the only JEV transport.
  const jevState = await credentialStateFor(sql, organizationId, "jev");
  const jevSummary: ProviderConfigSummary = {
    category: "jev",
    ...credentialFields(jevState),
    settings: {
      timeoutMs: resolveJevConfig().timeoutMs,
      typesafeModel: resolveJevConfig().typesafe.model,
    },
    capabilities: ["choice_decisions", "score_decisions", "noul_probabilities", "evidence_audit_trail"],
  };

  // 2. Perception: the same resolver perception calls use, after the provider selection.
  const perceptionState = await perceptionStateFor(sql, organizationId);
  const perceptionSummary: ProviderConfigSummary = {
    category: "perception",
    ...credentialFields(perceptionState),
    settings: {
      provider: "gemini",
      model: process.env.PERCEPTION_MODEL || "gemini-2.5-flash",
      modalities: ["image", "video_frames", "ocr"],
    },
    capabilities: ["video_transcription", "scene_detection", "ocr_extraction", "multimodal_pacing"],
  };

  // 3. Every other keyed category (OpenAI, Hypit, each source connector) is read through the same resolver, in parallel.
  const genericCategories = KEYED_PROVIDER_CATEGORIES.filter((category) => !SPECIFIC_KEYED.has(category));
  const genericStates = await Promise.all(genericCategories.map((category) => credentialStateFor(sql, organizationId, category)));
  const genericSummaries = genericCategories.map((category, index) =>
    keyedSummary(category, genericStates[index], category === "hypit" ? { baseUrlConfigured: Boolean(process.env.HYPIT_BASE_URL?.trim()) } : {}),
  );
  const metaAdState = genericStates[genericCategories.indexOf("meta_ad_library")];

  // 4. Sources & Crawling Category: the crawl settings. The Meta Ad Library key is its own entry, read above.
  const sourcesEntryId = vaultMap.get(vaultTypeForCategory("sources"))?.id;
  const sourcesCustom = await savedSettings(sql, organizationId, sourcesEntryId);

  const sourcesSummary: ProviderConfigSummary = {
    category: "sources",
    configured: true,
    source: sourcesEntryId ? "workspace" : "default",
    settings: {
      maxPagesPerRun: Number(sourcesCustom.maxPages || 50),
      maxDepth: Number(sourcesCustom.maxDepth || 2),
      concurrency: Number(sourcesCustom.concurrency || 4),
      metaAdLibraryConfigured: metaAdState.state === "usable",
      metaAdLibraryFingerprint: metaAdState.fingerprint,
      allowedSources: ["website", "instagram", "tiktok", "youtube", "meta_ad_library"],
    },
    capabilities: ["public_page_scrape", "meta_ad_library", "open_graph", "json_ld", "repeated_card_discovery"],
  };

  // 5. Production: the Omni video and Google image key is the workspace's own, through the resolver.
  const productionState = await credentialStateFor(sql, organizationId, "production");
  const productionSettings = await savedSettings(sql, organizationId, vaultMap.get(vaultTypeForCategory("production"))?.id);
  const prodSummary: ProviderConfigSummary = {
    category: "production",
    ...credentialFields(productionState),
    settings: {
      // The same resolution the studio routes a run with (production/cost-mode.ts).
      costPreference: resolveCostMode(productionSettings.costPreference),
      hypitConfigured: Boolean(process.env.HYPIT_BASE_URL),
    },
    capabilities: ["gemini_omni_video", "image_to_video", "manual_cloud_handoff", "durable_job_polling"],
  };

  // 6. Storage Category: Google Drive is configured on the deployment, not per workspace.
  const driveStatus = getGoogleDriveAuthStatus();
  const storageSummary: ProviderConfigSummary = {
    category: "storage",
    configured: driveStatus.configured,
    source: driveStatus.configured ? "deployment" : "default",
    settings: {
      primaryProvider: "google_drive",
      fallbackProvider: "filesystem",
      s3Configured: Boolean(process.env.S3_BUCKET),
      driveDetail: driveStatus.detail,
    },
    capabilities: ["oauth_google_drive", "checksum_verification", "zero_fake_completion"],
  };

  // 7. Cyclone Scout Category
  const cycloneEntryId = vaultMap.get(vaultTypeForCategory("cyclone"));
  const cycloneCreds = cycloneEntryId ? await savedCycloneCredentials(sql, organizationId, cycloneEntryId.id) : null;
  const cycloneGatewayUrl = (cycloneCreds?.customFields?.gatewayUrl as string) || process.env.CYCLONE_GATEWAY_URL;
  const cycloneApiKey = cycloneCreds?.apiKey || process.env.CYCLONE_API_KEY;
  const cycloneConfigured = Boolean(cycloneGatewayUrl);

  const cycloneSummary: ProviderConfigSummary = {
    category: "cyclone",
    configured: cycloneConfigured,
    source: cycloneCreds?.apiKey || cycloneCreds?.customFields?.gatewayUrl ? "workspace" : (process.env.CYCLONE_GATEWAY_URL ? "deployment" : "default"),
    keyFingerprint: fingerprint(cycloneApiKey),
    settings: {
      gatewayUrl: cycloneGatewayUrl || "http://127.0.0.1:4000",
      deviceId: cycloneCreds?.customFields?.deviceId || process.env.CYCLONE_DEVICE_ID || "",
      observationBudget: Number(cycloneCreds?.customFields?.observationBudget || process.env.CYCLONE_OBSERVATION_BUDGET || 20),
      readOnlyMode: true,
    },
    capabilities: ["device_discovery", "page_card_observation", "session_binding", "zero_mutation_research"],
  };

  const summaries = {
    jev: jevSummary,
    perception: perceptionSummary,
    sources: sourcesSummary,
    production: prodSummary,
    storage: storageSummary,
    cyclone: cycloneSummary,
  } as Record<ProviderCategory, ProviderConfigSummary>;
  for (const summary of genericSummaries) summaries[summary.category] = summary;
  return summaries;
}

/** The Cyclone entry's payload, or null when it cannot be read. Cyclone is not a resolver category. */
async function savedCycloneCredentials(sql: Sql, organizationId: string, entryId: string): Promise<VaultCredentialPayload | null> {
  try {
    return await retrieveVaultCredential(sql, organizationId, entryId);
  } catch {
    return null;
  }
}

/** One save as the service receives it. */
type SaveInput = {
  organizationId: string;
  actorId: string;
  category: ProviderCategory;
  credentials?: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
  };
  settings?: Record<string, unknown>;
};

/**
 * Saves or updates workspace credentials and operational settings for a category.
 *
 * A keyed category saves its key in its own vault entry, read through the resolver. That covers the TypeSafe, Gemini and
 * Hypit keys, OpenAI, and each source connector (Meta Ad Library included). The replacement runs in one transaction: the old
 * entry is removed and the new one written, or neither happens. A save that supplies no new key keeps the stored key and its
 * expiry. A save for a keyed category with no key, and no stored key to keep, is refused, so an empty entry is never created.
 * A new key keeps the stored settings of the entry, unless the save supplies settings of its own.
 *
 * The legacy sources form may still carry a Meta Ad Library token. That token is saved in its own entry, and a save that carries
 * only the token writes no sources setting.
 */
export async function saveWorkspaceProviderConfig(
  sql: Sql,
  input: SaveInput
): Promise<{ success: boolean; category: ProviderCategory }> {
  if (!isProviderCategory(input.category)) {
    throw new Error(`Unknown provider category: ${String(input.category)}.`);
  }

  // A page limit is a whole number of pages, 1 or more. It is stored as that number, so a fraction, a negative or text never lands.
  if (input.settings && "maxPages" in input.settings) {
    const pages = parsePageLimit(input.settings.maxPages);
    if (pages === null) throw new Error(PAGE_LIMIT_MESSAGE);
    input = { ...input, settings: { ...input.settings, maxPages: pages } };
  }

  // Validate URLs in settings to prevent SSRF
  if (input.settings) {
    for (const [key, val] of Object.entries(input.settings)) {
      if (typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"))) {
        const issue = publicUrlIssue(val);
        // Permit 127.0.0.1/localhost only for cyclone gateway or test mocks if explicitly configured
        if (issue && !(key.includes("cyclone") && val.includes("127.0.0.1"))) {
          throw new Error(`Invalid URL for ${key}: ${issue}`);
        }
      }
    }
  }

  // The Meta Ad Library key is a credential, so it is saved in its own entry and never in the sources settings.
  let metaAdLibraryKey = "";
  if (input.category === "sources" && input.settings && "metaAdLibraryToken" in input.settings) {
    const { metaAdLibraryToken, ...rest } = input.settings;
    metaAdLibraryKey = typeof metaAdLibraryToken === "string" ? metaAdLibraryToken.trim() : "";
    input = { ...input, settings: rest };
  }

  // A save that carries only the Meta token changes no sources setting, so it writes no sources entry.
  const onlyMetaToken = Boolean(metaAdLibraryKey) && Object.keys(input.settings ?? {}).length === 0;
  if (!onlyMetaToken) await saveEntry(sql, input);

  if (metaAdLibraryKey) {
    await saveWorkspaceProviderConfig(sql, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      category: "meta_ad_library",
      credentials: { apiKey: metaAdLibraryKey },
    });
  }

  return { success: true, category: input.category };
}

/** Writes one category's entry, replacing the previous one, in one transaction with its audit record. */
async function saveEntry(sql: Sql, input: SaveInput): Promise<void> {
  const credentialType = vaultTypeForCategory(input.category);
  const newKey = input.credentials?.apiKey?.trim() ?? "";
  const keyed = isKeyedCategory(input.category);

  await withTransaction(sql, async (tx) => {
    const existing = await tx<{ id: string; expires_at: unknown }>`
      select id, expires_at from credential_vault
      where organization_id = ${input.organizationId} and credential_type = ${credentialType}
      limit 1
    `;
    const prior = existing[0];

    // The stored payload is read so its key is kept when no new key is given, and its settings are kept when none are given.
    // A new key does not need the old payload, so an unreadable old entry never blocks its replacement.
    let kept: VaultCredentialPayload | null = null;
    if (prior) {
      try {
        kept = await retrieveVaultCredential(tx, input.organizationId, prior.id);
      } catch {
        if (!newKey) {
          throw new Error("The stored key for this workspace cannot be read, so it cannot be kept. Enter the key again to save.");
        }
      }
    }
    const keptKey = kept?.apiKey?.trim() ?? "";
    if (keyed && !newKey && !keptKey) {
      throw new Error(`Enter an API key for ${KEY_LABEL[input.category as CredentialCategory]} to save this configuration.`);
    }

    if (input.category === "production" && input.settings && "costPreference" in input.settings && !isCostMode(input.settings.costPreference)) {
      throw new Error("Choose a cost mode: ZERO_SPEND, LOWEST_COST, BALANCED or QUALITY_FIRST.");
    }

    const payload: VaultCredentialPayload = {
      accessToken: input.credentials?.accessToken || (newKey ? "" : kept?.accessToken) || "",
      apiKey: newKey || keptKey,
      refreshToken: input.credentials?.refreshToken || (newKey ? "" : kept?.refreshToken) || "",
      customFields: input.category === "jev" ? {} : input.settings ?? kept?.customFields ?? {},
    };
    // A new key starts a new entry with no expiry. Keeping the stored key keeps its expiry too.
    const keptExpiry = !newKey && prior?.expires_at ? toDate(prior.expires_at) : undefined;

    if (prior) await deleteVaultCredential(tx, input.organizationId, prior.id);
    await storeVaultCredential(tx, input.organizationId, credentialType, payload, { expiresAt: keptExpiry });

    // Audit record (without secret contents). It is written in the same transaction, so a save is never unaudited.
    await tx`
      insert into audit_log (
        id, organization_id, actor_id, action, object_type, object_id, metadata
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.actorId},
        ${`provider_config.update`}, ${input.category}, ${credentialType},
        ${JSON.stringify({ updatedKeys: Object.keys(input.settings || {}), hasApiKey: Boolean(newKey), keptStoredKey: Boolean(!newKey && keptKey) })}
      )
    `;
  });
}

function toDate(value: unknown): Date | undefined {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * Removes workspace-level credential for a category, reverting to deployment/default. The removal and its audit record
 * run in one transaction. A keyed category removes only its own entry.
 */
export async function removeWorkspaceProviderConfig(
  sql: Sql,
  input: {
    organizationId: string;
    actorId: string;
    category: ProviderCategory;
  }
): Promise<{ success: boolean }> {
  if (!isProviderCategory(input.category)) {
    throw new Error(`Unknown provider category: ${String(input.category)}.`);
  }
  const credentialType = vaultTypeForCategory(input.category);

  await withTransaction(sql, async (tx) => {
    const existing = await tx<{ id: string }>`
      select id from credential_vault
      where organization_id = ${input.organizationId} and credential_type = ${credentialType}
      limit 1
    `;
    if (existing[0]) await deleteVaultCredential(tx, input.organizationId, existing[0].id);

    await tx`
      insert into audit_log (
        id, organization_id, actor_id, action, object_type, object_id, metadata
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.actorId},
        ${`provider_config.remove`}, ${input.category}, ${credentialType}, '{}'
      )
    `;
  });

  return { success: true };
}

/**
 * Sources has no required key. Public page sources run without one. Meta Ad Library needs a token, and this check looks only
 * at the workspace's own saved token. READY means that token is saved and readable. It never means the live Meta Ad Library
 * answered, because no request is made here. The deployment key is read only when its shared default is opted in.
 */
async function testSourcesConnection(
  sql: Sql,
  organizationId: string,
  started: number,
): Promise<{ status: "READY" | "ERROR" | "NOT_CONFIGURED"; message: string; latencyMs: number }> {
  const latencyMs = () => Date.now() - started;
  const live = "The live Meta Ad Library was not called by this check.";
  const resolution = await resolveCredential(sql, organizationId, "meta_ad_library");
  if (resolution.status === "ready") {
    const owner = resolution.source === "workspace" ? "This workspace's saved" : "The deployment's shared";
    return { status: "READY", message: `${owner} Meta Ad Library key can be read. ${live}`, latencyMs: latencyMs() };
  }
  return {
    status: resolution.status === "unusable" ? "ERROR" : "NOT_CONFIGURED",
    message: `${resolution.reason} Public page sources need no key. ${live}`,
    latencyMs: latencyMs(),
  };
}

/**
 * Tests connection for a specific provider category with SSRF protection and live health checks.
 *
 * READY is reported only for a usable credential, by the same resolver the runtime uses. The keyed categories do not call
 * their live provider here, and the message says so. Sources reports READY only for a saved token that can be read.
 */
export async function testWorkspaceProviderConnection(
  sql: Sql,
  input: {
    organizationId: string;
    category: ProviderCategory;
  }
): Promise<{ status: "READY" | "ERROR" | "NOT_CONFIGURED"; message: string; latencyMs: number }> {
  const started = Date.now();

  try {
    if (isKeyedCategory(input.category)) {
      const state = input.category === "perception"
        ? await perceptionStateFor(sql, input.organizationId)
        : await credentialStateFor(sql, input.organizationId, input.category);
      const latencyMs = Date.now() - started;
      if (state.state === "usable") {
        const source = state.source === "workspace" ? "this workspace's saved key" : "the deployment's shared default key";
        const extra = input.category === "jev" ? " OpenRouter is deployment-only and was not checked." : "";
        return {
          status: "READY",
          message: `${KEY_LABEL[input.category]} credential is usable (${source}). The live provider was not called by this check.${extra}`,
          latencyMs,
        };
      }
      return { status: "ERROR", message: state.reason ?? "No credential is available for this workspace.", latencyMs };
    }

    if (input.category === "storage") {
      const drive = getGoogleDriveAuthStatus();
      const latencyMs = Date.now() - started;
      return {
        status: drive.configured ? "READY" : "ERROR",
        message: drive.configured ? "Google Drive OAuth client is configured." : "Google Drive is NOT_CONFIGURED.",
        latencyMs,
      };
    }

    if (input.category === "cyclone") {
      const credType = vaultTypeForCategory("cyclone");
      const rows = await sql<{ id: string }>`select id from credential_vault where organization_id = ${input.organizationId} and credential_type = ${credType} limit 1`;
      let gatewayUrl = process.env.CYCLONE_GATEWAY_URL || "http://127.0.0.1:4000";
      if (rows[0]) {
        const creds = await retrieveVaultCredential(sql, input.organizationId, rows[0].id);
        if (creds?.customFields?.gatewayUrl) gatewayUrl = String(creds.customFields.gatewayUrl);
      }

      const res = await fetch(`${gatewayUrl}/v1/device/status`, { signal: AbortSignal.timeout(3000) });
      const latencyMs = Date.now() - started;
      if (res.ok) {
        return { status: "READY", message: "Cyclone device gateway responded successfully.", latencyMs };
      }
      return { status: "ERROR", message: `Cyclone gateway returned HTTP ${res.status}.`, latencyMs };
    }

    if (input.category === "sources") {
      return testSourcesConnection(sql, input.organizationId, started);
    }

    // No category reaches here without a check above. An unknown category is an error, never a READY.
    return { status: "ERROR", message: `Unknown provider category: ${String(input.category)}.`, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      status: "ERROR",
      message: err instanceof Error ? err.message : "Provider connection test failed.",
      latencyMs: Date.now() - started,
    };
  }
}
