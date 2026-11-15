// Where a Claude Code video's idea can come from, read from what Meridian already holds. Nothing is invented: a source with nothing
// behind it says so, and the person is told what to do first. The text read here was gathered from outside (pages, ads, captions), so
// it is data: it is trimmed, kept as quoted lines, and never written as an instruction.

import type { Sql } from "../learning/store.ts";

export const REQUEST_SOURCES = ["gathered", "factory", "idea"] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];

export type SourceSnapshot = {
  /** The one-line idea the video starts from. */
  idea: string;
  /** What was read, as short labelled lines for the chat. Data, never instructions. */
  lines: string[];
  /** The Meridian rows it came from, so the chat can say what it used. */
  refs: Array<{ kind: string; id: string }>;
};

export type SourceResult = { ok: true; snapshot: SourceSnapshot } | { ok: false; reason: string };

const LINE_MAX = 280;
const clip = (value: unknown): string => {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  return text.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
};
const put = (lines: string[], label: string, value: unknown) => {
  const text = clip(value);
  if (text) lines.push(`${label}: ${text}`);
};

/**
 * The best open opportunity for the brand, from the data Meridian gathered (ranked by expected value), with the patterns the research
 * observed. Needs a brand: gathered data belongs to one.
 */
export async function gatheredSource(sql: Sql, organizationId: string, brandId: string | null): Promise<SourceResult> {
  if (!brandId) return { ok: false, reason: "Gathered data belongs to a brand. Pick a brand, or start from your own idea." };
  const rows = await sql<Record<string, unknown>>`
    select id, label, angle, hook_type, audience, format, proof_type, product_name, reason, evidence, evidence_basis, confidence
    from opportunities
    where organization_id = ${organizationId} and brand_id = ${brandId} and status in ('open', 'accepted', 'briefed')
    order by expected_value desc, created_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: "Nothing has been gathered for this brand yet. Run the Factory's research first, or start from your own idea." };
  const patterns = await sql<Record<string, unknown>>`
    select id, summary, state from research_patterns
    where organization_id = ${organizationId} and (brand_id = ${brandId} or (brand_id is null and scope = 'organization'))
    order by confidence desc, created_at desc
    limit 3
  `;
  const lines: string[] = [];
  put(lines, "Opportunity", row.label);
  put(lines, "Angle", row.angle);
  put(lines, "Hook type", row.hook_type);
  put(lines, "Audience", row.audience);
  put(lines, "Format", row.format);
  put(lines, "Proof", row.proof_type);
  put(lines, "Product", row.product_name);
  put(lines, "Why it ranks", row.reason);
  put(lines, "Evidence", row.evidence);
  put(lines, "Evidence basis", row.evidence_basis);
  for (const pattern of patterns) put(lines, `Pattern (${clip(pattern.state)})`, pattern.summary);
  return {
    ok: true,
    snapshot: {
      idea: clip(row.label) || clip(row.angle),
      lines,
      refs: [{ kind: "opportunity", id: String(row.id) }, ...patterns.map((pattern) => ({ kind: "research_pattern", id: String(pattern.id) }))],
    },
  };
}

/** The brand's latest Content Factory plan that is still live, with the brief it was made from. */
export async function factorySource(sql: Sql, organizationId: string, brandId: string | null): Promise<SourceResult> {
  if (!brandId) return { ok: false, reason: "A Content Factory plan belongs to a brand. Pick a brand, or start from your own idea." };
  const rows = await sql<Record<string, unknown>>`
    select p.id, p.objective, p.status, p.scope, b.id as brief_id, b.title, b.audience, b.angle, b.hook, b.message, b.offer, b.cta, b.format, b.proof_type, b.constraints
    from creative_plans p left join briefs b on b.id = p.brief_id
    where p.organization_id = ${organizationId} and p.brand_id = ${brandId} and p.status not in ('failed', 'cancelled', 'abstained')
    order by p.updated_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: "The Content Factory has no live plan for this brand. Make one there first, or start from your own idea." };
  const lines: string[] = [];
  put(lines, "Objective", row.objective);
  put(lines, "Plan status", row.status);
  put(lines, "Brief", row.title);
  put(lines, "Audience", row.audience);
  put(lines, "Angle", row.angle);
  put(lines, "Hook", row.hook);
  put(lines, "Message", row.message);
  put(lines, "Offer", row.offer);
  put(lines, "Call to action", row.cta);
  put(lines, "Format", row.format);
  put(lines, "Proof", row.proof_type);
  put(lines, "Constraints", row.constraints);
  return {
    ok: true,
    snapshot: {
      idea: clip(row.title) || clip(row.objective),
      lines,
      refs: [{ kind: "creative_plan", id: String(row.id) }, ...(row.brief_id ? [{ kind: "brief", id: String(row.brief_id) }] : [])],
    },
  };
}

/** How many of each source the brand has, so the page can say which are ready before anything is clicked. Unknown stays unknown. */
export async function sourceAvailability(sql: Sql, organizationId: string, brandId: string | null): Promise<{ gathered: boolean; factory: boolean }> {
  if (!brandId) return { gathered: false, factory: false };
  const [gathered, factory] = await Promise.all([gatheredSource(sql, organizationId, brandId), factorySource(sql, organizationId, brandId)]);
  return { gathered: gathered.ok, factory: factory.ok };
}
