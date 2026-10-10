/** Pure wording for the audit feed. Unknown actions fall back to their own words, so nothing is hidden or guessed. */
import type { AuditEntry } from "@/lib/meridian/workspace/actions";

export type ActivityLine = { actor: string; sentence: string; brandName: string | null };

export function describeAudit(entry: Pick<AuditEntry, "action" | "actorName" | "metadata" | "brandId">, brandName: string | null): ActivityLine {
  const meta = entry.metadata ?? {};
  const sentence = sentenceFor(entry.action, meta);
  return {
    actor: entry.actorName || "System",
    sentence,
    brandName: entry.brandId ? brandName : null,
  };
}

function sentenceFor(action: string, meta: Record<string, string>): string {
  switch (action) {
    case "organization.created": return meta.name ? `created the workspace ${meta.name}` : "created the workspace";
    case "organization.renamed": return meta.name ? `renamed the workspace to ${meta.name}` : "renamed the workspace";
    case "brand.created": return meta.name ? `created the brand ${meta.name}` : "created a brand";
    case "brand.updated": return "updated the brand details";
    case "brand.deleted": return "deleted a brand";
    case "brand_brain.updated": return "updated the brand brain";
    case "brand_brain.suggestion_accepted": return "accepted a brand brain suggestion";
    case "review.approved": return "approved a review";
    case "review.rejected": return "rejected a review";
    case "performance.recorded": return "recorded a performance result";
    case "performance.sync": return "synced provider performance";
    case "performance.sync_failed": return "provider performance sync failed";
    case "invite.created": return meta.email ? `invited ${meta.email} as ${meta.role ?? "a member"}` : "sent an invitation";
    case "invite.accepted": return "accepted a workspace invitation";
    case "member.added": return meta.email ? `added ${meta.email} as ${meta.role ?? "a member"}` : "added a member";
    case "member.role_changed": return meta.from && meta.to ? `changed a role from ${meta.from} to ${meta.to}` : "changed a member’s role";
    case "member.removed": return "removed a member";
    case "scoring.updated": return "changed the diagnostic weights";
    case "learning.scope_updated": return meta.useOrganizationLearning === "true" ? "turned on shared workspace patterns" : "turned off shared workspace patterns";
    case "learning.refreshed": return "refreshed learning";
    case "opportunities.refreshed": return "refreshed opportunities";
    case "competitor.added": return "added a competitor";
    case "creative.observed": return "recorded an observed creative";
    case "research.collection.queued": return "queued a research collection";
    case "asset.stored": return "stored an asset";
    case "product.deleted": return "deleted a product";
    case "integration.unavailable": return "an integration was unavailable";
    case "provider.failing": return "a provider started failing";
    default: return action.replaceAll(".", " · ").replaceAll("_", " ");
  }
}
