/**
 * Provider cards for the Generate step. Pure. A card is enabled only when the stored state says it can run. A card whose
 * connection the screen cannot check says so, and it is not shown as connected.
 *
 * Sources: the production credential state and the Hypit configuration come from getProviderSettings; the image test
 * option is offered only when the server says the test runtime is active.
 */

export const IMAGE_PROVIDER_VALUES = ["none", "test:image", "google:nano-banana"] as const;
export type ImageProviderValue = (typeof IMAGE_PROVIDER_VALUES)[number];

export const VIDEO_PROVIDER_VALUES = ["hypit", "none", "auto", "manual_cloud", "higgsfield", "google_omni"] as const;
export type VideoProviderValue = (typeof VIDEO_PROVIDER_VALUES)[number];

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

function credentialGate(production: ProductionStatus): Pick<ProviderCard<string>, "connection" | "disabled" | "disabledReason"> {
  if (production.status === "loading") {
    return { connection: { kind: "checking", text: "Checking the connection…" }, disabled: true, disabledReason: "The connection is still being checked." };
  }
  if (production.status === "unavailable") {
    return {
      connection: { kind: "unknown", text: "Connection could not be read" },
      disabled: true,
      disabledReason: "The connection could not be read, so it is not treated as connected. Reload the page to try again.",
    };
  }
  if (production.credential === "usable") {
    return { connection: { kind: "connected", text: CONNECTED_TEXT }, disabled: false, disabledReason: null };
  }
  return {
    connection: { kind: "not_connected", text: "Not connected" },
    disabled: true,
    disabledReason: production.credentialReason || NO_KEY_REASON,
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
      label: "Test image",
      description: "A fixture from the test runtime. It is labelled as a test, not a photograph.",
      connection: { kind: "available", text: "Available in the test runtime." },
      disabled: false,
      disabledReason: null,
    });
  }
  cards.push({
    value: "google:nano-banana",
    label: "Google Nano Banana",
    description: "Google AI Studio image model. It uses the workspace production key.",
    ...credentialGate(input.production),
  });
  return cards;
}

export function videoProviderCards(input: { production: ProductionStatus }): ProviderCard<VideoProviderValue>[] {
  const hypit: ProviderCard<VideoProviderValue> = {
    value: "hypit",
    label: "Hypit video",
    description: "A separate Hypit process. A clip is stored only after Hypit returns verified MP4 bytes.",
    connection: { kind: "checking", text: "Checking the connection…" },
    disabled: true,
    disabledReason: "The connection is still being checked.",
  };
  const production = input.production;
  if (production.status === "unavailable") {
    hypit.connection = { kind: "unknown", text: "Connection could not be read" };
    hypit.disabledReason = "The connection could not be read, so it is not treated as connected. Reload the page to try again.";
  } else if (production.status === "ready") {
    if (production.hypitConfigured) {
      hypit.connection = { kind: "configured", text: "Configured. Nothing is verified until Hypit stores a clip." };
      hypit.disabled = false;
      hypit.disabledReason = null;
    } else {
      hypit.connection = { kind: "not_connected", text: "Not connected" };
      hypit.disabledReason = "HYPIT_BASE_URL is not set, so no video can be requested.";
    }
  }

  const gate = credentialGate(production);
  return [
    hypit,
    {
      value: "none",
      label: "No video",
      description: "This run makes no video.",
      connection: { kind: "not_needed", text: "No video is generated." },
      disabled: false,
      disabledReason: null,
    },
    {
      value: "google_omni",
      label: "Google Gemini Omni",
      description: "Google video model. It runs off the device and reports back when finished.",
      ...gate,
    },
    {
      value: "higgsfield",
      label: "Higgsfield AI",
      description: "Higgsfield video engine.",
      connection: { kind: "not_checked", text: "This screen does not check Higgsfield. The run checks it when it starts." },
      disabled: false,
      disabledReason: null,
    },
    {
      value: "manual_cloud",
      label: "Manual Cloud (Google Drive)",
      description: "A person produces the clip elsewhere and it is handed over through Google Drive.",
      connection: { kind: "not_checked", text: "This screen does not check the Drive connection." },
      disabled: false,
      disabledReason: null,
    },
    {
      value: "auto",
      label: "Auto",
      description: "The server picks a healthy supported engine when the run starts.",
      connection: { kind: "not_checked", text: "The engine is chosen when the run starts." },
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
