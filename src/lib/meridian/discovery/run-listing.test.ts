/**
 * The Market screen's run list and source status. A brand sees only its own runs, each with the source states it recorded. A
 * keyed source is connected only when a key is saved for that workspace, and a workspace with no key sees the reason.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { openTestBackends, withEnv } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import type { Sql } from "../learning/store.ts";
import { saveWorkspaceProviderConfig } from "../settings/provider-config.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { SourceRegistry } from "../sources/registry.ts";
import { YouTubeSourceAdapter } from "../sources/adapters/youtube.ts";
import { discoverySourceStatuses } from "./planner.ts";
import { listDiscoveryRuns } from "./run-listing.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-run-listing";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

async function insertRun(sql: Sql, input: { id: string; organizationId: string; brandId: string; startedAt: string; progress: unknown; caveat?: string }) {
  await sql`
    insert into discovery_runs (id, organization_id, brand_id, scope, status, seeds, progress, started_at, completed_at)
    values (${input.id}, ${input.organizationId}, ${input.brandId}, 'niche', 'blocked', ${JSON.stringify(["mesh sponge"])},
            ${JSON.stringify({ ...(input.progress as object), caveat: input.caveat ?? null })}, ${input.startedAt}, ${input.startedAt})
  `;
}

for (const { name, sql } of backends) {
  test(`[${name}] the run list shows only this brand's runs, newest first, with each source's state and reason`, async () => {
    const mine = await studioTenant(sql, `runs-mine-${name}`);
    const theirs = await studioTenant(sql, `runs-theirs-${name}`);
    const older = `crawll_old_${randomUUID()}`;
    const newer = `crawll_new_${randomUUID()}`;
    await insertRun(sql, {
      id: older, organizationId: mine.organizationId, brandId: mine.brandId, startedAt: "2026-09-01T10:00:00Z",
      progress: { pagesCrawled: 0, discoveredCards: 0, discoveredUrls: 0, seenBefore: 0, sources: [] },
    });
    await insertRun(sql, {
      id: newer, organizationId: mine.organizationId, brandId: mine.brandId, startedAt: "2026-09-02T10:00:00Z",
      caveat: "No source ran, so this run has no results.",
      progress: {
        pagesCrawled: 0, discoveredCards: 0, discoveredUrls: 0, seenBefore: 0,
        sources: [
          { adapterId: "youtube", seed: "mesh sponge", status: "failed", reason: "YouTube is rate limited (HTTP 429). Try again later.", sourceStatus: "RATE_LIMITED" },
          { adapterId: "instagram", seed: "mesh sponge", status: "not_configured", reason: "No key is saved for this workspace." },
        ],
      },
    });
    await insertRun(sql, {
      id: `crawll_other_${randomUUID()}`, organizationId: theirs.organizationId, brandId: theirs.brandId, startedAt: "2026-09-03T10:00:00Z",
      progress: { pagesCrawled: 0, discoveredCards: 0, discoveredUrls: 0, sources: [] },
    });

    const runs = await listDiscoveryRuns(sql, { organizationId: mine.organizationId, brandId: mine.brandId });
    assert.deepEqual(runs.map((run) => run.id), [newer, older], "only this brand's runs, newest first");
    const [latest] = runs;
    assert.equal(latest.status, "blocked");
    assert.equal(latest.caveat, "No source ran, so this run has no results.");
    assert.deepEqual(latest.seeds, ["mesh sponge"]);
    assert.deepEqual(latest.sources.map((source) => [source.adapterId, source.status]), [["youtube", "failed"], ["instagram", "not_configured"]]);
    const youtube = latest.sources[0];
    assert.ok(youtube.status === "failed" && youtube.sourceStatus === "RATE_LIMITED", "the provider health is kept");
    assert.match(youtube.reason, /rate limited/);

    const wrongTenant = await listDiscoveryRuns(sql, { organizationId: theirs.organizationId, brandId: mine.brandId });
    assert.deepEqual(wrongTenant, [], "a brand is never read under another workspace");
  });
}

test("the source status is connected only where a key is saved for the workspace, and the reason is shown where it is not", async () => {
  await withEnv({ YOUTUBE_API_KEY: undefined, YOUTUBE_SHARED_DEFAULT: undefined }, () => checkSourceStatuses());
});

async function checkSourceStatuses(): Promise<void> {
  const sql = backends[0].sql;
  const keyed = await studioTenant(sql, "statuses-keyed");
  const bare = await studioTenant(sql, "statuses-bare");
  await saveWorkspaceProviderConfig(sql, {
    organizationId: keyed.organizationId,
    actorId: keyed.userId,
    category: "youtube",
    credentials: { apiKey: "status-youtube-key-1234" },
  });

  const registry = new SourceRegistry();
  registry.register(new YouTubeSourceAdapter({ fetch: async () => { throw new Error("no request in this test"); } }));

  const withKey = await discoverySourceStatuses(registry, keyed.organizationId);
  const youtubeWithKey = withKey.find((source) => source.adapterId === "youtube");
  assert.equal(youtubeWithKey?.connected, true);
  assert.equal(youtubeWithKey?.label, "YouTube");
  assert.equal(youtubeWithKey?.reason, "", "a connected source has no reason to show");

  const withoutKey = await discoverySourceStatuses(registry, bare.organizationId);
  const youtubeWithout = withoutKey.find((source) => source.adapterId === "youtube");
  assert.equal(youtubeWithout?.connected, false);
  assert.ok(youtubeWithout?.reason.length, "the resolver's reason is shown");
  assert.ok(withoutKey.every((source) => !source.connected), "no source is connected for a workspace with no key");
}
