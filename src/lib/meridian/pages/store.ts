/**
 * Theme pages, SQL part (NORTH_STAR section 8, item B3). Every query is filtered by the organization and the brand the caller was checked
 * against (brand-membership.ts), and every write leaves an audit row with the page's name, platform and status.
 *
 * Kit ids are checked against engine_kits (0077) and the linked account against platform_accounts (0021) on every save. A kit or an
 * account that is not in this brand is refused, so a page never points at another workspace's object.
 */
import type { Sql } from "../learning/store.ts";
import type { TrialRequest } from "../distribution/trial.ts";
import {
  pageFieldsProblem,
  storedPostingTimes,
  trialChoiceFor,
  type PagePlatform,
  type PageStatus,
  type PostingTimes,
  type ThemePageFields,
} from "./model.ts";

export type PageScope = { organizationId: string; brandId: string };

/** A page as the screen and a run read it. The linked account's name and status come from platform_accounts, or are null. */
export type ThemePageView = ThemePageFields & {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
  platformAccount: { id: string; name: string; status: string } | null;
};

type PageRow = {
  id: string;
  name: string;
  niche: string | null;
  platform: string;
  platform_account_id: string | null;
  persona_kit_id: string | null;
  voice_kit_id: string | null;
  style_kit_id: string | null;
  posting_time_zone: string | null;
  posting_times: unknown;
  trial_first: boolean;
  trial_graduation: string | null;
  status: string;
  created_at: unknown;
  updated_at: unknown;
  account_name: string | null;
  account_status: string | null;
};

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

function toView(row: PageRow): ThemePageView {
  return {
    id: row.id,
    name: row.name,
    niche: row.niche,
    platform: row.platform as PagePlatform,
    platformAccountId: row.platform_account_id,
    personaKitId: row.persona_kit_id,
    voiceKitId: row.voice_kit_id,
    styleKitId: row.style_kit_id,
    postingTimeZone: row.posting_time_zone,
    postingTimes: storedPostingTimes(row.posting_times),
    trialFirst: row.trial_first === true,
    trialGraduation: row.trial_graduation === "MANUAL" || row.trial_graduation === "SS_PERFORMANCE" ? row.trial_graduation : null,
    status: row.status as PageStatus,
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
    platformAccount: row.platform_account_id && row.account_name !== null
      ? { id: row.platform_account_id, name: row.account_name, status: row.account_status ?? "" }
      : null,
  };
}

/** The pages of a brand that are not archived, oldest first. */
export async function listThemePages(sql: Sql, scope: PageScope): Promise<ThemePageView[]> {
  const rows = await sql<PageRow>`
    select p.id, p.name, p.niche, p.platform, p.platform_account_id, p.persona_kit_id, p.voice_kit_id, p.style_kit_id,
      p.posting_time_zone, p.posting_times, p.trial_first, p.trial_graduation, p.status, p.created_at, p.updated_at,
      a.name as account_name, a.status as account_status
    from theme_pages p
    left join platform_accounts a on a.id = p.platform_account_id and a.organization_id = p.organization_id
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId} and p.status <> 'archived'
    order by p.created_at asc, p.id asc
  `;
  return rows.map(toView);
}

