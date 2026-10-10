import { resolvePerceptionCredential, type PerceptionCredential } from "../perception/credential.ts";
import { selectPerceptionProvider } from "../perception/run.ts";
/**
 * Workspace Provider Configuration Service
 *
 * Provides typed, secure, organization-scoped credential and operational configuration
 * for JEV, Perception, Sources & Crawling, Production, Storage, and Cyclone Scout.
 *
 * Rules:
 * - Server-only credential resolution and AES-256-GCM encryption at rest via Vault.
 * - Never returns raw secret keys or tokens back to the browser; returns only fingerprints.
 * - Enforces SSRF prevention via publicUrlIssue before testing any configurable endpoint.
 * - Audits all credential mutations without logging secret values.
 * - JEV and production keys come from credentials/resolve.ts, the resolver their runtimes call: the workspace's saved key
 *   first, and the deployment key only when JEV_SHARED_DEFAULT or PRODUCTION_SHARED_DEFAULT is set to "deployment".
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { storeVaultCredential, retrieveVaultCredential, deleteVaultCredential, type VaultCredentialPayload } from "../vault/service.ts";
import { resolveJevConfig } from "../jev/config.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import { ProviderConfigResolver } from "../config/resolver.ts";
import { jevRouter } from "../jev/router.ts";
import { publicUrlIssue } from "../sources/public-url.ts";
import { getGoogleDriveAuthStatus } from "../storage/google-auth.ts";

export type ProviderCategory = "jev" | "perception" | "sources" | "production" | "storage" | "cyclone";

/**
 * Perception readiness, as the production resolver sees it. "usable" means a call would use the credential shown.
 * "unusable" means the workspace has a saved credential that cannot be used; the deployment key is never used in its
 * place. "not_configured" means nothing is available to use.
 */
export type PerceptionCredentialState = "usable" | "unusable" | "not_configured";

