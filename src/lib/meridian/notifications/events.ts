export type NotificationDraft = {
  kind: "learning.update" | "performance.recorded" | "review.required" | "integration.unavailable";
  title: string;
  body: string;
};

export function notificationFor(kind: NotificationDraft["kind"], detail: string): NotificationDraft {
  if (kind === "learning.update") {
    return { kind, title: "Learning updated", body: detail || "Patterns were recomputed from stored performance." };
  }
  if (kind === "performance.recorded") {
    return { kind, title: "Performance stored", body: detail || "A manual performance row was stored. No ad account is connected." };
  }
  if (kind === "review.required") {
    return { kind, title: "Review required", body: detail || "A creative is waiting for a person." };
  }
  return { kind, title: "Integration unavailable", body: detail || "The requested provider is not connected." };
}
