const STATUS_LABELS: Record<string, string> = {
  not_connected: "Not connected",
  in_review: "Needs review",
  dead: "Dead letter",
  retrying: "Retrying",
  succeeded: "Succeeded",
  failed: "Failed",
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  connected: "Connected",
  disconnected: "Disconnected",
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  pending: "Pending",
  proposed: "Proposed",
  complete: "Complete",
  completed: "Complete",
};

const PROVIDER_LABELS: Record<string, string> = {
  meta: "Meta",
  tiktok: "TikTok",
  google: "Google Ads",
  ad_library: "Meta Ad Library",
  openrouter: "OpenRouter",
  nano_banana: "Google Nano Banana",
  hypit: "Hypit video",
  "test:image": "Test image",
  "test:video": "Test video fixture",
  "test:publisher": "Test publisher",
  "google:nano-banana": "Google Nano Banana",
};

export function statusLabel(status: string): string {
  const normalized = status.trim().toLowerCase().replaceAll("-", "_");
  if (STATUS_LABELS[normalized]) return STATUS_LABELS[normalized];
  return normalized.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase()) || "Unknown";
}

export function providerLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_LABELS[normalized] ?? normalized.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}