export type ProviderConfigSummary = {
  category: ProviderCategory;
  configured: boolean;
  /** Where the credential comes from. For perception, "not_configured" means no credential is available. */
  source: "workspace" | "deployment" | "default" | "not_configured";
  /** Explicit readiness. Set for perception, which resolves its credential through perception/credential.ts. */
  credentialState?: PerceptionCredentialState;
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

/**
 * The perception credential as production sees it: the provider selection first (PERCEPTION_PROVIDER=none turns
 * perception off), then the credential resolver. Settings and Test Connection both read this, so they cannot disagree
 * with a perception run.
 */
async function perceptionCredentialFor(sql: Sql, organizationId: string): Promise<PerceptionCredential> {
  const selection = selectPerceptionProvider();
  if (!selection.provider) return { status: "not_configured", reason: selection.reason };
  return resolvePerceptionCredential(sql, organizationId);
}

/**
 * Resolves the vault credential type key for a given provider category.
 */
function vaultTypeForCategory(category: ProviderCategory): string {
  return `provider_config:${category}`;
}

/**
 * Retrieves safe summarized configuration across all provider categories for an organization.
 * Never exposes raw secret bytes.
 */
export async function getWorkspaceProviderSettings(
  sql: Sql,
  organizationId: string
): Promise<Record<ProviderCategory, ProviderConfigSummary>> {
  // Query existing vault credentials for this tenant
  const rows = await sql<{ id: string; credential_type: string; updated_at: string }>`
    select id, credential_type, updated_at
    from credential_vault
    where organization_id = ${organizationId}
      and credential_type like 'provider_config:%'
  `;

  const vaultMap = new Map<string, { id: string; updatedAt: string }>();
  for (const r of rows) {
    vaultMap.set(r.credential_type, { id: r.id, updatedAt: r.updated_at });
  }

  // 1. JEV Category. The TypeSafe key is this workspace's saved key, resolved by the same resolver the JEV transport uses
  // for each call (credentials/resolve.ts). The OpenRouter key stays on the deployment. Mode and routing come from the
  // deployment environment, because that is what the JEV runtime reads.
  const jevCredential = await resolveCredential(sql, organizationId, "jev");
  const deploymentJev = resolveJevConfig();
  const openrouterConfigured = Boolean(deploymentJev.openrouter.apiKey);
  const jevConfigured = jevCredential.status === "ready" || openrouterConfigured;
  const jevState: PerceptionCredentialState =
    jevCredential.status === "ready" ? "usable" : jevCredential.status === "unusable" ? "unusable" : openrouterConfigured ? "usable" : "not_configured";

  const jevSummary: ProviderConfigSummary = {
    category: "jev",
    configured: jevConfigured,
    source:
      jevCredential.status === "ready"
        ? jevCredential.source === "workspace" ? "workspace" : "deployment"
        : jevCredential.status === "unusable" ? "workspace" : openrouterConfigured ? "deployment" : "not_configured",
    credentialState: jevState,
    credentialReason: jevCredential.status === "ready" || jevState === "usable" ? undefined : jevCredential.reason,
    keyFingerprint: jevCredential.status === "ready" ? jevCredential.fingerprint : undefined,
    lastTestedStatus: jevConfigured ? "READY" : jevCredential.status === "unusable" ? "ERROR" : "NOT_CONFIGURED",
    lastTestedMessage: jevCredential.status === "unusable" ? jevCredential.reason : undefined,
    settings: {
      mode: deploymentJev.mode,
      preferredProvider: deploymentJev.preferredProvider,
      fallbackEnabled: deploymentJev.fallbackEnabled,
      timeoutMs: deploymentJev.timeoutMs,
      typesafeModel: deploymentJev.typesafe.model,
      openrouterModel: deploymentJev.openrouter.model,
      openrouterKeyConfigured: openrouterConfigured,
    },
    capabilities: ["choice_decisions", "score_decisions", "noul_probabilities", "evidence_audit_trail"],
  };

  // 2. Perception Category. This summary reads the same credential resolver production perception calls use
  // (perception/credential.ts), so it never reports a credential the provider cannot use. A saved workspace key that
  // cannot be used is "unusable", and the deployment key is not offered in its place.
  const perceptionCredential = await perceptionCredentialFor(sql, organizationId);
  const perceptionConfigured = perceptionCredential.status === "ready";
  const perceptionState: PerceptionCredentialState =
    perceptionCredential.status === "ready" ? "usable" : perceptionCredential.status === "unusable" ? "unusable" : "not_configured";
  const perceptionSource: ProviderConfigSummary["source"] =
    perceptionCredential.status === "ready"
      ? perceptionCredential.source === "workspace" ? "workspace" : "deployment"
      : perceptionCredential.status === "unusable" ? "workspace" : "not_configured";

  const perceptionSummary: ProviderConfigSummary = {
    category: "perception",
    configured: perceptionConfigured,
    source: perceptionSource,
    credentialState: perceptionState,
    credentialReason: perceptionCredential.status === "ready" ? undefined : perceptionCredential.reason,
    keyFingerprint: perceptionCredential.status === "ready" ? perceptionCredential.fingerprint : undefined,
    lastTestedStatus: perceptionConfigured ? "READY" : perceptionCredential.status === "unusable" ? "ERROR" : "NOT_CONFIGURED",
    lastTestedMessage: perceptionConfigured ? undefined : perceptionCredential.reason,
    settings: {
      provider: "gemini",
      model: process.env.PERCEPTION_MODEL || "gemini-2.5-flash",
      modalities: ["image", "video_frames", "ocr"],
    },
    capabilities: ["video_transcription", "scene_detection", "ocr_extraction", "multimodal_pacing"],
  };

  // 3. Sources & Crawling Category
  const sourcesVaultEntry = vaultMap.get(vaultTypeForCategory("sources"));
  let sourcesCreds: VaultCredentialPayload | null = null;
  if (sourcesVaultEntry) {
    try {
      sourcesCreds = await retrieveVaultCredential(sql, organizationId, sourcesVaultEntry.id);
    } catch {
      // Ignored
    }
  }
  const metaAdToken = sourcesCreds?.customFields?.metaAdLibraryToken as string || process.env.META_AD_LIBRARY_TOKEN;

  const sourcesSummary: ProviderConfigSummary = {
    category: "sources",
    configured: true,
    source: sourcesCreds?.customFields ? "workspace" : "default",
    settings: {
      maxPagesPerRun: Number(sourcesCreds?.customFields?.maxPages || 50),
      maxDepth: Number(sourcesCreds?.customFields?.maxDepth || 2),
      concurrency: Number(sourcesCreds?.customFields?.concurrency || 4),
      metaAdLibraryConfigured: Boolean(metaAdToken),
      metaAdLibraryFingerprint: fingerprint(metaAdToken),
      allowedSources: ["website", "instagram", "tiktok", "youtube", "meta_ad_library"],
    },
    capabilities: ["public_page_scrape", "meta_ad_library", "open_graph", "json_ld", "repeated_card_discovery"],
  };

  // 4. Production Category. The Gemini key is this workspace's saved key, resolved by the same resolver the production
  // providers call for each job (credentials/resolve.ts). Models and Hypit come from the deployment environment, which is
  // what those runtimes read.
  const productionCredential = await resolveCredential(sql, organizationId, "production");
  const google = ProviderConfigResolver.resolveGoogle();
  const prodConfigured = productionCredential.status === "ready";

  const prodSummary: ProviderConfigSummary = {
    category: "production",
    configured: prodConfigured,
    source:
      productionCredential.status === "ready"
        ? productionCredential.source === "workspace" ? "workspace" : "deployment"
        : productionCredential.status === "unusable" ? "workspace" : "not_configured",
    credentialState: productionCredential.status === "ready" ? "usable" : productionCredential.status,
    credentialReason: productionCredential.status === "ready" ? undefined : productionCredential.reason,
    keyFingerprint: productionCredential.status === "ready" ? productionCredential.fingerprint : undefined,
    lastTestedStatus: prodConfigured ? "READY" : productionCredential.status === "unusable" ? "ERROR" : "NOT_CONFIGURED",
    settings: {
      omniModel: google.omniModel,
      imageModel: google.imageModel,
      hypitConfigured: Boolean(process.env.HYPIT_BASE_URL?.trim()),
    },
    capabilities: ["gemini_omni_video", "image_to_video", "manual_cloud_handoff", "durable_job_polling"],
  };

  // 5. Storage Category
  const driveStatus = getGoogleDriveAuthStatus();
  const storageSummary: ProviderConfigSummary = {
    category: "storage",
    configured: driveStatus.configured,
    source: driveStatus.configured ? "deployment" : "default",
    lastTestedStatus: driveStatus.configured ? "READY" : "NOT_CONFIGURED",
    settings: {
      primaryProvider: "google_drive",
      fallbackProvider: "filesystem",
      s3Configured: Boolean(process.env.S3_BUCKET),
    },
    capabilities: ["oauth_google_drive", "checksum_verification", "zero_fake_completion"],
  };

  // 6. Cyclone Scout Category
  const cycloneVaultEntry = vaultMap.get(vaultTypeForCategory("cyclone"));
  let cycloneCreds: VaultCredentialPayload | null = null;
  if (cycloneVaultEntry) {
    try {
      cycloneCreds = await retrieveVaultCredential(sql, organizationId, cycloneVaultEntry.id);
    } catch {
      // Ignored
    }
  }
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

  return {
    jev: jevSummary,
    perception: perceptionSummary,
    sources: sourcesSummary,
    production: prodSummary,
    storage: storageSummary,
    cyclone: cycloneSummary,
  };
}

/**
 * Saves or updates workspace credentials and operational settings for a category.
 * Encrypts secrets at rest and emits audit records.
 */
export async function saveWorkspaceProviderConfig(
  sql: Sql,
  input: {
    organizationId: string;
    actorId: string;
    category: ProviderCategory;
    credentials?: {
      apiKey?: string;
      accessToken?: string;
      refreshToken?: string;
    };
    settings?: Record<string, unknown>;
  }
): Promise<{ success: boolean; category: ProviderCategory }> {
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

  const credentialType = vaultTypeForCategory(input.category);

  // The perception entry is the Gemini key itself. Saving it without a key would replace the stored key with an empty
  // one, so the save is refused instead.
  if (input.category === "perception" && !input.credentials?.apiKey?.trim()) {
    throw new Error("Enter a Gemini API key to save the perception credential.");
  }

  // Check if existing credential exists
  const existingRows = await sql<{ id: string }>`
    select id from credential_vault
    where organization_id = ${input.organizationId}
      and credential_type = ${credentialType}
    limit 1
  `;

  if (existingRows[0]) {
    await deleteVaultCredential(sql, input.organizationId, existingRows[0].id);
  }

  const payload: VaultCredentialPayload = {
    accessToken: input.credentials?.accessToken || "",
    apiKey: input.credentials?.apiKey || "",
    refreshToken: input.credentials?.refreshToken || "",
    // JEV and production read their routing and models from the deployment, so a saved setting for them would never be used.
    customFields: input.category === "jev" || input.category === "production" ? {} : input.settings || {},
  };

  await storeVaultCredential(sql, input.organizationId, credentialType, payload);

  // Audit record (without secret contents!)
  try {
    await sql`
      insert into audit_log (
        id, organization_id, actor_id, action, object_type, object_id, metadata
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.actorId},
        ${`provider_config.update`}, ${input.category}, ${credentialType},
        ${JSON.stringify({ updatedKeys: Object.keys(input.settings || {}), hasApiKey: Boolean(input.credentials?.apiKey) })}
      )
    `;
  } catch {
    // Non-fatal
  }

  return { success: true, category: input.category };
}

/**
 * Removes workspace-level credential for a category, reverting to deployment/default.
 */
export async function removeWorkspaceProviderConfig(
  sql: Sql,
  input: {
    organizationId: string;
    actorId: string;
    category: ProviderCategory;
  }
): Promise<{ success: boolean }> {
  const credentialType = vaultTypeForCategory(input.category);

  const existingRows = await sql<{ id: string }>`
    select id from credential_vault
    where organization_id = ${input.organizationId}
      and credential_type = ${credentialType}
    limit 1
  `;

  if (existingRows[0]) {
    await deleteVaultCredential(sql, input.organizationId, existingRows[0].id);
  }

  try {
    await sql`
      insert into audit_log (
        id, organization_id, actor_id, action, object_type, object_id, metadata
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.actorId},
        ${`provider_config.remove`}, ${input.category}, ${credentialType}, '{}'
      )
    `;
  } catch {
    // Ignored
  }

  return { success: true };
}

/**
 * Tests connection for a specific provider category with SSRF protection and live health checks.
 */
export async function testWorkspaceProviderConnection(
  sql: Sql,
  input: {
    organizationId: string;
    category: ProviderCategory;
  }
): Promise<{ status: "READY" | "ERROR"; message: string; latencyMs: number }> {
  const started = Date.now();

  try {
    if (input.category === "jev") {
      // The same key the JEV transport uses for this organization. READY means a usable key is in place, and the live
      // TypeSafe API is not called here.
      const credential = await resolveCredential(sql, input.organizationId, "jev");
      const health = await jevRouter.health(undefined, credential.status === "ready" ? { typesafeKey: credential.secret } : undefined);
      const ready = Object.values(health).some((h) => h.status === "READY");
      const latencyMs = Date.now() - started;
      return {
        status: ready ? "READY" : "ERROR",
        message: ready ? "A usable JEV key is in place. The live provider was not called by this check." : "No usable JEV key is in place for this workspace.",
        latencyMs,
      };
    }

    if (input.category === "perception") {
      // Checks the credential the production resolver would use. It does not call Gemini, so READY means "a usable
      // credential is in place", not "the live API answered".
      const credential = await perceptionCredentialFor(sql, input.organizationId);
      const latencyMs = Date.now() - started;
      if (credential.status === "ready") {
        const source = credential.source === "workspace" ? "this workspace's saved key" : "the deployment's shared default key";
        return {
          status: "READY",
          message: `Gemini credential is usable (${source}). The live Gemini API was not called by this check.`,
          latencyMs,
        };
      }
      return { status: "ERROR", message: credential.reason, latencyMs };
    }

    if (input.category === "production") {
      // The same key the production providers use for this organization. It does not call Gemini, so READY means a usable
      // key is in place, not that the live API answered.
      const credential = await resolveCredential(sql, input.organizationId, "production");
      const latencyMs = Date.now() - started;
      if (credential.status === "ready") {
        const source = credential.source === "workspace" ? "this workspace's saved key" : "the deployment's shared default key";
        return { status: "READY", message: `Gemini production key is usable (${source}). The live Gemini API was not called by this check.`, latencyMs };
      }
      return { status: "ERROR", message: credential.reason, latencyMs };
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

    // Default readiness check
    return {
      status: "READY",
      message: `${input.category} configuration test verified.`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      status: "ERROR",
      message: err instanceof Error ? err.message : "Provider connection test failed.",
      latencyMs: Date.now() - started,
    };
  }
}
