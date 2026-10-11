/**
 * Provider cards for the Generate step. Pure. A card is enabled only when the stored state says it can run. A card whose
 * connection the screen cannot check says so, and it is not shown as connected.
 *
 * The video engines are the ones Meridian can run: Gemini Omni (the default), Hypit and a manual cloud hand-over, plus
 * "No video". Any other engine is not offered here.
 *
 * Sources: the production credential state and the Hypit configuration come from getProviderSettings; the image test
 * option is offered only when the server says the test runtime is active.
 */

import { providerLabel } from "../../lib/copy.ts";

export const IMAGE_PROVIDER_VALUES = ["none", "test:image", "google:nano-banana"] as const;
export type ImageProviderValue = (typeof IMAGE_PROVIDER_VALUES)[number];

export const VIDEO_PROVIDER_VALUES = ["google_omni", "hypit", "manual_cloud", "none"] as const;
export type VideoProviderValue = (typeof VIDEO_PROVIDER_VALUES)[number];

/** The engine a video run uses when the person has not chosen one. The server reads "auto" as this same engine. */
export const DEFAULT_VIDEO_PROVIDER: VideoProviderValue = "google_omni";

export function isImageProviderValue(value: string): value is ImageProviderValue {
  return (IMAGE_PROVIDER_VALUES as readonly string[]).includes(value);
}

export function isVideoProviderValue(value: string): value is VideoProviderValue {
  return (VIDEO_PROVIDER_VALUES as readonly string[]).includes(value);
}

/** The production category as the screen reads it. "unavailable" means the read failed, which is not a connection. */
export type ProductionStatus =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      credential: "usable" | "unusable" | "not_configured";
      credentialReason: string | null;
      hypitConfigured: boolean;
    };

export type ConnectionKind =
  | "connected"
  | "configured"
  | "available"
  | "not_connected"
  | "checking"
  | "unknown"
  | "not_checked"
  | "not_needed";

export type ConnectionState = { kind: ConnectionKind; text: string };

export type ProviderCard<Value extends string> = {
  value: Value;
  label: string;
  description: string;
  connection: ConnectionState;
  disabled: boolean;
  disabledReason: string | null;
};

const CONNECTED_TEXT = "Saved workspace key is usable. It is checked again when a run starts.";
const NO_KEY_REASON = "No usable Google key is saved for this workspace. Save one in Settings, then return here.";
const CHECKING_REASON = "The connection is still being checked.";
const UNREADABLE_REASON = "The connection could not be read, so it is not treated as connected. Reload the page to try again.";
const HYPIT_NOT_SET_REASON = "This server has no Hypit address set (HYPIT_BASE_URL), so Meridian cannot send Hypit a job. Set it up in Integrations, then reload.";

/** A Google-key provider. The reason names the provider, so the card says which connection is missing and why. */
function credentialGate(production: ProductionStatus, label: string): Pick<ProviderCard<string>, "connection" | "disabled" | "disabledReason"> {
  if (production.status === "loading") {
    return { connection: { kind: "checking", text: "Checking the connection…" }, disabled: true, disabledReason: CHECKING_REASON };
  }
  if (production.status === "unavailable") {
    return { connection: { kind: "unknown", text: "Connection could not be read" }, disabled: true, disabledReason: UNREADABLE_REASON };
  }
  if (production.credential === "usable") {
    return { connection: { kind: "connected", text: CONNECTED_TEXT }, disabled: false, disabledReason: null };
  }
  return {
    connection: { kind: "not_connected", text: "Not connected" },
    disabled: true,
    disabledReason: `${label} is not connected. ${production.credentialReason || NO_KEY_REASON}`,
  };
}

export function imageProviderCards(input: { testImageAllowed: boolean; production: ProductionStatus }): ProviderCard<ImageProviderValue>[] {
  const cards: ProviderCard<ImageProviderValue>[] = [
    {
      value: "none",
      label: "No images",
      description: "This run makes no image. Video, if chosen, still runs.",
      connection: { kind: "not_needed", text: "No image is generated." },
      disabled: false,
      disabledReason: null,
    },
  ];
  if (input.testImageAllowed) {
    cards.push({
      value: "test:image",
      label: providerLabel("test:image"),
      description: "A fixture from the test runtime. It is labelled as a test, not a photograph.",
      connection: { kind: "available", text: "Available in the test runtime." },
      disabled: false,
      disabledReason: null,
    });
  }
  cards.push({
    value: "google:nano-banana",
    label: providerLabel("google:nano-banana"),
    description: "Google AI Studio image model. It uses the workspace production key.",
    ...credentialGate(input.production, providerLabel("google:nano-banana")),
  });
  return cards;
}

export function videoProviderCards(input: { production: ProductionStatus }): ProviderCard<VideoProviderValue>[] {
  const production = input.production;
  const hypit: ProviderCard<VideoProviderValue> = {
    value: "hypit",
    label: providerLabel("hypit"),
    description: "A separate Hypit process. A clip is stored only after Hypit returns verified MP4 bytes.",
    connection: { kind: "checking", text: "Checking the connection…" },
    disabled: true,
    disabledReason: CHECKING_REASON,
  };
  if (production.status === "unavailable") {
    hypit.connection = { kind: "unknown", text: "Connection could not be read" };
    hypit.disabledReason = UNREADABLE_REASON;
  } else if (production.status === "ready") {
    if (production.hypitConfigured) {
      hypit.connection = { kind: "configured", text: "Configured. Nothing is verified until Hypit stores a clip." };
      hypit.disabled = false;
      hypit.disabledReason = null;
    } else {
      hypit.connection = { kind: "not_connected", text: "Not connected" };
      hypit.disabledReason = `Hypit is not connected. ${HYPIT_NOT_SET_REASON}`;
    }
  }

  const omni: ProviderCard<VideoProviderValue> = {
    value: "google_omni",
    label: "Google Gemini Omni",
    description: "Google video model and the default engine. It runs off the device and reports back when finished.",
    ...credentialGate(production, "Gemini Omni"),
  };

  return [
    omni,
    hypit,
    {
      value: "manual_cloud",
      label: "Manual Cloud (Google Drive)",
      description: "A person produces the clip elsewhere and it is handed over through Google Drive.",
      connection: { kind: "not_checked", text: "This screen does not check the Drive connection." },
      disabled: false,
      disabledReason: null,
    },
    {
      value: "none",
      label: "No video",
      description: "This run makes no video.",
      connection: { kind: "not_needed", text: "No video is generated." },
      disabled: false,
      disabledReason: null,
    },
  ];
}

/** The part of the provider settings read that the Generate step needs. The settings call returns more; only these are read. */
export type ProviderSettingsSnapshot = {
  production?: {
    configured: boolean;
    credentialState?: "usable" | "unusable" | "not_configured";
    credentialReason?: string;
    settings?: Record<string, unknown>;
  };
};

/** The production status as the Generate step reads it. A failed read or a missing workspace is "unavailable", never a connection. */
export function productionStatusFrom(input: { organizationId: string; data: ProviderSettingsSnapshot | undefined; isError: boolean }): ProductionStatus {
  if (!input.organizationId || input.isError) return { status: "unavailable" };
  if (!input.data) return { status: "loading" };
  const production = input.data.production;
  if (!production) return { status: "unavailable" };
  return {
    status: "ready",
    credential: production.credentialState ?? (production.configured ? "usable" : "not_configured"),
    credentialReason: production.credentialReason ?? null,
    hypitConfigured: Boolean(production.settings?.hypitConfigured),
  };
}