/** One page of this brand, archived or not, or null when it is not a page of this brand. */
export async function getThemePage(sql: Sql, scope: PageScope, pageId: string): Promise<ThemePageView | null> {
  const rows = await sql<PageRow>`
    select p.id, p.name, p.niche, p.platform, p.platform_account_id, p.persona_kit_id, p.voice_kit_id, p.style_kit_id,
      p.posting_time_zone, p.posting_times, p.trial_first, p.trial_graduation, p.status, p.created_at, p.updated_at,
      a.name as account_name, a.status as account_status
    from theme_pages p
    left join platform_accounts a on a.id = p.platform_account_id and a.organization_id = p.organization_id
    where p.id = ${pageId} and p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId}
    limit 1
  `;
  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Why the page's links are not usable, in plain words, or null. The linked account must be an account of this brand on the page's platform.
 * Each kit must exist in this workspace with its kind. A kit or account that is not there is refused, not kept.
 */
async function referenceProblem(sql: Sql, scope: PageScope, fields: ThemePageFields): Promise<string | null> {
  if (fields.platformAccountId) {
    const rows = await sql<{ platform: string }>`
      select platform from platform_accounts
      where id = ${fields.platformAccountId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
      limit 1
    `;
    const account = rows[0];
    if (!account) return "The linked account is not an account of this brand.";
    if (account.platform !== fields.platform) {
      return `The linked account is a ${account.platform} account, and this page is ${fields.platform}.`;
    }
  }
  const kits: Array<{ kind: "persona" | "voice" | "style"; id: string | null; label: string }> = [
    { kind: "persona", id: fields.personaKitId, label: "persona" },
    { kind: "voice", id: fields.voiceKitId, label: "voice" },
    { kind: "style", id: fields.styleKitId, label: "style" },
  ];
  for (const kit of kits) {
    if (!kit.id) continue;
    const rows = await sql<{ kit_id: string }>`
      select kit_id from engine_kits
      where organization_id = ${scope.organizationId} and kind = ${kit.kind} and kit_id = ${kit.id}
      limit 1
    `;
    if (!rows[0]) return `The ${kit.label} kit ${kit.id} is not in this workspace.`;
  }
  return null;
}

async function audit(sql: Sql, scope: PageScope, actorId: string, action: string, pageId: string, fields: ThemePageFields): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${globalThis.crypto.randomUUID()}, ${scope.organizationId}, ${scope.brandId}, ${actorId}, ${action}, 'theme_page', ${pageId},
      ${JSON.stringify({ name: fields.name, platform: fields.platform, status: fields.status })}
    )
  `;
}

function schedule(times: PostingTimes | null): string | null {
  return times === null ? null : JSON.stringify(times);
}

/** Creates a page. The fields are checked by the caller's parser; the links and the cross-field rules are checked here. */
export async function createThemePage(sql: Sql, scope: PageScope, fields: ThemePageFields, actorId: string): Promise<string> {
  const problem = pageFieldsProblem(fields) ?? (await referenceProblem(sql, scope, fields));
  if (problem) throw new Error(problem);
  const id = globalThis.crypto.randomUUID();
  await sql`
    insert into theme_pages (
      id, organization_id, brand_id, name, niche, platform, platform_account_id, persona_kit_id, voice_kit_id, style_kit_id,
      posting_time_zone, posting_times, trial_first, trial_graduation, status
    ) values (
      ${id}, ${scope.organizationId}, ${scope.brandId}, ${fields.name}, ${fields.niche}, ${fields.platform},
      ${fields.platformAccountId}, ${fields.personaKitId}, ${fields.voiceKitId}, ${fields.styleKitId},
      ${fields.postingTimeZone}, ${schedule(fields.postingTimes)}, ${fields.trialFirst}, ${fields.trialGraduation}, ${fields.status}
    )
  `;
  await audit(sql, scope, actorId, "theme_page.created", id, fields);
  return id;
}

/**
 * Updates a page. The patch holds only the fields that changed, and the page is checked as a whole after the patch is applied, so a
 * change that breaks a rule (a schedule with no zone, say) is refused and nothing is written.
 */
export async function updateThemePage(
  sql: Sql,
  scope: PageScope,
  pageId: string,
  patch: Partial<ThemePageFields>,
  actorId: string,
): Promise<void> {
  const current = await getThemePage(sql, scope, pageId);
  if (!current) throw new Error("That page is not available for this brand.");
  if (current.status === "archived") throw new Error("An archived page cannot be edited.");
  const next: ThemePageFields = {
    name: patch.name ?? current.name,
    niche: patch.niche !== undefined ? patch.niche : current.niche,
    platform: patch.platform ?? current.platform,
    platformAccountId: patch.platformAccountId !== undefined ? patch.platformAccountId : current.platformAccountId,
    personaKitId: patch.personaKitId !== undefined ? patch.personaKitId : current.personaKitId,
    voiceKitId: patch.voiceKitId !== undefined ? patch.voiceKitId : current.voiceKitId,
    styleKitId: patch.styleKitId !== undefined ? patch.styleKitId : current.styleKitId,
    postingTimeZone: patch.postingTimeZone !== undefined ? patch.postingTimeZone : current.postingTimeZone,
    postingTimes: patch.postingTimes !== undefined ? patch.postingTimes : current.postingTimes,
    trialFirst: patch.trialFirst ?? current.trialFirst,
    trialGraduation: patch.trialGraduation !== undefined ? patch.trialGraduation : current.trialGraduation,
    status: patch.status ?? current.status,
  };
  const problem = pageFieldsProblem(next) ?? (await referenceProblem(sql, scope, next));
  if (problem) throw new Error(problem);
  await sql`
    update theme_pages set
      name = ${next.name}, niche = ${next.niche}, platform = ${next.platform}, platform_account_id = ${next.platformAccountId},
      persona_kit_id = ${next.personaKitId}, voice_kit_id = ${next.voiceKitId}, style_kit_id = ${next.styleKitId},
      posting_time_zone = ${next.postingTimeZone}, posting_times = ${schedule(next.postingTimes)},
      trial_first = ${next.trialFirst}, trial_graduation = ${next.trialGraduation}, status = ${next.status}, updated_at = now()
    where id = ${pageId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
  await audit(sql, scope, actorId, "theme_page.updated", pageId, next);
}

/** Archives a page. An archived page is not listed and cannot be run, and its past runs keep the link they were started with. */
export async function archiveThemePage(sql: Sql, scope: PageScope, pageId: string, actorId: string): Promise<void> {
  const current = await getThemePage(sql, scope, pageId);
  if (!current) throw new Error("That page is not available for this brand.");
  if (current.status === "archived") return;
  await sql`
    update theme_pages set status = 'archived', updated_at = now()
    where id = ${pageId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
  await audit(sql, scope, actorId, "theme_page.archived", pageId, { ...current, status: "archived" });
}

/**
 * Why a run cannot use this page, or null when it can. Only an active page of this brand is usable. The run's start calls this, so a
 * page that was paused or archived after it was chosen does not start a run.
 */
export async function runPageProblem(sql: Sql, scope: PageScope, pageId: string): Promise<string | null> {
  const page = await getThemePage(sql, scope, pageId);
  if (!page) return "The page for this run is not a page of this brand.";
  if (page.status !== "active") return `The page for this run is ${page.status}. Make it active, or choose another page.`;
  return null;
}

/**
 * The trial a run's organic posts start with: the page's default, or null. A run with no page, or a page that is gone or archived, has no
 * trial default, and its posts are ordinary publishes. Nothing is guessed in its place.
 */
export async function trialDefaultForRunPage(sql: Sql, scope: PageScope, pageId: string | null): Promise<TrialRequest | null> {
  if (!pageId) return null;
  const page = await getThemePage(sql, scope, pageId);
  if (!page || page.status === "archived") return null;
  return trialChoiceFor(page);
}
